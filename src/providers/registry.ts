import { bedrock, createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { azure, createAzure } from "@ai-sdk/azure";
import { createVertex, vertex } from "@ai-sdk/google-vertex";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter, type OpenRouterProviderOptions, openrouter } from "@openrouter/ai-sdk-provider";
import { APICallError, generateText as aiGenerateText, type JSONValue, type LanguageModel, RetryError } from "ai";
import { z } from "zod/v4";

import { type ChorusConfig, DEFAULT_PROVIDER_TIMEOUT_MS, hasUnresolvedEnvVar, wasExpandedFromEnv } from "@/config";
import { classifyInput, resolveRoute } from "@/providers/resolve-route";
import type { BrokerModelInfo, ModelsListResponse, ProviderId } from "@/types/providers";
import type { Result, ToolError } from "@/types/tools";
import { clampTimeoutMs, isAbortLikeError } from "@/utils/async";
import { estimateTokenCount } from "@/utils/helpers";
import { logger } from "@/utils/logger";
import { createSafeCustomFetch, customProviderBaseUrl, defaultDnsResolve } from "./custom-url";

type GenerateTextFn = typeof aiGenerateText;

type ProviderFactory = {
    languageModel(modelId: string): LanguageModel;
};
type ProviderFactoryOverrides = Partial<Record<ProviderId, ProviderFactory>>;

export interface ProviderRegistryOptions {
    generateTextFn?: GenerateTextFn;
    providerFactories?: ProviderFactoryOverrides;
}

export const thinkingModeValues = ["minimal", "low", "medium", "high", "max"] as const;
export const ThinkingModeSchema = z.enum(thinkingModeValues);
export type ThinkingMode = z.infer<typeof ThinkingModeSchema>;

export interface GenerateTextOptions {
    abortSignal?: AbortSignal;
    catalog?: ModelsListResponse;
    configuredProviders?: ReadonlySet<ProviderId>;
    maxOutputTokens?: number;
    temperature?: number;
    thinkingMode?: ThinkingMode;
}

export interface GenerateTextResult {
    model: string;
    provider: ProviderId;
    text: string;
    usage: {
        input_tokens: number;
        output_tokens: number;
        total_tokens: number;
    };
}

const providerTimeoutMs = (config: ChorusConfig) =>
    clampTimeoutMs(config.provider_timeout_ms, DEFAULT_PROVIDER_TIMEOUT_MS);

// === Provider configuration checks ===

const configuredConfigValue = (config: ChorusConfig, key: keyof ChorusConfig): string | undefined => {
    const value = config[key];
    if (typeof value !== "string" || value.length === 0) {
        return undefined;
    }
    if (!wasExpandedFromEnv(config, key) && hasUnresolvedEnvVar(value)) {
        return undefined;
    }
    return value;
};

const hasEnvVar = (name: string): boolean => {
    const value = process.env[name];
    return typeof value === "string" && value.length > 0;
};

export const providerConfigurationErrorMessage = (providerId: ProviderId, target = "it") => {
    switch (providerId) {
        case "amazon-bedrock":
            return `Provider not configured: amazon-bedrock. Set amazon_bedrock_api_key (or AWS credentials) and amazon_bedrock_region (or AWS_REGION) to enable ${target}.`;
        case "anthropic":
            return `Provider not configured: anthropic. Set anthropic_api_key to enable ${target}.`;
        case "azure":
            return `Provider not configured: azure. Set azure_api_key and azure_resource_name (or azure_base_url / AZURE_RESOURCE_NAME) to enable ${target}.`;
        case "custom":
            return `Provider not configured: custom. Set custom_url and custom_api_key to enable ${target}.`;
        case "google-vertex":
            return `Provider not configured: google-vertex. Set google_vertex_api_key or google_vertex_project and google_vertex_location to enable ${target}.`;
        case "openrouter":
            return `Provider not configured: openrouter. Set openrouter_api_key to enable ${target}.`;
        default: {
            const _exhaustive: never = providerId;
            throw new Error(`Unknown provider: ${_exhaustive}`);
        }
    }
};

export const isProviderConfigured = (providerId: ProviderId, config: ChorusConfig): boolean => {
    switch (providerId) {
        case "amazon-bedrock": {
            const hasAuth =
                configuredConfigValue(config, "amazon_bedrock_api_key") !== undefined ||
                (hasEnvVar("AWS_ACCESS_KEY_ID") && hasEnvVar("AWS_SECRET_ACCESS_KEY")) ||
                hasEnvVar("AWS_PROFILE");
            const hasRegionOrEndpoint =
                configuredConfigValue(config, "amazon_bedrock_region") !== undefined ||
                hasEnvVar("AWS_REGION") ||
                hasEnvVar("AWS_ENDPOINT_URL_BEDROCK_RUNTIME") ||
                hasEnvVar("AWS_ENDPOINT_URL");
            return hasAuth && hasRegionOrEndpoint;
        }
        case "anthropic":
            return configuredConfigValue(config, "anthropic_api_key") !== undefined;
        case "azure": {
            const hasApiKey = configuredConfigValue(config, "azure_api_key") !== undefined;
            const hasTarget =
                configuredConfigValue(config, "azure_resource_name") !== undefined ||
                configuredConfigValue(config, "azure_base_url") !== undefined ||
                hasEnvVar("AZURE_RESOURCE_NAME");
            return hasApiKey && hasTarget;
        }
        case "custom":
            return (
                configuredConfigValue(config, "custom_url") !== undefined &&
                configuredConfigValue(config, "custom_api_key") !== undefined
            );
        case "google-vertex": {
            if (configuredConfigValue(config, "google_vertex_api_key") !== undefined) {
                return true;
            }
            const hasProject =
                configuredConfigValue(config, "google_vertex_project") !== undefined ||
                hasEnvVar("GOOGLE_VERTEX_PROJECT");
            const hasLocation =
                configuredConfigValue(config, "google_vertex_location") !== undefined ||
                hasEnvVar("GOOGLE_VERTEX_LOCATION");
            return hasProject && hasLocation;
        }
        case "openrouter":
            return configuredConfigValue(config, "openrouter_api_key") !== undefined;
        default: {
            const _exhaustive: never = providerId;
            throw new Error(`Unknown provider: ${_exhaustive}`);
        }
    }
};

// === Thinking mode mappings ===

const MIN_ANTHROPIC_THINKING_BUDGET = 1_024;
const MIN_ANTHROPIC_OUTPUT_HEADROOM = 1_024;
const FALLBACK_ANTHROPIC_THINKING_CAP = 32_000;

const ANTHROPIC_THINKING_BUDGET: Record<ThinkingMode, number> = {
    minimal: 1_024,
    low: 5_000,
    medium: 20_000,
    high: 50_000,
    max: 80_000,
};

type OpenRouterReasoningEffort = Extract<
    NonNullable<OpenRouterProviderOptions["reasoning"]>,
    { effort: unknown }
>["effort"];

const OPENROUTER_REASONING_EFFORT = {
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    max: "xhigh",
} as const satisfies Record<ThinkingMode, OpenRouterReasoningEffort>;

interface ResolvedThinkingConfig {
    anthropicThinkingEnabled: boolean;
    maxOutputTokens: number | undefined;
    providerOptions: Record<string, Record<string, unknown>>;
}

// === Registry surface ===

export type ProviderRegistry = {
    isProviderConfigured: (providerId: ProviderId) => boolean;
    getModelInfo: (
        input: string,
        options?: {
            catalog?: ModelsListResponse;
            configuredProviders?: ReadonlySet<ProviderId>;
        },
    ) => Promise<BrokerModelInfo | undefined>;
    generateText: (
        input: string,
        prompt: string,
        systemPrompt?: string,
        options?: GenerateTextOptions,
    ) => Promise<Result<GenerateTextResult, ToolError>>;
};

type ProviderAbortReason = "timeout" | "cancelled" | null;

const createProviderAbortSignal = (parent: AbortSignal | undefined, timeoutMs: number) => {
    const controller = new AbortController();
    let cleanedUp = false;
    let reason: ProviderAbortReason = null;
    let parentAbortListener: (() => void) | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
        if (cleanedUp) {
            return;
        }

        cleanedUp = true;
        if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
        }
        if (parent && parentAbortListener) {
            parent.removeEventListener("abort", parentAbortListener);
        }
    };

    const abortWithReason = (abortReason: Exclude<ProviderAbortReason, null>) => {
        if (reason === null) {
            reason = abortReason;
        }
        cleanup();
        controller.abort();
    };

    if (parent?.aborted) {
        abortWithReason("cancelled");
    } else {
        timeoutId = setTimeout(() => abortWithReason("timeout"), timeoutMs);
        if (parent) {
            parentAbortListener = () => abortWithReason("cancelled");
            parent.addEventListener("abort", parentAbortListener, { once: true });
        }
    }

    return {
        cleanup,
        getAbortReason: (): ProviderAbortReason => reason,
        signal: controller.signal,
    };
};

const isDeterministicCustomUrlError = (error: unknown): boolean => {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
        if (current.message.startsWith("custom_url")) {
            return true;
        }
        current = (current as Error & { cause?: unknown }).cause;
    }
    return false;
};

export const createProviderRegistry = (
    config: ChorusConfig,
    { generateTextFn = aiGenerateText, providerFactories = {} }: ProviderRegistryOptions = {},
): ProviderRegistry => {
    const providerFactoriesById = new Map<ProviderId, ProviderFactory>(
        Object.entries(providerFactories) as Array<[ProviderId, ProviderFactory]>,
    );

    const isProviderConfiguredForRegistry = (providerId: ProviderId) => {
        return isProviderConfigured(providerId, config);
    };

    const resolveThinkingConfig = (
        modelInfo: BrokerModelInfo,
        thinkingMode: ThinkingMode | undefined,
        requestedMaxOutputTokens: number | undefined,
    ): ResolvedThinkingConfig => {
        if (!thinkingMode) {
            return {
                anthropicThinkingEnabled: false,
                maxOutputTokens: requestedMaxOutputTokens,
                providerOptions: {},
            };
        }

        switch (modelInfo.provider) {
            case "anthropic": {
                const requestedBudget = ANTHROPIC_THINKING_BUDGET[thinkingMode];
                const outputLimit = modelInfo.output_limit;

                if (outputLimit !== undefined) {
                    if (outputLimit <= MIN_ANTHROPIC_THINKING_BUDGET) {
                        return {
                            anthropicThinkingEnabled: false,
                            maxOutputTokens: requestedMaxOutputTokens,
                            providerOptions: {},
                        };
                    }

                    const maxBudget = Math.max(
                        MIN_ANTHROPIC_THINKING_BUDGET,
                        outputLimit - MIN_ANTHROPIC_OUTPUT_HEADROOM,
                    );
                    const budgetTokens = Math.min(requestedBudget, maxBudget);
                    const remainingOutput = outputLimit - budgetTokens;
                    const maxOutputTokens =
                        requestedMaxOutputTokens !== undefined
                            ? Math.min(requestedMaxOutputTokens, remainingOutput)
                            : remainingOutput;

                    return {
                        anthropicThinkingEnabled: true,
                        maxOutputTokens,
                        providerOptions: {
                            anthropic: {
                                thinking: {
                                    type: "enabled",
                                    budgetTokens,
                                },
                            },
                        },
                    };
                }

                const budgetTokens = Math.min(requestedBudget, FALLBACK_ANTHROPIC_THINKING_CAP);
                return {
                    anthropicThinkingEnabled: true,
                    maxOutputTokens: requestedMaxOutputTokens,
                    providerOptions: {
                        anthropic: {
                            thinking: {
                                type: "enabled",
                                budgetTokens,
                            },
                        },
                    },
                };
            }
            case "openrouter":
                return {
                    anthropicThinkingEnabled: false,
                    maxOutputTokens: requestedMaxOutputTokens,
                    providerOptions: {
                        openrouter: {
                            reasoning: {
                                effort: OPENROUTER_REASONING_EFFORT[thinkingMode],
                            },
                        },
                    },
                };
            default:
                return {
                    anthropicThinkingEnabled: false,
                    maxOutputTokens: requestedMaxOutputTokens,
                    providerOptions: {},
                };
        }
    };

    const createProviderFactory = async (providerId: ProviderId): Promise<ProviderFactory> => {
        switch (providerId) {
            case "amazon-bedrock": {
                const apiKey = configuredConfigValue(config, "amazon_bedrock_api_key");
                const region = configuredConfigValue(config, "amazon_bedrock_region");
                return apiKey || region
                    ? createAmazonBedrock({
                          ...(apiKey ? { apiKey } : {}),
                          ...(region ? { region } : {}),
                      })
                    : bedrock;
            }
            case "anthropic": {
                const apiKey = configuredConfigValue(config, "anthropic_api_key");
                return apiKey ? createAnthropic({ apiKey }) : anthropic;
            }
            case "azure": {
                const apiKey = configuredConfigValue(config, "azure_api_key");
                const resourceName = configuredConfigValue(config, "azure_resource_name");
                const baseURL = configuredConfigValue(config, "azure_base_url");
                return apiKey || resourceName || baseURL
                    ? createAzure({
                          ...(apiKey ? { apiKey } : {}),
                          ...(resourceName ? { resourceName } : {}),
                          ...(baseURL ? { baseURL } : {}),
                      })
                    : azure;
            }
            case "google-vertex": {
                const apiKey = configuredConfigValue(config, "google_vertex_api_key");
                if (apiKey) {
                    return createVertex({ apiKey });
                }
                const project = configuredConfigValue(config, "google_vertex_project");
                const location = configuredConfigValue(config, "google_vertex_location");
                return project || location
                    ? createVertex({
                          ...(project ? { project } : {}),
                          ...(location ? { location } : {}),
                      })
                    : vertex;
            }
            case "openrouter": {
                const apiKey = configuredConfigValue(config, "openrouter_api_key");
                return apiKey ? createOpenRouter({ apiKey }) : openrouter;
            }
            case "custom":
                return createOpenAICompatible({
                    apiKey: configuredConfigValue(config, "custom_api_key"),
                    baseURL: await customProviderBaseUrl(config.custom_url, config.allow_insecure_custom === true),
                    fetch: createSafeCustomFetch(defaultDnsResolve),
                    name: "custom",
                });
            default: {
                const _exhaustive: never = providerId;
                throw new Error(`Unknown provider: ${_exhaustive}`);
            }
        }
    };

    const getProviderFactory = async (providerId: ProviderId): Promise<ProviderFactory> => {
        const existingProvider = providerFactoriesById.get(providerId);

        if (existingProvider) {
            return existingProvider;
        }

        const provider = await createProviderFactory(providerId);
        providerFactoriesById.set(providerId, provider);
        return provider;
    };

    // === Resolution + generation ===

    const resolveToBrokerModel = (
        input: string,
        catalog: ModelsListResponse | undefined,
        configuredProviders: ReadonlySet<ProviderId> | undefined,
    ) => {
        if (catalog === undefined || configuredProviders === undefined) {
            // The broker is the only path that knows about the catalog and
            // the set of configured providers. The registry cannot perform
            // resolution on its own.
            return undefined;
        }
        const classified = classifyInput(input);
        const result = resolveRoute(classified, {
            catalog,
            configuredProviders,
        });
        if (!result.ok) {
            return undefined;
        }
        return result.value;
    };

    const getModelInfo: ProviderRegistry["getModelInfo"] = async (input, options) => {
        return resolveToBrokerModel(input, options?.catalog, options?.configuredProviders);
    };

    const generateText: ProviderRegistry["generateText"] = async (input, prompt, systemPrompt, options = {}) => {
        const catalog = options.catalog;
        const configuredProviders = options.configuredProviders;

        if (catalog === undefined || configuredProviders === undefined) {
            return {
                ok: false,
                error: {
                    type: "not_found",
                    message: `Model not found: ${input}`,
                    retryable: false,
                },
            };
        }

        const modelInfo = resolveToBrokerModel(input, catalog, configuredProviders);
        if (!modelInfo) {
            return {
                ok: false,
                error: {
                    type: "not_found",
                    message: `Model not found: ${input}`,
                    retryable: false,
                },
            };
        }

        if (!isProviderConfiguredForRegistry(modelInfo.provider)) {
            return {
                ok: false,
                error: {
                    type: "configuration",
                    message: providerConfigurationErrorMessage(modelInfo.provider),
                    retryable: false,
                },
            };
        }

        if (options.abortSignal?.aborted) {
            return {
                ok: false,
                error: {
                    type: "cancelled",
                    message: "Provider request cancelled",
                    retryable: false,
                },
            };
        }

        let abortHandle: ReturnType<typeof createProviderAbortSignal> | undefined;
        try {
            const provider = await getProviderFactory(modelInfo.provider);
            const model = provider.languageModel(modelInfo.provider_model_id);
            const thinking = resolveThinkingConfig(modelInfo, options.thinkingMode, options.maxOutputTokens);
            abortHandle = createProviderAbortSignal(options.abortSignal, providerTimeoutMs(config));

            let result: Awaited<ReturnType<GenerateTextFn>>;
            try {
                result = await Promise.resolve(
                    generateTextFn({
                        abortSignal: abortHandle.signal,
                        maxOutputTokens: thinking.maxOutputTokens,
                        maxRetries: 0,
                        model,
                        prompt,
                        ...(Object.keys(thinking.providerOptions).length > 0
                            ? {
                                  providerOptions: thinking.providerOptions as Record<
                                      string,
                                      Record<string, JSONValue>
                                  >,
                              }
                            : {}),
                        system: systemPrompt,
                        temperature: thinking.anthropicThinkingEnabled ? 0 : options.temperature,
                    }),
                );
            } finally {
                abortHandle.cleanup();
            }

            // Prefer API-provided usage fields. When the API returns only
            // totalTokens without a breakdown, set input/output to 0
            // instead of estimating, so the numbers stay consistent.
            const hasApiTotal = typeof result.usage?.totalTokens === "number" && result.usage.totalTokens > 0;
            const inputTokens = result.usage?.inputTokens ?? (hasApiTotal ? 0 : estimateTokenCount(prompt));
            const outputTokens = result.usage?.outputTokens ?? (hasApiTotal ? 0 : estimateTokenCount(result.text));

            return {
                ok: true,
                value: {
                    model: modelInfo.route_id,
                    provider: modelInfo.provider,
                    text: result.text,
                    usage: {
                        input_tokens: inputTokens,
                        output_tokens: outputTokens,
                        total_tokens: result.usage?.totalTokens ?? inputTokens + outputTokens,
                    },
                },
            };
        } catch (error: unknown) {
            const abortReason = abortHandle?.getAbortReason() ?? null;
            if (abortReason === "cancelled") {
                return {
                    ok: false,
                    error: {
                        type: "cancelled",
                        message: "Provider request cancelled",
                        retryable: false,
                    },
                };
            }

            const cause = RetryError.isInstance(error) ? error.lastError : error;
            if (abortReason === "timeout" || isAbortLikeError(cause) || isAbortLikeError(error)) {
                return {
                    ok: false,
                    error: {
                        type: "timeout",
                        message: "Provider request timed out",
                        retryable: true,
                    },
                };
            }

            const statusCode = APICallError.isInstance(cause) ? cause.statusCode : undefined;
            let retryable = true;
            if (isDeterministicCustomUrlError(cause)) {
                retryable = false;
            } else if (APICallError.isInstance(cause)) {
                retryable = Boolean(cause.isRetryable);
            }

            const errorName = cause instanceof Error ? cause.name : typeof cause;
            logger.warn("Provider request failed", {
                provider: modelInfo.provider,
                route_id: modelInfo.route_id,
                error_name: errorName,
                ...(statusCode !== undefined ? { status_code: statusCode } : {}),
                retryable,
            });

            return {
                ok: false,
                error: {
                    type: "execution",
                    message: "Provider request failed",
                    retryable,
                },
            };
        }
    };

    return {
        generateText,
        getModelInfo,
        isProviderConfigured: isProviderConfiguredForRegistry,
    };
};

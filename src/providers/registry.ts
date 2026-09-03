import { bedrock, createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { azure, createAzure } from "@ai-sdk/azure";
import { createVertex, vertex } from "@ai-sdk/google-vertex";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter, type OpenRouterProviderOptions, openrouter } from "@openrouter/ai-sdk-provider";
import { generateText as aiGenerateText, type JSONValue, type LanguageModel } from "ai";

import type { ChorusConfig } from "@/config";
import { classifyInput, resolveRoute } from "@/providers/resolve-route";
import type { BrokerModelInfo, ModelsListResponse, ProviderId } from "@/types/providers";
import type { Result, ToolError } from "@/types/tools";
import { estimateTokenCount } from "@/utils/helpers";
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

export type ThinkingMode = "minimal" | "low" | "medium" | "high" | "max";

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

const DEFAULT_PROVIDER_TIMEOUT_MS = 1_800_000;

const providerTimeoutMs = (config: ChorusConfig) => {
    const raw = config.provider_timeout_ms;
    return raw > 0 ? raw : DEFAULT_PROVIDER_TIMEOUT_MS;
};

// === Provider configuration map ===
//
// Flat, two-column table: each row binds a ProviderId to (a) the config key
// that holds its API key and (b) the set of config keys that must all be set
// for the provider to count as configured. The `custom` provider requires both
// the URL and the API key; the rest only require their own API key.

interface ProviderConfigEntry {
    apiKey: keyof ChorusConfig;
    requiredConfig: readonly (keyof ChorusConfig)[];
}

const PROVIDER_CONFIG: Record<ProviderId, ProviderConfigEntry> = {
    "amazon-bedrock": {
        apiKey: "amazon_bedrock_api_key",
        requiredConfig: ["amazon_bedrock_api_key"],
    },
    anthropic: {
        apiKey: "anthropic_api_key",
        requiredConfig: ["anthropic_api_key"],
    },
    azure: { apiKey: "azure_api_key", requiredConfig: ["azure_api_key"] },
    custom: {
        apiKey: "custom_api_key",
        requiredConfig: ["custom_url", "custom_api_key"],
    },
    "google-vertex": {
        apiKey: "google_vertex_api_key",
        requiredConfig: ["google_vertex_api_key"],
    },
    openrouter: {
        apiKey: "openrouter_api_key",
        requiredConfig: ["openrouter_api_key"],
    },
};

const getProviderApiKey = (config: ChorusConfig, pid: ProviderId) => {
    return config[PROVIDER_CONFIG[pid].apiKey] as string | undefined;
};

const getProviderRequiredConfigKeys = (providerId: ProviderId) => {
    return PROVIDER_CONFIG[providerId].requiredConfig;
};

export const providerConfigurationErrorMessage = (providerId: ProviderId, target = "it") => {
    return `Provider not configured: ${providerId}. Set ${getProviderRequiredConfigKeys(providerId).join(
        " and ",
    )} to enable ${target}.`;
};

const isUnresolvedEnvVar = (value: string) => {
    // Catch both standalone $VAR and composite values like prefix-$VAR-suffix.
    // After resolveEnvVars in config.ts substitutes known env vars, any
    // remaining $VAR must be an unresolved placeholder.
    return /\$[A-Z_][A-Z0-9_]*/u.test(value);
};

export const isProviderConfigured = (providerId: ProviderId, config: ChorusConfig) => {
    return getProviderRequiredConfigKeys(providerId).every((key) => {
        const value = config[key];
        return typeof value === "string" && value.length > 0 && !isUnresolvedEnvVar(value);
    });
};

// === Thinking mode mappings ===

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

const createProviderAbortSignal = (parent: AbortSignal | undefined, timeoutMs: number) => {
    const controller = new AbortController();
    let cleanedUp = false;
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
    const abort = () => {
        cleanup();
        controller.abort();
    };

    timeoutId = setTimeout(abort, timeoutMs);
    if (parent) {
        if (parent.aborted) {
            abort();
        } else {
            parentAbortListener = abort;
            parent.addEventListener("abort", parentAbortListener, { once: true });
        }
    }

    return { cleanup, signal: controller.signal };
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

    const buildProviderOptions = (
        provider: ProviderId,
        thinkingMode: ThinkingMode | undefined,
    ): Record<string, Record<string, unknown>> => {
        if (!thinkingMode) {
            return {};
        }

        switch (provider) {
            case "anthropic":
                return {
                    anthropic: {
                        thinking: {
                            type: "enabled",
                            budgetTokens: ANTHROPIC_THINKING_BUDGET[thinkingMode],
                        },
                    },
                };
            case "openrouter":
                return {
                    openrouter: {
                        reasoning: {
                            effort: OPENROUTER_REASONING_EFFORT[thinkingMode],
                        },
                    },
                };
            default:
                return {};
        }
    };

    const createProviderFactory = async (providerId: ProviderId): Promise<ProviderFactory> => {
        const apiKey = getProviderApiKey(config, providerId);
        switch (providerId) {
            case "amazon-bedrock":
                return apiKey ? createAmazonBedrock({ apiKey }) : bedrock;
            case "anthropic":
                return apiKey ? createAnthropic({ apiKey }) : anthropic;
            case "azure":
                return apiKey ? createAzure({ apiKey }) : azure;
            case "google-vertex":
                return apiKey ? createVertex({ apiKey }) : vertex;
            case "openrouter":
                return apiKey ? createOpenRouter({ apiKey }) : openrouter;
            case "custom":
                return createOpenAICompatible({
                    apiKey: config.custom_api_key,
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

    const resolveToBrokerModel = async (
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
        const result = await resolveRoute(classified, {
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

        const modelInfo = await resolveToBrokerModel(input, catalog, configuredProviders);
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

        try {
            const provider = await getProviderFactory(modelInfo.provider);
            const model = provider.languageModel(modelInfo.provider_model_id);
            const providerOptions = buildProviderOptions(modelInfo.provider, options.thinkingMode);
            const abortSignal = createProviderAbortSignal(options.abortSignal, providerTimeoutMs(config));

            let result: Awaited<ReturnType<GenerateTextFn>>;
            try {
                result = await Promise.resolve(
                    generateTextFn({
                        abortSignal: abortSignal.signal,
                        maxOutputTokens: options.maxOutputTokens,
                        model,
                        prompt,
                        ...(Object.keys(providerOptions).length > 0
                            ? {
                                  providerOptions: providerOptions as Record<string, Record<string, JSONValue>>,
                              }
                            : {}),
                        system: systemPrompt,
                        temperature:
                            modelInfo.provider === "anthropic" && options.thinkingMode ? 0 : options.temperature,
                    }),
                );
            } finally {
                abortSignal.cleanup();
            }

            // Prefer API-provided usage fields.  When the API returns only
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
            const isAbortError =
                error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

            return {
                ok: false,
                error: {
                    type: isAbortError ? "timeout" : "execution",
                    message: isAbortError ? "Provider request timed out" : "Provider request failed",
                    retryable: true,
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

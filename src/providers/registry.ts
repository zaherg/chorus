import { alibaba, createAlibaba } from "@ai-sdk/alibaba";
import { bedrock, createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { azure, createAzure } from "@ai-sdk/azure";
import { baseten, createBaseten } from "@ai-sdk/baseten";
import { cerebras, createCerebras } from "@ai-sdk/cerebras";
import { cohere, createCohere } from "@ai-sdk/cohere";
import { createDeepInfra, deepinfra } from "@ai-sdk/deepinfra";
import { createDeepSeek, deepseek } from "@ai-sdk/deepseek";
import { createFireworks, fireworks } from "@ai-sdk/fireworks";
import { createGateway, gateway } from "@ai-sdk/gateway";
import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { createVertex, vertex } from "@ai-sdk/google-vertex";
import { createGroq, groq } from "@ai-sdk/groq";
import { createHuggingFace, huggingface } from "@ai-sdk/huggingface";
import { createMistral, mistral } from "@ai-sdk/mistral";
import { createOpenAI, openai } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createPerplexity, perplexity } from "@ai-sdk/perplexity";
import { createTogetherAI, togetherai } from "@ai-sdk/togetherai";
import { createVercel, vercel } from "@ai-sdk/vercel";
import { createXai, xai } from "@ai-sdk/xai";
import { createOpenRouter, openrouter } from "@openrouter/ai-sdk-provider";
import {
    generateText as aiGenerateText,
    type JSONValue,
    type LanguageModel,
} from "ai";

import type { ChorusConfig } from "@/config";
import { classifyInput, resolveRoute } from "@/providers/resolve-route";
import type {
    BrokerModelInfo,
    ModelsListResponse,
    ProviderId,
} from "@/types/providers";
import type { Result, ToolError } from "@/types/tools";
import { estimateTokenCount } from "@/utils";
import {
    createSafeCustomFetch,
    customProviderBaseUrl,
    defaultDnsResolve,
} from "./custom-url";

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

const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

const providerTimeoutMs = (config: ChorusConfig): number => {
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
    alibaba: { apiKey: "alibaba_api_key", requiredConfig: ["alibaba_api_key"] },
    "amazon-bedrock": {
        apiKey: "amazon_bedrock_api_key",
        requiredConfig: ["amazon_bedrock_api_key"],
    },
    anthropic: {
        apiKey: "anthropic_api_key",
        requiredConfig: ["anthropic_api_key"],
    },
    azure: { apiKey: "azure_api_key", requiredConfig: ["azure_api_key"] },
    baseten: { apiKey: "baseten_api_key", requiredConfig: ["baseten_api_key"] },
    cerebras: {
        apiKey: "cerebras_api_key",
        requiredConfig: ["cerebras_api_key"],
    },
    cohere: { apiKey: "cohere_api_key", requiredConfig: ["cohere_api_key"] },
    custom: {
        apiKey: "custom_api_key",
        requiredConfig: ["custom_url", "custom_api_key"],
    },
    deepinfra: {
        apiKey: "deepinfra_api_key",
        requiredConfig: ["deepinfra_api_key"],
    },
    deepseek: {
        apiKey: "deepseek_api_key",
        requiredConfig: ["deepseek_api_key"],
    },
    fireworks: {
        apiKey: "fireworks_api_key",
        requiredConfig: ["fireworks_api_key"],
    },
    gateway: { apiKey: "gateway_api_key", requiredConfig: ["gateway_api_key"] },
    google: { apiKey: "google_api_key", requiredConfig: ["google_api_key"] },
    "google-vertex": {
        apiKey: "google_vertex_api_key",
        requiredConfig: ["google_vertex_api_key"],
    },
    groq: { apiKey: "groq_api_key", requiredConfig: ["groq_api_key"] },
    huggingface: {
        apiKey: "huggingface_api_key",
        requiredConfig: ["huggingface_api_key"],
    },
    mistral: { apiKey: "mistral_api_key", requiredConfig: ["mistral_api_key"] },
    openai: { apiKey: "openai_api_key", requiredConfig: ["openai_api_key"] },
    openrouter: {
        apiKey: "openrouter_api_key",
        requiredConfig: ["openrouter_api_key"],
    },
    perplexity: {
        apiKey: "perplexity_api_key",
        requiredConfig: ["perplexity_api_key"],
    },
    togetherai: {
        apiKey: "togetherai_api_key",
        requiredConfig: ["togetherai_api_key"],
    },
    vercel: { apiKey: "vercel_api_key", requiredConfig: ["vercel_api_key"] },
    xai: { apiKey: "xai_api_key", requiredConfig: ["xai_api_key"] },
};

const getProviderApiKey = (
    config: ChorusConfig,
    pid: ProviderId,
): string | undefined => {
    return config[PROVIDER_CONFIG[pid].apiKey] as string | undefined;
};

const getProviderRequiredConfigKeys = (
    providerId: ProviderId,
): readonly (keyof ChorusConfig)[] => {
    return PROVIDER_CONFIG[providerId].requiredConfig;
};

export const providerConfigurationErrorMessage = (
    providerId: ProviderId,
    target = "it",
): string => {
    return `Provider not configured: ${providerId}. Set ${getProviderRequiredConfigKeys(
        providerId,
    ).join(" and ")} to enable ${target}.`;
};

const isUnresolvedEnvVar = (value: string): boolean => {
    // Catch both standalone $VAR and composite values like prefix-$VAR-suffix.
    // After resolveEnvVars in config.ts substitutes known env vars, any
    // remaining $VAR must be an unresolved placeholder.
    return /\$[A-Z_][A-Z0-9_]*/u.test(value);
};

export const isProviderConfigured = (
    providerId: ProviderId,
    config: ChorusConfig,
): boolean => {
    return getProviderRequiredConfigKeys(providerId).every((key) => {
        const value = config[key];
        return (
            typeof value === "string" &&
            value.length > 0 &&
            !isUnresolvedEnvVar(value)
        );
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

const OPENAI_REASONING_EFFORT: Record<ThinkingMode, string> = {
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    max: "high",
};

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

export const createProviderRegistry = (
    config: ChorusConfig,
    {
        generateTextFn = aiGenerateText,
        providerFactories = {},
    }: ProviderRegistryOptions = {},
): ProviderRegistry => {
    const providerFactoriesById = new Map<ProviderId, ProviderFactory>(
        Object.entries(providerFactories) as Array<
            [ProviderId, ProviderFactory]
        >,
    );

    const isProviderConfiguredForRegistry = (
        providerId: ProviderId,
    ): boolean => {
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
                            budgetTokens:
                                ANTHROPIC_THINKING_BUDGET[thinkingMode],
                        },
                    },
                };
            case "openai":
                return {
                    openai: {
                        reasoningEffort: OPENAI_REASONING_EFFORT[thinkingMode],
                    },
                };
            default:
                return {};
        }
    };

    const createProviderFactory = async (
        providerId: ProviderId,
    ): Promise<ProviderFactory> => {
        const apiKey = getProviderApiKey(config, providerId);
        switch (providerId) {
            case "alibaba":
                return apiKey ? createAlibaba({ apiKey }) : alibaba;
            case "amazon-bedrock":
                return apiKey ? createAmazonBedrock({ apiKey }) : bedrock;
            case "anthropic":
                return apiKey ? createAnthropic({ apiKey }) : anthropic;
            case "azure":
                return apiKey ? createAzure({ apiKey }) : azure;
            case "baseten":
                return apiKey ? createBaseten({ apiKey }) : baseten;
            case "cerebras":
                return apiKey ? createCerebras({ apiKey }) : cerebras;
            case "cohere":
                return apiKey ? createCohere({ apiKey }) : cohere;
            case "deepinfra":
                return apiKey ? createDeepInfra({ apiKey }) : deepinfra;
            case "deepseek":
                return apiKey ? createDeepSeek({ apiKey }) : deepseek;
            case "fireworks":
                return apiKey ? createFireworks({ apiKey }) : fireworks;
            case "gateway":
                return apiKey ? createGateway({ apiKey }) : gateway;
            case "google":
                return apiKey ? createGoogleGenerativeAI({ apiKey }) : google;
            case "google-vertex":
                return apiKey ? createVertex({ apiKey }) : vertex;
            case "groq":
                return apiKey ? createGroq({ apiKey }) : groq;
            case "huggingface":
                return apiKey ? createHuggingFace({ apiKey }) : huggingface;
            case "mistral":
                return apiKey ? createMistral({ apiKey }) : mistral;
            case "openai":
                return apiKey ? createOpenAI({ apiKey }) : openai;
            case "openrouter":
                return apiKey ? createOpenRouter({ apiKey }) : openrouter;
            case "perplexity":
                return apiKey ? createPerplexity({ apiKey }) : perplexity;
            case "togetherai":
                return apiKey ? createTogetherAI({ apiKey }) : togetherai;
            case "vercel":
                return apiKey ? createVercel({ apiKey }) : vercel;
            case "xai":
                return apiKey ? createXai({ apiKey }) : xai;
            case "custom":
                return createOpenAICompatible({
                    apiKey: config.custom_api_key,
                    baseURL: await customProviderBaseUrl(
                        config.custom_url,
                        config.allow_insecure_custom === true,
                    ),
                    fetch: createSafeCustomFetch(defaultDnsResolve),
                    name: "custom",
                });
            default: {
                const _exhaustive: never = providerId;
                throw new Error(`Unknown provider: ${_exhaustive}`);
            }
        }
    };

    const getProviderFactory = async (
        providerId: ProviderId,
    ): Promise<ProviderFactory> => {
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
    ): Promise<BrokerModelInfo | undefined> => {
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

    const getModelInfo: ProviderRegistry["getModelInfo"] = async (
        input,
        options,
    ) => {
        return resolveToBrokerModel(
            input,
            options?.catalog,
            options?.configuredProviders,
        );
    };

    const generateText: ProviderRegistry["generateText"] = async (
        input,
        prompt,
        systemPrompt,
        options = {},
    ) => {
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

        const modelInfo = await resolveToBrokerModel(
            input,
            catalog,
            configuredProviders,
        );
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
                    message: providerConfigurationErrorMessage(
                        modelInfo.provider,
                    ),
                    retryable: false,
                },
            };
        }

        try {
            const provider = await getProviderFactory(modelInfo.provider);
            const model = provider.languageModel(modelInfo.provider_model_id);
            const providerOptions = buildProviderOptions(
                modelInfo.provider,
                options.thinkingMode,
            );
            const abortSignal = (() => {
                const controller = new AbortController();
                const timeoutMs = providerTimeoutMs(config);
                const timeoutId = setTimeout(
                    () => controller.abort(),
                    timeoutMs,
                );
                const parent = options.abortSignal;

                if (parent) {
                    if (parent.aborted) {
                        clearTimeout(timeoutId);
                        controller.abort();
                    } else {
                        const onAbort = () => {
                            clearTimeout(timeoutId);
                            controller.abort();
                        };
                        parent.addEventListener("abort", onAbort, {
                            once: true,
                        });
                    }
                }

                return { signal: controller.signal, timeoutId };
            })();

            const result = await generateTextFn({
                abortSignal: abortSignal.signal,
                maxOutputTokens: options.maxOutputTokens,
                model,
                prompt,
                ...(Object.keys(providerOptions).length > 0
                    ? {
                          providerOptions: providerOptions as Record<
                              string,
                              Record<string, JSONValue>
                          >,
                      }
                    : {}),
                system: systemPrompt,
                temperature:
                    modelInfo.provider === "anthropic" && options.thinkingMode
                        ? 0
                        : options.temperature,
            });

            clearTimeout(abortSignal.timeoutId);

            // Prefer API-provided usage fields.  When the API returns only
            // totalTokens without a breakdown, set input/output to 0
            // instead of estimating, so the numbers stay consistent.
            const hasApiTotal =
                typeof result.usage?.totalTokens === "number" &&
                result.usage.totalTokens > 0;
            const inputTokens =
                result.usage?.inputTokens ??
                (hasApiTotal ? 0 : estimateTokenCount(prompt));
            const outputTokens =
                result.usage?.outputTokens ??
                (hasApiTotal ? 0 : estimateTokenCount(result.text));

            return {
                ok: true,
                value: {
                    model: modelInfo.route_id,
                    provider: modelInfo.provider,
                    text: result.text,
                    usage: {
                        input_tokens: inputTokens,
                        output_tokens: outputTokens,
                        total_tokens:
                            result.usage?.totalTokens ??
                            inputTokens + outputTokens,
                    },
                },
            };
        } catch (error: unknown) {
            const isAbortError =
                error instanceof Error &&
                (error.name === "AbortError" || error.name === "TimeoutError");

            return {
                ok: false,
                error: {
                    type: isAbortError ? "timeout" : "execution",
                    message: isAbortError
                        ? "Provider request timed out"
                        : "Provider request failed",
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

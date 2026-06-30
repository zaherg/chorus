import { z } from "zod/v4";

// === Provider enumeration ===

/**
 * Exhaustive list of every supported LLM provider, stored as a const
 * tuple so each element carries the narrowest possible literal type.
 * Consumers use this for discriminated unions and exhaustiveness checks.
 */
export const providerIdValues = [
    "alibaba", // Alibaba Cloud (Qwen models)
    "amazon-bedrock", // Amazon Bedrock
    "anthropic", // Anthropic (Claude models)
    "azure", // Azure OpenAI Service
    "baseten", // Baseten
    "cerebras", // Cerebras Systems
    "cohere", // Cohere
    "custom", // User-defined custom provider (OpenAI-compatible endpoint)
    "deepinfra", // DeepInfra
    "deepseek", // DeepSeek
    "fireworks", // Fireworks AI
    "gateway", // Lit Protocol gateway models
    "google", // Google AI (Gemini models)
    "google-vertex", // Google Vertex AI
    "groq", // Groq
    "huggingface", // Hugging Face
    "mistral", // Mistral AI
    "openai", // OpenAI
    "openrouter", // OpenRouter (multi-provider aggregator)
    "perplexity", // Perplexity
    "togetherai", // Together AI
    "vercel", // Vercel AI
    "xai", // xAI (Grok models)
] as const;

// === Zod schemas ===

/**
 * Zod enum that validates a runtime string against the known providers.
 * Throws if the value is not a member of `providerIdValues`.
 */
export const ProviderIdSchema = z.enum(providerIdValues);

// === Inferred TypeScript types ===

/** Union of provider-id strings, extracted from the Zod schema. */
export type ProviderId = z.infer<typeof ProviderIdSchema>;

// === Broker model catalog (models.dev) ===

/**
 * Status of a single configured provider in `list-models` output.
 *
 * - `catalog`: models.dev has catalog entries for this configured provider;
 *   the provider rows in the response are executable route IDs.
 * - `passthrough`: provider is configured but no catalog key is mapped;
 *   the agent may still use provider-prefixed model IDs that the provider API
 *   will accept or reject.
 */
export const providerListStatusValues = ["catalog", "passthrough"] as const;
export const ProviderListStatusSchema = z.enum(providerListStatusValues);
export type ProviderListStatus = z.infer<typeof ProviderListStatusSchema>;

/**
 * Status of the local models.dev cache for a single `list-models` invocation.
 *
 * - `fresh`: cache is valid and current.
 * - `stale`: refresh failed, but existing cache was usable.
 */
export const cacheStatusValues = ["fresh", "stale"] as const;
export const CacheStatusSchema = z.enum(cacheStatusValues);
export type CacheStatus = z.infer<typeof CacheStatusSchema>;

/**
 * A single executable model row returned by `list-models`.
 *
 * `route_id` is the exact CLI input the agent should pass to `--models` or
 * `--synthesis-model`. `provider_model_id` is the model ID passed to the AI
 * SDK provider after stripping the provider prefix. `canonical_model_id`
 * links back to models.dev canonical model metadata when available.
 */
export const BrokerModelInfoSchema = z.object({
    route_id: z.string().min(1),
    provider: ProviderIdSchema,
    provider_model_id: z.string().min(1),
    canonical_model_id: z.string().min(1).optional(),
    display_name: z.string().min(1),
    context_window: z.number().int().positive().optional(),
    output_limit: z.number().int().positive().optional(),
    supports_reasoning: z.boolean().optional(),
    supports_tools: z.boolean().optional(),
    supports_structured_output: z.boolean().optional(),
});
export type BrokerModelInfo = z.infer<typeof BrokerModelInfoSchema>;

/**
 * Per-provider entry in the `models.list/1` response.
 * `models` is empty for passthrough providers.
 */
export const ProviderListEntrySchema = z.object({
    status: ProviderListStatusSchema,
    models: z.array(BrokerModelInfoSchema),
});
export type ProviderListEntry = z.infer<typeof ProviderListEntrySchema>;

/**
 * Cache metadata block for the `models.list/1` response.
 * `fetched_at` and `expires_at` are ISO-8601 strings; absent when the cache
 * could not be read at all (in that case the response is an error response).
 */
export const CacheInfoSchema = z.object({
    status: CacheStatusSchema,
    fetched_at: z.string().min(1),
    expires_at: z.string().min(1),
});
export type CacheInfo = z.infer<typeof CacheInfoSchema>;

/**
 * Successful response for `consensus list-models --json`.
 * Only configured providers are present in `providers`.
 */
export const ModelsListResponseSchema = z.object({
    schema: z.literal("models.list/1"),
    cache: CacheInfoSchema,
    providers: z.record(z.string(), ProviderListEntrySchema),
});
export type ModelsListResponse = z.infer<typeof ModelsListResponseSchema>;

/**
 * Raw models.dev provider-model entry, validated by `ProviderModelEntrySchema`.
 * Only fields the broker actually consumes are typed; the catalog may include
 * more keys which are accepted by `.passthrough()`.
 */
export const ProviderModelEntrySchema = z
    .object({
        name: z.string().optional(),
        limit: z
            .object({
                context: z.number().optional(),
                output: z.number().optional(),
            })
            .passthrough()
            .optional(),
        reasoning: z.boolean().optional(),
        tool_call: z.boolean().optional(),
        structured_output: z.boolean().optional(),
    })
    .passthrough();

/**
 * Top-level shape of the `https://models.dev/catalog.json` payload. Both
 * `models` and `providers` are required at the top level.
 */
export const CatalogJsonSchema = z.object({
    models: z.record(z.string(), z.unknown()),
    providers: z.record(z.string(), z.unknown()),
});
export type CatalogJson = z.infer<typeof CatalogJsonSchema>;

/**
 * Per-provider model map extracted from a catalog payload.
 * `models[providerModelId]` is a `ProviderModelEntry` (or anything else the
 * catalog stored -- validated lazily by the broker).
 */
export const ProviderCatalogSchema = z.object({
    models: z.record(z.string(), ProviderModelEntrySchema),
});
export type ProviderCatalog = z.infer<typeof ProviderCatalogSchema>;

/**
 * Local cache metadata file (`models-cache/metadata.json`).
 */
export const CacheMetadataSchema = z.object({
    schema: z.literal("models-cache/1"),
    fetched_at: z.string().min(1),
    expires_at: z.string().min(1),
    source: z.string().min(1),
});
export type CacheMetadata = z.infer<typeof CacheMetadataSchema>;

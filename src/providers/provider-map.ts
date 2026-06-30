import type { ProviderId } from "@/types/providers";

/**
 * Mapping from internal `ProviderId` to the provider key used in
 * `https://models.dev/catalog.json`.
 *
 * `undefined` means the provider has no catalog entry on models.dev and is
 * treated as a passthrough (the agent may still send provider-prefixed model
 * IDs to the underlying API).
 *
 * This module is the only place in the codebase that knows the
 * internal-id-to-models.dev-key relationship. Other modules import from here.
 */
const PROVIDER_TO_MODELS_DEV_KEY: Record<ProviderId, string | undefined> = {
    alibaba: "alibaba",
    "amazon-bedrock": "amazon-bedrock",
    anthropic: "anthropic",
    azure: "azure",
    baseten: "baseten",
    cerebras: "cerebras",
    cohere: "cohere",
    custom: undefined,
    deepinfra: "deepinfra",
    deepseek: "deepseek",
    fireworks: "fireworks-ai",
    gateway: undefined,
    google: "google",
    "google-vertex": "google-vertex",
    groq: "groq",
    huggingface: "huggingface",
    mistral: "mistral",
    openai: "openai",
    openrouter: "openrouter",
    perplexity: "perplexity",
    togetherai: "togetherai",
    vercel: "vercel",
    xai: "xai",
};

/**
 * Returns the models.dev provider key for the internal `ProviderId`, or
 * `undefined` for passthrough providers (`custom`, `gateway`).
 */
export const getModelsDevProviderKey = (
    providerId: ProviderId,
): string | undefined => PROVIDER_TO_MODELS_DEV_KEY[providerId];

/**
 * Convenience predicate: `true` when the provider has a models.dev catalog
 * entry, `false` for passthrough providers.
 */
export const isCatalogBackedProvider = (providerId: ProviderId): boolean =>
    PROVIDER_TO_MODELS_DEV_KEY[providerId] !== undefined;

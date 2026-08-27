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
    "amazon-bedrock": "amazon-bedrock",
    anthropic: "anthropic",
    azure: "azure",
    custom: undefined,
    "google-vertex": "google-vertex",
    openrouter: "openrouter",
};

/**
 * Returns the models.dev provider key for the internal `ProviderId`, or
 * `undefined` for passthrough providers (`custom`).
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

/**
 * Resolves CLI `--models` and `--synthesis-model` input strings to
 * `BrokerModelInfo` records.
 *
 * Inputs arrive in two shapes:
 *
 *  - Exact `route_id` (e.g. `openai/gpt-5.2`, `custom/local-model`): the agent
 *    picked a specific provider+model pair. The provider may be catalog-backed
 *    (matched against `ModelsListResponse.providers`) or passthrough (`custom`,
 *    `gateway`), in which case a synthetic row is constructed.
 *  - Unqualified provider-native ID (e.g. `gpt-5.2`): the agent did not pick a
 *    provider. We look up configured catalog-backed providers whose catalog row
 *    has a matching `provider_model_id`. Zero matches => not found. One match
 *    => the catalog row. Two or more => ambiguous; we return the sorted
 *    candidate `route_id` list.
 *
 * The module does not load the catalog itself. Callers fetch
 * `ModelsListResponse` via `loadCatalog` and pass it in. The legacy static
 * `ProviderRegistry` is not consulted here.
 */

import { isCatalogBackedProvider } from "@/providers/provider-map";
import {
    type BrokerModelInfo,
    type ModelsListResponse,
    type ProviderId,
    providerIdValues,
} from "@/types/providers";

// === Input classification ===

/**
 * Discriminated union of unresolved CLI input shapes.
 *
 * - `exact_route_id`: input contained `/` and is intended to address a
 *   specific provider+model pair.
 * - `unqualified`: input has no `/`; the broker will search configured
 *   catalog-backed providers for a matching `provider_model_id`.
 */
export type UnresolvedRoute =
    | { kind: "exact_route_id"; route_id: string }
    | { kind: "unqualified"; providerModelId: string };

/**
 * Classifies a raw CLI input string. The classification is purely syntactic:
 * presence of `/` denotes an exact `route_id`, absence denotes an unqualified
 * provider-native ID. Validation of the provider and model portions happens
 * later in `resolveRoute`.
 */
export const classifyInput = (input: string): UnresolvedRoute => {
    if (input.includes("/")) {
        return { kind: "exact_route_id", route_id: input };
    }
    return { kind: "unqualified", providerModelId: input };
};

// === Route-id parsing / construction ===

/**
 * Result of parsing a `provider/modelId` string. Returned only when the input
 * is well-formed and the provider is a known `ProviderId`.
 */
type ParsedRouteId = { provider: ProviderId; providerModelId: string };

const providerIdSet: ReadonlySet<string> = new Set(providerIdValues);

/**
 * Parses a `provider/providerModelId` string. Returns `undefined` when:
 *
 *  - the string has no `/`
 *  - the part before `/` is not a known `ProviderId`
 *  - the part after `/` is empty
 */
export const parseRouteId = (routeId: string): ParsedRouteId | undefined => {
    if (!routeId.includes("/")) {
        return undefined;
    }
    const slashIndex = routeId.indexOf("/");
    const provider = routeId.slice(0, slashIndex);
    if (!providerIdSet.has(provider)) {
        return undefined;
    }
    const providerModelId = routeId.slice(slashIndex + 1);
    if (providerModelId.length === 0) {
        return undefined;
    }
    return {
        provider: provider as ProviderId,
        providerModelId,
    };
};

// === Result types ===

/** Returned when the unqualified search yields more than one configured match. */
export type AmbiguityError = {
    code: "ambiguous_model";
    input: string;
    candidates: string[];
    message: string;
};

/** Returned when the input cannot be resolved to a configured model. */
export type NotFoundError = {
    code: "model_not_found";
    input: string;
    message: string;
};

/** Successful resolution. */
export type ResolveRouteSuccess = { ok: true; value: BrokerModelInfo };

/** Failed resolution. */
export type ResolveRouteFailure = {
    ok: false;
    error: AmbiguityError | NotFoundError;
};

/** Result shape of `resolveRoute`. */
export type ResolveRouteResult = ResolveRouteSuccess | ResolveRouteFailure;

/** Options for `resolveRoute`. */
export type ResolveRouteOptions = {
    catalog: ModelsListResponse;
    configuredProviders: ReadonlySet<ProviderId>;
};

// === Resolution ===

const notConfiguredMessage = (
    input: string,
    provider: ProviderId,
): ResolveRouteFailure => ({
    ok: false,
    error: {
        code: "model_not_found",
        input,
        message: `Provider '${provider}' is not configured; cannot resolve '${input}'.`,
    },
});

const notInCatalogMessage = (input: string): ResolveRouteFailure => ({
    ok: false,
    error: {
        code: "model_not_found",
        input,
        message: `Model '${input}' was not found in the catalog; exact route IDs must match a catalog entry.`,
    },
});

const missingProviderMessage = (input: string): ResolveRouteFailure => ({
    ok: false,
    error: {
        code: "model_not_found",
        input,
        message: `Route ID '${input}' could not be parsed as provider/model.`,
    },
});

const ambiguousMessage = (
    input: string,
    candidates: string[],
): ResolveRouteFailure => ({
    ok: false,
    error: {
        code: "ambiguous_model",
        input,
        candidates,
        message: `Model '${input}' is exposed by multiple configured providers: ${candidates.join(
            ", ",
        )}. Use a fully qualified route_id.`,
    },
});

const unknownModelMessage = (input: string): ResolveRouteFailure => ({
    ok: false,
    error: {
        code: "model_not_found",
        input,
        message: `No configured provider exposes model '${input}'.`,
    },
});

/**
 * Resolves a classified CLI input to a `BrokerModelInfo`.
 *
 * Behavior:
 *
 *  - `exact_route_id`: parses the string. Catalog-backed providers must have
 *    the model in `catalog.providers[provider].models` and be in
 *    `configuredProviders`. Passthrough providers (`custom`, `gateway`) are
 *    accepted only when configured; a synthetic row is returned.
 *  - `unqualified`: searches configured catalog-backed providers for an exact
 *    `provider_model_id` match. Passthrough providers are not searched
 *    (their models are not catalogued).
 */
export const resolveRoute = (
    input: UnresolvedRoute,
    options: ResolveRouteOptions,
): ResolveRouteResult => {
    const { catalog, configuredProviders } = options;

    if (input.kind === "exact_route_id") {
        const parsed = parseRouteId(input.route_id);
        if (parsed === undefined) {
            return missingProviderMessage(input.route_id);
        }
        const { provider, providerModelId } = parsed;

        if (isCatalogBackedProvider(provider)) {
            if (!configuredProviders.has(provider)) {
                return notConfiguredMessage(input.route_id, provider);
            }
            const providerEntry = catalog.providers[provider];
            if (providerEntry?.status !== "catalog") {
                return notInCatalogMessage(input.route_id);
            }
            const match = providerEntry.models.find(
                (m) => m.provider_model_id === providerModelId,
            );
            if (match === undefined) {
                return notInCatalogMessage(input.route_id);
            }
            return { ok: true, value: match };
        }

        // Passthrough provider (custom, gateway).
        if (!configuredProviders.has(provider)) {
            return notConfiguredMessage(input.route_id, provider);
        }
        const synthetic: BrokerModelInfo = {
            route_id: input.route_id,
            provider,
            provider_model_id: providerModelId,
            display_name: providerModelId,
        };
        return { ok: true, value: synthetic };
    }

    // Unqualified: search configured catalog-backed providers.
    const matches: BrokerModelInfo[] = [];
    for (const provider of configuredProviders) {
        if (!isCatalogBackedProvider(provider)) {
            continue;
        }
        const providerEntry = catalog.providers[provider];
        if (providerEntry?.status !== "catalog") {
            continue;
        }
        for (const model of providerEntry.models) {
            if (model.provider_model_id === input.providerModelId) {
                matches.push(model);
            }
        }
    }

    if (matches.length === 0) {
        return unknownModelMessage(input.providerModelId);
    }
    if (matches.length === 1) {
        return { ok: true, value: matches[0] };
    }
    const candidates = matches
        .map((m) => m.route_id)
        .sort((a, b) => a.localeCompare(b));
    return ambiguousMessage(input.providerModelId, candidates);
};

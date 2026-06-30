/**
 * Broker module for the models.dev model catalog.
 *
 * Responsibilities:
 * - Fetch `https://models.dev/catalog.json` with timeout, content-type and
 *   size guards, and JSON validation.
 * - Read and write a local cache (`configDir/models-cache/`) using atomic
 *   temp+rename semantics.
 * - Normalize raw provider entries into the public `BrokerModelInfo` shape
 *   and resolve each row's `canonical_model_id` against the catalog's
 *   top-level `models` map.
 * - Compose the `models.list/1` response payload the `list-models` command
 *   consumes.
 *
 * All I/O seams (`fetchFn`, `reader`, `writer`) and the clock (`now`) are
 * injected so the module can be exercised in unit tests without touching the
 * network or the real filesystem.
 */

import { resolve } from "node:path";

import {
    type BrokerModelInfo,
    BrokerModelInfoSchema,
    type CacheMetadata,
    CacheMetadataSchema,
    type CacheStatus,
    CacheStatusSchema,
    type CatalogJson,
    CatalogJsonSchema,
    type ModelsListResponse,
    ModelsListResponseSchema,
    type ProviderCatalog,
    ProviderCatalogSchema,
    type ProviderId,
    type ProviderListEntry,
    ProviderModelEntrySchema,
    providerIdValues,
} from "@/types/providers";
import { getErrorMessage } from "@/utils";
import pkg from "../../package.json";
import {
    getModelsDevProviderKey,
    isCatalogBackedProvider,
} from "./provider-map";

// === Constants ===

export const MODELS_DEV_CATALOG_URL = "https://models.dev/catalog.json";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const CACHE_SCHEMA = "models-cache/1";

export const DEFAULT_USER_AGENT = `@zaherg/chorus/${pkg.version}`;

// === I/O seam types ===

export type FetchFn = (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

export type FileReader = (
    path: string,
) => { ok: true; text: string } | { ok: false; code: "missing" | "io_error" };

export type FileWriter = (
    path: string,
    content: string,
    options: { mode?: number; tempSuffix?: string },
) => { ok: true } | { ok: false; code: "io_error"; message: string };

export type FetchCatalogErrorCode =
    | "network"
    | "timeout"
    | "http_status"
    | "content_type"
    | "oversized"
    | "invalid_json"
    | "schema_invalid";

export type FetchCatalogError = {
    code: FetchCatalogErrorCode;
    message: string;
};

export type FetchCatalogSuccess = {
    ok: true;
    catalog: unknown;
    fetchedAt: string;
    source: string;
};

export type FetchCatalogResult =
    | FetchCatalogSuccess
    | { ok: false; error: FetchCatalogError };

export type ReadCacheStatus = "fresh" | "stale" | "missing" | "invalid";

export type ReadCacheResult = {
    status: ReadCacheStatus;
    metadata?: CacheMetadata;
    catalog?: unknown;
    reason?: string;
};

// === Path helpers ===
//
// Path helpers use `node:path` `resolve` so they fold `configDir` with the
// cache file name. The internal `readCache` / `writeCache` functions emit
// the relative path constants below; the caller's reader/writer pairs fold
// the relative path against the actual `configDir` at the I/O seam.

export const CACHE_DIR_NAME = "models-cache";
export const CATALOG_FILE_NAME = "catalog.json";
export const METADATA_FILE_NAME = "metadata.json";
export const CATALOG_RELATIVE_PATH = `${CACHE_DIR_NAME}/${CATALOG_FILE_NAME}`;
export const METADATA_RELATIVE_PATH = `${CACHE_DIR_NAME}/${METADATA_FILE_NAME}`;

export const getModelsCacheDir = (configDir: string): string =>
    resolve(configDir, CACHE_DIR_NAME);

export const getCatalogPath = (configDir: string): string =>
    resolve(getModelsCacheDir(configDir), CATALOG_FILE_NAME);

export const getMetadataPath = (configDir: string): string =>
    resolve(getModelsCacheDir(configDir), METADATA_FILE_NAME);

// === Fetch ===

const isAbortLikeError = (err: unknown): boolean => {
    if (!(err instanceof Error)) {
        return false;
    }
    return err.name === "AbortError" || err.name === "TimeoutError";
};

export const fetchCatalog = async (
    fetchFn: FetchFn,
    now: () => Date = () => new Date(),
    options: { timeoutMs?: number; userAgent?: string } = {},
): Promise<FetchCatalogResult> => {
    const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
    };
    const signal = AbortSignal.timeout(
        options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    );

    let response: Response;
    try {
        response = await fetchFn(MODELS_DEV_CATALOG_URL, { headers, signal });
    } catch (err) {
        if (isAbortLikeError(err)) {
            return {
                ok: false,
                error: { code: "timeout", message: getErrorMessage(err) },
            };
        }
        return {
            ok: false,
            error: { code: "network", message: getErrorMessage(err) },
        };
    }

    if (!response.ok) {
        return {
            ok: false,
            error: {
                code: "http_status",
                message: `unexpected status ${response.status}`,
            },
        };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
        return {
            ok: false,
            error: {
                code: "content_type",
                message: `unexpected content-type: ${contentType || "<missing>"}`,
            },
        };
    }

    // Check Content-Length header early to avoid reading oversized responses.
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
        const length = Number.parseInt(contentLength, 10);
        if (!Number.isNaN(length) && length > MAX_RESPONSE_BYTES) {
            return {
                ok: false,
                error: {
                    code: "oversized",
                    message: `Content-Length ${length} exceeds limit ${MAX_RESPONSE_BYTES}`,
                },
            };
        }
    }

    // Read body with a chunked reader so we never load the full payload
    // into memory before checking size.
    let body = "";
    let totalBytes = 0;
    const reader = response.body?.getReader();
    if (reader) {
        const decoder = new TextDecoder();
        try {
            let done = false;
            while (!done) {
                // eslint-disable-next-line no-await-in-loop
                const chunk = await reader.read();
                done = chunk.done;
                if (chunk.value) {
                    totalBytes += chunk.value.byteLength;
                    if (totalBytes > MAX_RESPONSE_BYTES) {
                        reader.cancel();
                        return {
                            ok: false,
                            error: {
                                code: "oversized",
                                message: `response body exceeds limit ${MAX_RESPONSE_BYTES}`,
                            },
                        };
                    }
                    body += decoder.decode(chunk.value, { stream: !done });
                }
            }
            // Flush decoder for any remaining bytes.
            body += decoder.decode();
        } catch (err) {
            reader.cancel().catch(() => {});
            return {
                ok: false,
                error: { code: "network", message: getErrorMessage(err) },
            };
        }
    } else {
        // Fallback when body stream is unavailable (should not happen in Bun).
        body = await response.text();
        const byteLength = Buffer.byteLength(body, "utf8");
        if (byteLength > MAX_RESPONSE_BYTES) {
            return {
                ok: false,
                error: {
                    code: "oversized",
                    message: `response body ${byteLength} bytes exceeds limit ${MAX_RESPONSE_BYTES}`,
                },
            };
        }
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch (err) {
        return {
            ok: false,
            error: { code: "invalid_json", message: getErrorMessage(err) },
        };
    }

    const validation = CatalogJsonSchema.safeParse(parsed);
    if (!validation.success) {
        return {
            ok: false,
            error: {
                code: "schema_invalid",
                message: validation.error.issues
                    .map(
                        (issue) =>
                            `${issue.path.join(".") || "<root>"}: ${issue.message}`,
                    )
                    .join("; "),
            },
        };
    }

    return {
        ok: true,
        catalog: validation.data,
        fetchedAt: now().toISOString(),
        source: MODELS_DEV_CATALOG_URL,
    };
};

// === Cache read ===

export const readCache = (
    reader: FileReader,
    now: () => Date = () => new Date(),
): ReadCacheResult => {
    const metadataPath = METADATA_RELATIVE_PATH;
    const metaResult = reader(metadataPath);
    if (!metaResult.ok) {
        return { status: "missing" };
    }

    let metaParsed: unknown;
    try {
        metaParsed = JSON.parse(metaResult.text);
    } catch {
        return { status: "invalid", reason: "metadata schema" };
    }

    const metaValidation = CacheMetadataSchema.safeParse(metaParsed);
    if (!metaValidation.success) {
        return { status: "invalid", reason: "metadata schema" };
    }
    const metadata = metaValidation.data;

    const catalogPath = CATALOG_RELATIVE_PATH;
    const catalogResult = reader(catalogPath);
    if (!catalogResult.ok) {
        return { status: "invalid", reason: "catalog missing" };
    }

    let catalogParsed: unknown;
    try {
        catalogParsed = JSON.parse(catalogResult.text);
    } catch {
        return { status: "invalid", reason: "catalog schema" };
    }

    const catalogValidation = CatalogJsonSchema.safeParse(catalogParsed);
    if (!catalogValidation.success) {
        return { status: "invalid", reason: "catalog schema" };
    }

    const expiresAtMs = Date.parse(metadata.expires_at);
    if (Number.isFinite(expiresAtMs) && expiresAtMs > now().getTime()) {
        return { status: "fresh", metadata, catalog: catalogValidation.data };
    }
    return { status: "stale", metadata, catalog: catalogValidation.data };
};

// === Cache write ===

export const writeCache = (
    writer: FileWriter,
    catalog: unknown,
    metadata: CacheMetadata,
): { ok: true } | { ok: false; code: "io_error"; message: string } => {
    const catalogPath = CATALOG_RELATIVE_PATH;
    const metadataPath = METADATA_RELATIVE_PATH;
    const mode = 0o600;
    const tempSuffix = ".tmp";

    let catalogJson: string;
    let metadataJson: string;
    try {
        catalogJson = JSON.stringify(catalog);
        metadataJson = JSON.stringify(metadata);
    } catch (err) {
        return {
            ok: false,
            code: "io_error",
            message: getErrorMessage(err),
        };
    }

    const catalogResult = writer(catalogPath, catalogJson, {
        mode,
        tempSuffix,
    });
    if (!catalogResult.ok) {
        return catalogResult;
    }

    return writer(metadataPath, metadataJson, { mode, tempSuffix });
};

// === Normalization ===

const finitePositive = (value: number | undefined): number | undefined => {
    if (value === undefined) {
        return undefined;
    }
    if (!Number.isFinite(value) || value <= 0) {
        return undefined;
    }
    return value;
};

const findCanonicalModelId = (
    modelId: string,
    modelsDevProviderKey: string,
    canonicalModels: Record<string, unknown>,
): string | undefined => {
    for (const [key, value] of Object.entries(canonicalModels)) {
        if (value === null || typeof value !== "object") {
            continue;
        }
        const record = value as { id?: unknown; provider?: unknown };
        if (record.id === modelId && record.provider === modelsDevProviderKey) {
            return key;
        }
    }
    return undefined;
};

export const normalizeProviderModels = (
    providerId: ProviderId,
    modelsDevProviderKey: string,
    providerCatalog: ProviderCatalog,
    canonicalModels: Record<string, unknown>,
): BrokerModelInfo[] => {
    const out: BrokerModelInfo[] = [];
    for (const [modelId, rawEntry] of Object.entries(providerCatalog.models)) {
        const entryValidation = ProviderModelEntrySchema.safeParse(rawEntry);
        if (!entryValidation.success) {
            continue;
        }
        const entry = entryValidation.data;

        const canonical = findCanonicalModelId(
            modelId,
            modelsDevProviderKey,
            canonicalModels,
        );

        const candidate = {
            route_id: `${providerId}/${modelId}`,
            provider: providerId,
            provider_model_id: modelId,
            display_name: entry.name ?? modelId,
            context_window: finitePositive(entry.limit?.context),
            output_limit: finitePositive(entry.limit?.output),
            supports_reasoning: entry.reasoning,
            supports_tools: entry.tool_call,
            supports_structured_output: entry.structured_output,
            ...(canonical !== undefined
                ? { canonical_model_id: canonical }
                : {}),
        };

        const validation = BrokerModelInfoSchema.safeParse(candidate);
        if (!validation.success) {
            continue;
        }
        out.push(validation.data);
    }
    out.sort((a, b) => a.provider_model_id.localeCompare(b.provider_model_id));
    return out;
};

// === High-level orchestrator ===

export type LoadCatalogOptions = {
    configDir: string;
    fetchFn: FetchFn;
    reader: FileReader;
    writer: FileWriter;
    now?: () => Date;
    forceRefresh?: boolean;
    userAgent?: string;
    timeoutMs?: number;
};

export type LoadCatalogSuccess = {
    ok: true;
    schema: "models.list/1";
    cache: { status: CacheStatus; fetched_at: string; expires_at: string };
    providers: Record<ProviderId, ProviderListEntry>;
    warning?: string;
};

export type LoadCatalogFailure = {
    ok: false;
    error: { code: "catalog_unavailable"; message: string };
};

export type LoadCatalogResult = LoadCatalogSuccess | LoadCatalogFailure;

const buildMetadata = (
    fetchedAt: string,
    source: string,
    now: () => Date,
): CacheMetadata => {
    const expiresAt = new Date(now().getTime() + CACHE_TTL_MS).toISOString();
    return {
        schema: CACHE_SCHEMA,
        fetched_at: fetchedAt,
        expires_at: expiresAt,
        source,
    };
};

const buildProviderEntry = (
    providerId: ProviderId,
    catalog: CatalogJson,
): ProviderListEntry => {
    if (!isCatalogBackedProvider(providerId)) {
        return { status: "passthrough", models: [] };
    }
    const modelsDevKey = getModelsDevProviderKey(providerId);
    if (modelsDevKey === undefined) {
        return { status: "passthrough", models: [] };
    }
    const rawProvider = catalog.providers[modelsDevKey];
    if (rawProvider === undefined) {
        return { status: "catalog", models: [] };
    }
    const providerCatalogValidation =
        ProviderCatalogSchema.safeParse(rawProvider);
    if (!providerCatalogValidation.success) {
        return { status: "catalog", models: [] };
    }
    return {
        status: "catalog",
        models: normalizeProviderModels(
            providerId,
            modelsDevKey,
            providerCatalogValidation.data,
            catalog.models,
        ),
    };
};

// In-flight promise deduplicator: concurrent callers to loadCatalog
// await the same shared promise, preventing cache-write races and
// redundant parallel fetches from the upstream catalog URL.
let loadCatalogDedup: Map<string, Promise<LoadCatalogResult>> = new Map();

export const loadCatalog = async (
    options: LoadCatalogOptions,
): Promise<LoadCatalogResult> => {
    const dedupKey = `${options.configDir}::${!!options.forceRefresh}`;
    if (loadCatalogDedup.has(dedupKey)) {
        return loadCatalogDedup.get(dedupKey)!;
    }

    const impl = async (): Promise<LoadCatalogResult> => {
        const {
            fetchFn,
            reader,
            writer,
            now = () => new Date(),
            forceRefresh = false,
            userAgent,
            timeoutMs,
        } = options;

        const cacheState = readCache(reader, now);

        let activeCatalog: unknown;
        let activeMetadata: CacheMetadata | undefined;
        let warning: string | undefined;
        let cacheStatusValue: CacheStatus = "stale";

        if (
            !forceRefresh &&
            cacheState.status === "fresh" &&
            cacheState.metadata &&
            cacheState.catalog !== undefined
        ) {
            activeCatalog = cacheState.catalog;
            activeMetadata = cacheState.metadata;
            cacheStatusValue = "fresh";
        } else {
            const fetched = await fetchCatalog(fetchFn, now, {
                userAgent,
                timeoutMs,
            });
            if (!fetched.ok) {
                if (
                    cacheState.status === "stale" &&
                    cacheState.metadata &&
                    cacheState.catalog !== undefined
                ) {
                    activeCatalog = cacheState.catalog;
                    activeMetadata = cacheState.metadata;
                    warning = fetched.error.message;
                    cacheStatusValue = "stale";
                } else {
                    return {
                        ok: false,
                        error: {
                            code: "catalog_unavailable",
                            message: fetched.error.message,
                        },
                    };
                }
            } else {
                activeCatalog = fetched.catalog;
                const fetchedAt = fetched.fetchedAt;
                activeMetadata = buildMetadata(fetchedAt, fetched.source, now);
                const writeResult = writeCache(
                    writer,
                    activeCatalog,
                    activeMetadata,
                );
                if (!writeResult.ok) {
                    return {
                        ok: false,
                        error: {
                            code: "catalog_unavailable",
                            message: `cache write failed: ${writeResult.message}`,
                        },
                    };
                }
                cacheStatusValue = "fresh";
            }
        }

        if (!activeMetadata) {
            return {
                ok: false,
                error: {
                    code: "catalog_unavailable",
                    message: "no catalog available",
                },
            };
        }

        const validation = CatalogJsonSchema.safeParse(activeCatalog);
        if (!validation.success) {
            return {
                ok: false,
                error: {
                    code: "catalog_unavailable",
                    message: "catalog payload failed schema validation",
                },
            };
        }
        const catalog = validation.data;

        const providers = {} as Record<ProviderId, ProviderListEntry>;
        for (const providerId of providerIdValues) {
            providers[providerId] = buildProviderEntry(providerId, catalog);
        }

        const cacheStatusChecked = CacheStatusSchema.parse(cacheStatusValue);

        const payload: ModelsListResponse = {
            schema: "models.list/1",
            cache: {
                status: cacheStatusChecked,
                fetched_at: activeMetadata.fetched_at,
                expires_at: activeMetadata.expires_at,
            },
            providers,
        };

        const payloadValidation = ModelsListResponseSchema.safeParse(payload);
        if (!payloadValidation.success) {
            return {
                ok: false,
                error: {
                    code: "catalog_unavailable",
                    message: "list-models payload failed schema validation",
                },
            };
        }

        const result: LoadCatalogSuccess = {
            ok: true,
            schema: "models.list/1",
            cache: payloadValidation.data.cache,
            providers: payloadValidation.data.providers as Record<
                ProviderId,
                ProviderListEntry
            >,
        };
        if (warning !== undefined) {
            result.warning = warning;
        }
        return result;
    }; // end impl

    const promise = impl();
    loadCatalogDedup.set(dedupKey, promise);
    try {
        return await promise;
    } finally {
        if (loadCatalogDedup.get(dedupKey) === promise) {
            loadCatalogDedup.delete(dedupKey);
        }
    }
};

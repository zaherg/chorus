import { describe, expect, test } from "bun:test";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { makeLocalFileReader, makeLocalFileWriter, resolveCachePath } from "@/providers/cache-fs";
import {
    CACHE_SCHEMA,
    CATALOG_RELATIVE_PATH,
    type FetchFn,
    type FileReader,
    type FileWriter,
    fetchCatalog,
    loadCatalog,
    MAX_RESPONSE_BYTES,
    METADATA_RELATIVE_PATH,
    MODELS_DEV_CATALOG_URL,
    normalizeProviderModels,
    readCache,
    writeCache,
} from "@/providers/model-catalog";
import { ProviderCatalogSchema } from "@/types/providers";
import fixture from "./fixtures/models-dev-catalog.fixture.json" with { type: "json" };

// === Fixtures and helpers ===

const noopReader: FileReader = () => ({ ok: false, code: "missing" });

const okJsonResponse = (
    body: unknown,
    init: { status?: number; contentType?: string | null; etag?: string } = {},
): Response => {
    const status = init.status ?? 200;
    const headers = new Headers();
    if (init.contentType !== null) {
        headers.set("content-type", init.contentType ?? "application/json");
    }
    if (init.etag !== undefined) {
        headers.set("etag", init.etag);
    }
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers,
    });
};

const makeFetch = (
    response: Response | Error,
): {
    fn: FetchFn;
    calls: Array<{
        url: string;
        init: { headers: Record<string, string>; signal: AbortSignal };
    }>;
} => {
    const calls: Array<{
        url: string;
        init: { headers: Record<string, string>; signal: AbortSignal };
    }> = [];
    const fn: FetchFn = async (url, init) => {
        calls.push({ url, init });
        if (response instanceof Error) {
            throw response;
        }
        return response;
    };
    return { fn, calls };
};

const makeReader = (files: Record<string, string | { code: "missing" | "io_error" }>): FileReader => {
    return (path) => {
        const value = files[path];
        if (value === undefined) {
            return { ok: false, code: "missing" };
        }
        if (typeof value === "string") {
            return { ok: true, text: value };
        }
        return { ok: false, code: value.code };
    };
};

const makeWriter = (): {
    writer: FileWriter;
    calls: Array<{
        path: string;
        content: string;
        options: { mode?: number; tempSuffix?: string };
    }>;
} => {
    const calls: Array<{
        path: string;
        content: string;
        options: { mode?: number; tempSuffix?: string };
    }> = [];
    const writer: FileWriter = (path, content, options) => {
        calls.push({ path, content, options });
        return { ok: true };
    };
    return { writer, calls };
};

const freshMetadata = (fetchedAt: string, expiresAt: string, etag?: string) => ({
    schema: CACHE_SCHEMA as "models-cache/1",
    fetched_at: fetchedAt,
    expires_at: expiresAt,
    source: MODELS_DEV_CATALOG_URL,
    ...(etag !== undefined ? { etag } : {}),
});

// === describe("model-catalog") ===

describe("model-catalog", () => {
    describe("fetchCatalog", () => {
        test("returns success and validates the catalog on a valid 2xx JSON response", async () => {
            const { fn, calls } = makeFetch(okJsonResponse(fixture));
            const result = await fetchCatalog(fn, () => new Date("2026-02-01T00:00:00Z"));
            expect(calls).toHaveLength(1);
            expect(calls[0]?.url).toBe(MODELS_DEV_CATALOG_URL);
            if (!result.ok) {
                throw new Error(`expected ok, got ${JSON.stringify(result)}`);
            }
            expect(result.fetchedAt).toBe("2026-02-01T00:00:00.000Z");
            expect(result.source).toBe(MODELS_DEV_CATALOG_URL);
            expect(result.catalog).toBeDefined();
        });

        test("returns { ok: false, code: 'timeout' } when the fetch function throws AbortError", async () => {
            const abortError = new Error("aborted");
            abortError.name = "AbortError";
            const { fn } = makeFetch(abortError);
            const result = await fetchCatalog(fn);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.code).toBe("timeout");
        });

        test("returns { ok: false, code: 'http_status' } on a 4xx response", async () => {
            const { fn } = makeFetch(okJsonResponse({ error: "x" }, { status: 404 }));
            const result = await fetchCatalog(fn);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.code).toBe("http_status");
            expect(result.error.message).toContain("404");
        });

        test("returns { ok: false, code: 'content_type' } when content-type is text/html", async () => {
            const { fn } = makeFetch(okJsonResponse({}, { contentType: "text/html" }));
            const result = await fetchCatalog(fn);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.code).toBe("content_type");
        });

        test("returns { ok: false, code: 'oversized' } when body exceeds MAX_RESPONSE_BYTES", async () => {
            const huge = "x".repeat(MAX_RESPONSE_BYTES + 1);
            const { fn } = makeFetch(okJsonResponse(huge));
            const result = await fetchCatalog(fn);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.code).toBe("oversized");
        });

        test("rejects immediately before reading body stream when Content-Length exceeds MAX_RESPONSE_BYTES", async () => {
            let bodyRead = false;
            const stream = new ReadableStream<Uint8Array>(
                {
                    pull() {
                        bodyRead = true;
                    },
                },
                { highWaterMark: 0 },
            );
            const response = new Response(stream, {
                status: 200,
                headers: {
                    "content-type": "application/json",
                    "content-length": String(MAX_RESPONSE_BYTES + 1),
                },
            });
            const { fn } = makeFetch(response);

            const result = await fetchCatalog(fn);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.code).toBe("oversized");
            expect(result.error.message).toContain("Content-Length");
            expect(bodyRead).toBe(false);
            expect(response.bodyUsed).toBe(false);
        });

        test("returns { ok: false, code: 'invalid_json' } on JSON parse failure", async () => {
            const { fn } = makeFetch(okJsonResponse("{not json"));
            const result = await fetchCatalog(fn);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.code).toBe("invalid_json");
        });

        test("returns { ok: false, code: 'schema_invalid' } when top-level providers is missing", async () => {
            const { fn } = makeFetch(okJsonResponse({ models: {} }));
            const result = await fetchCatalog(fn);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.code).toBe("schema_invalid");
        });

        test("returns { ok: false, code: 'timeout' } when stream reader throws AbortError", async () => {
            const stream = new ReadableStream<Uint8Array>({
                pull() {
                    const abortError = new Error("stream timed out");
                    abortError.name = "TimeoutError";
                    throw abortError;
                },
            });
            const response = new Response(stream, {
                status: 200,
                headers: { "content-type": "application/json" },
            });
            const { fn } = makeFetch(response);
            const result = await fetchCatalog(fn);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.code).toBe("timeout");
            expect(result.error.message).toContain("stream timed out");
        });

        test("catches response.text() failures cleanly when body stream is unavailable", async () => {
            const makeStreamlessResponse = (err: Error) =>
                ({
                    ok: true,
                    status: 200,
                    headers: new Headers({ "content-type": "application/json" }),
                    body: null,
                    text: async () => {
                        throw err;
                    },
                }) as unknown as Response;

            const netFetch = makeFetch(makeStreamlessResponse(new Error("socket reset")));
            const netResult = await fetchCatalog(netFetch.fn);
            expect(netResult.ok).toBe(false);
            if (!netResult.ok) {
                expect(netResult.error.code).toBe("network");
                expect(netResult.error.message).toContain("socket reset");
            }

            const abortError = new Error("text read aborted");
            abortError.name = "AbortError";
            const abortFetch = makeFetch(makeStreamlessResponse(abortError));
            const abortResult = await fetchCatalog(abortFetch.fn);
            expect(abortResult.ok).toBe(false);
            if (!abortResult.ok) {
                expect(abortResult.error.code).toBe("timeout");
                expect(abortResult.error.message).toContain("text read aborted");
            }
        });

        test("returns { ok: false, code: 'timeout' } when fetch rejects with a wrapped TimeoutError cause", async () => {
            const wrappedTimeout = new TypeError("fetch failed", {
                cause: new DOMException("The operation timed out.", "TimeoutError"),
            });
            const { fn: failingFetch } = makeFetch(wrappedTimeout);
            const wrappedResult = await fetchCatalog(failingFetch);
            expect(wrappedResult.ok).toBe(false);
            if (!wrappedResult.ok) {
                expect(wrappedResult.error.code).toBe("timeout");
            }
        });
    });

    describe("readCache", () => {
        test("returns status: 'missing' when neither metadata nor catalog exist", () => {
            const result = readCache(noopReader);
            expect(result.status).toBe("missing");
        });

        test("returns fresh or stale based on expiry date relative to now", () => {
            const now = new Date("2026-06-01T12:00:00Z");
            const cases = [
                {
                    fetched: "2026-01-01T00:00:00.000Z",
                    expires: "2027-01-01T00:00:00.000Z",
                    status: "fresh",
                },
                {
                    fetched: "2025-01-01T00:00:00.000Z",
                    expires: "2025-06-01T00:00:00.000Z",
                    status: "stale",
                },
            ] as const;
            for (const { fetched, expires, status } of cases) {
                const metadata = freshMetadata(fetched, expires);
                const reader = makeReader({
                    [METADATA_RELATIVE_PATH]: JSON.stringify(metadata),
                    [CATALOG_RELATIVE_PATH]: JSON.stringify(fixture),
                });
                const result = readCache(reader, () => now);
                expect(result.status).toBe(status);
            }
        });

        test("returns status: 'invalid' when metadata fails schema validation", () => {
            const reader = makeReader({
                [METADATA_RELATIVE_PATH]: JSON.stringify({ schema: "wrong" }),
                [CATALOG_RELATIVE_PATH]: JSON.stringify(fixture),
            });
            const result = readCache(reader);
            expect(result.status).toBe("invalid");
            expect(result.reason).toBe("metadata schema");
        });
    });

    describe("writeCache", () => {
        test("writes both files and applies mode 0o600", () => {
            const { writer, calls } = makeWriter();
            const metadata = freshMetadata("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
            const result = writeCache(writer, fixture, metadata);
            expect(result.ok).toBe(true);
            const catalogPath = CATALOG_RELATIVE_PATH;
            const metadataPath = METADATA_RELATIVE_PATH;
            const paths = calls.map((c) => c.path);
            expect(paths).toEqual([catalogPath, metadataPath]);
            for (const call of calls) {
                expect(call.options.mode).toBe(0o600);
                expect(call.options.tempSuffix).toBe(".tmp");
            }
        });
    });

    describe("normalizeProviderModels", () => {
        test("produces executable route_id values and copies capability fields when present", () => {
            const openrouterRaw = (fixture as { providers: { openrouter: unknown } }).providers.openrouter;
            const providerCatalog = ProviderCatalogSchema.parse(openrouterRaw);
            const models = normalizeProviderModels(
                "openrouter",
                "openrouter",
                providerCatalog,
                (fixture as { models: Record<string, unknown> }).models,
            );
            const claude = models.find((m) => m.provider_model_id === "anthropic/claude-sonnet-4.5");
            expect(claude).toBeDefined();
            expect(claude?.route_id).toBe("openrouter/anthropic/claude-sonnet-4.5");
            expect(claude?.display_name).toBe("Claude Sonnet 4.5 (OpenRouter)");
            expect(claude?.context_window).toBe(200000);
            expect(claude?.output_limit).toBe(8192);
            expect(claude?.supports_reasoning).toBe(true);
            expect(claude?.supports_tools).toBe(true);
            expect(claude?.supports_structured_output).toBe(false);
            expect(claude?.canonical_model_id).toBe("openrouter/anthropic/claude-sonnet-4.5");
        });

        test("omits optional capability fields when absent in the catalog entry", () => {
            const providerCatalog = ProviderCatalogSchema.parse({
                models: {
                    "no-caps": { name: "Bare" },
                },
            });
            const models = normalizeProviderModels("openrouter", "openrouter", providerCatalog, {});
            expect(models).toHaveLength(1);
            const m = models[0];
            if (!m) throw new Error("expected a model");
            expect(m.route_id).toBe("openrouter/no-caps");
            expect(m.display_name).toBe("Bare");
            expect(m.context_window).toBeUndefined();
            expect(m.output_limit).toBeUndefined();
            expect(m.supports_reasoning).toBeUndefined();
            expect(m.supports_tools).toBeUndefined();
            expect(m.supports_structured_output).toBeUndefined();
            expect(m.canonical_model_id).toBeUndefined();
        });

        test("resolves canonical_model_id only by exact id+provider match, not suffix match", () => {
            const providerCatalog = ProviderCatalogSchema.parse({
                models: {
                    "anthropic/claude-sonnet-4.5": {
                        name: "Claude Sonnet 4.5",
                    },
                },
            });
            const canonicalModels = {
                "openrouter/anthropic/claude-sonnet-4.5-mini": {
                    id: "anthropic/claude-sonnet-4.5-mini",
                    provider: "openrouter",
                },
                "openrouter/x-anthropic/claude-sonnet-4.5": {
                    id: "x-anthropic/claude-sonnet-4.5",
                    provider: "openrouter",
                },
                "wrong-provider/anthropic/claude-sonnet-4.5": {
                    id: "anthropic/claude-sonnet-4.5",
                    provider: "anthropic",
                },
            };
            const models = normalizeProviderModels("openrouter", "openrouter", providerCatalog, canonicalModels);
            expect(models).toHaveLength(1);
            expect(models[0]?.canonical_model_id).toBeUndefined();
        });

        test("skips a single malformed model entry without wiping out sibling valid models", () => {
            const providerCatalog = ProviderCatalogSchema.parse({
                models: {
                    "broken-model": { name: 12345, reasoning: "yes" },
                    "null-entry": null,
                    "good-model": {
                        name: "Good Model",
                        limit: { context: 128000, output: 4096 },
                        reasoning: true,
                    },
                },
            });
            const models = normalizeProviderModels("openrouter", "openrouter", providerCatalog, {});
            expect(models).toHaveLength(1);
            expect(models[0]?.provider_model_id).toBe("good-model");
            expect(models[0]?.display_name).toBe("Good Model");
            expect(models[0]?.context_window).toBe(128000);
            expect(models[0]?.output_limit).toBe(4096);
            expect(models[0]?.supports_reasoning).toBe(true);
        });

        test("tolerates null optional fields on model entries", () => {
            const providerCatalog = ProviderCatalogSchema.parse({
                models: {
                    "nullable-fields": {
                        name: null,
                        limit: { context: null, output: null },
                        reasoning: null,
                        tool_call: null,
                        structured_output: null,
                    },
                    "null-limit": {
                        name: "Null Limit",
                        limit: null,
                    },
                },
            });
            const models = normalizeProviderModels("openrouter", "openrouter", providerCatalog, {});
            expect(models).toHaveLength(2);
            const first = models.find((m) => m.provider_model_id === "nullable-fields");
            expect(first).toBeDefined();
            expect(first?.display_name).toBe("nullable-fields");
            expect(first?.context_window).toBeUndefined();
            expect(first?.output_limit).toBeUndefined();
            expect(first?.supports_reasoning).toBeUndefined();
            expect(first?.supports_tools).toBeUndefined();
            expect(first?.supports_structured_output).toBeUndefined();

            const second = models.find((m) => m.provider_model_id === "null-limit");
            expect(second).toBeDefined();
            expect(second?.display_name).toBe("Null Limit");
            expect(second?.context_window).toBeUndefined();
        });

        test("omits non-integer limit.context and limit.output without dropping the model", () => {
            const providerCatalog = ProviderCatalogSchema.parse({
                models: {
                    "float-limits": {
                        name: "Float Limits",
                        limit: { context: 128000.5, output: 4096.25 },
                    },
                },
            });
            const models = normalizeProviderModels("openrouter", "openrouter", providerCatalog, {});
            expect(models).toHaveLength(1);
            expect(models[0]?.provider_model_id).toBe("float-limits");
            expect(models[0]?.context_window).toBeUndefined();
            expect(models[0]?.output_limit).toBeUndefined();
        });
    });

    describe("loadCatalog", () => {
        const now = () => new Date("2026-06-01T00:00:00Z");

        test("with fresh cache skips the network", async () => {
            const metadata = freshMetadata("2026-05-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z");
            const reader = makeReader({
                [METADATA_RELATIVE_PATH]: JSON.stringify(metadata),
                [CATALOG_RELATIVE_PATH]: JSON.stringify(fixture),
            });
            const { writer, calls } = makeWriter();
            const fetchError = new Error("should not fetch");
            const { fn: fetchFn } = makeFetch(fetchError);
            const result = await loadCatalog({
                configDir: "/etc/zaher",
                fetchFn,
                reader,
                writer,
                now,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.cache.status).toBe("fresh");
            expect(calls).toHaveLength(0);
        });

        test("with expired cache triggers a fetch and writes new metadata", async () => {
            const stale = freshMetadata("2025-01-01T00:00:00.000Z", "2025-06-01T00:00:00.000Z");
            const reader = makeReader({
                [METADATA_RELATIVE_PATH]: JSON.stringify(stale),
                [CATALOG_RELATIVE_PATH]: JSON.stringify(fixture),
            });
            const { writer, calls } = makeWriter();
            const { fn: fetchFn } = makeFetch(okJsonResponse(fixture));
            const result = await loadCatalog({
                configDir: "/etc/zaher",
                fetchFn,
                reader,
                writer,
                now,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.cache.status).toBe("fresh");
            expect(calls).toHaveLength(2);
            const metadataCall = calls[1];
            if (!metadataCall) throw new Error("expected metadata call");
            const written = JSON.parse(metadataCall.content);
            expect(written.schema).toBe(CACHE_SCHEMA);
            expect(written.fetched_at).toBe("2026-06-01T00:00:00.000Z");
            expect(written.expires_at).toBe("2026-06-02T00:00:00.000Z");
        });

        test("with no cache and fetch failure returns catalog_unavailable", async () => {
            const fetchError = new Error("network down");
            const { fn: fetchFn } = makeFetch(fetchError);
            const { writer } = makeWriter();
            const result = await loadCatalog({
                configDir: "/etc/zaher",
                fetchFn,
                reader: noopReader,
                writer,
                now,
            });
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.code).toBe("catalog_unavailable");
            expect(result.error.message).toContain("network down");
        });

        test("with stale cache and fetch failure returns stale catalog with warning", async () => {
            const stale = freshMetadata("2025-01-01T00:00:00.000Z", "2025-06-01T00:00:00.000Z");
            const reader = makeReader({
                [METADATA_RELATIVE_PATH]: JSON.stringify(stale),
                [CATALOG_RELATIVE_PATH]: JSON.stringify(fixture),
            });
            const { writer } = makeWriter();
            const fetchError = new Error("refresh failed");
            fetchError.name = "AbortError";
            const { fn: fetchFn } = makeFetch(fetchError);
            const result = await loadCatalog({
                configDir: "/etc/zaher",
                fetchFn,
                reader,
                writer,
                now,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.cache.status).toBe("stale");
            expect(result.warning).toBeDefined();
        });

        test("with forceRefresh: true bypasses fresh-cache short-circuit and uses the fetched catalog", async () => {
            const stale = freshMetadata("2025-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z");
            const reader = makeReader({
                [METADATA_RELATIVE_PATH]: JSON.stringify(stale),
                [CATALOG_RELATIVE_PATH]: JSON.stringify(fixture),
            });
            const { writer, calls } = makeWriter();
            const { fn: fetchFn } = makeFetch(okJsonResponse(fixture));
            const result = await loadCatalog({
                configDir: "/etc/zaher",
                fetchFn,
                reader,
                writer,
                now,
                forceRefresh: true,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.cache.status).toBe("fresh");
            expect(result.cache.fetched_at).toBe("2026-06-01T00:00:00.000Z");
            expect(calls.length).toBeGreaterThan(0);
        });

        test("returns a payload where custom is passthrough with no models", async () => {
            const { fn: fetchFn } = makeFetch(okJsonResponse(fixture));
            const { writer } = makeWriter();
            const result = await loadCatalog({
                configDir: "/etc/zaher",
                fetchFn,
                reader: noopReader,
                writer,
                now,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.providers.custom).toEqual({
                status: "passthrough",
                models: [],
            });
            expect(result.providers).not.toHaveProperty("openai");
            expect(result.providers).not.toHaveProperty("gateway");
        });

        test("returns fetched catalog with warning when cache write fails", async () => {
            const { fn: fetchFn } = makeFetch(okJsonResponse(fixture));
            const failingWriter: FileWriter = () => ({
                ok: false,
                code: "io_error",
                message: "disk full",
            });
            const result = await loadCatalog({
                configDir: "/etc/zaher-write-fail",
                fetchFn,
                reader: noopReader,
                writer: failingWriter,
                now,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.cache.status).toBe("fresh");
            expect(result.warning).toBe("cache write failed: disk full");
            expect(result.cache.warning).toBe("cache write failed: disk full");
            expect(result.providers.openrouter.models.length).toBeGreaterThan(0);
        });

        test("sends If-None-Match on stale cache and refreshes TTL on 304 Not Modified", async () => {
            const stale = freshMetadata("2025-01-01T00:00:00.000Z", "2025-06-01T00:00:00.000Z", '"etag-v1"');
            const reader = makeReader({
                [METADATA_RELATIVE_PATH]: JSON.stringify(stale),
                [CATALOG_RELATIVE_PATH]: JSON.stringify(fixture),
            });
            const { writer, calls } = makeWriter();
            const notModifiedResponse = new Response(null, {
                status: 304,
                headers: { etag: '"etag-v2"' },
            });
            const { fn: fetchFn, calls: fetchCalls } = makeFetch(notModifiedResponse);

            const result = await loadCatalog({
                configDir: "/etc/zaher-etag-304",
                fetchFn,
                reader,
                writer,
                now,
            });

            expect(fetchCalls).toHaveLength(1);
            expect(fetchCalls[0]?.init.headers["If-None-Match"]).toBe('"etag-v1"');
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.cache.status).toBe("fresh");
            expect(result.cache.fetched_at).toBe("2026-06-01T00:00:00.000Z");
            expect(result.cache.expires_at).toBe("2026-06-02T00:00:00.000Z");
            expect(result.providers.openrouter.models.length).toBeGreaterThan(0);

            expect(calls).toHaveLength(1);
            expect(calls[0]?.path).toBe(METADATA_RELATIVE_PATH);
            const writtenMeta = JSON.parse(calls[0]?.content ?? "{}");
            expect(writtenMeta.etag).toBe('"etag-v2"');
            expect(writtenMeta.fetched_at).toBe("2026-06-01T00:00:00.000Z");
            expect(writtenMeta.expires_at).toBe("2026-06-02T00:00:00.000Z");
        });

        test("captures ETag header on 200 and omits If-None-Match when forceRefresh is true", async () => {
            const cached = freshMetadata("2025-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z", '"etag-old"');
            const reader = makeReader({
                [METADATA_RELATIVE_PATH]: JSON.stringify(cached),
                [CATALOG_RELATIVE_PATH]: JSON.stringify(fixture),
            });
            const { writer, calls } = makeWriter();
            const { fn: fetchFn, calls: fetchCalls } = makeFetch(okJsonResponse(fixture, { etag: '"etag-new"' }));

            const result = await loadCatalog({
                configDir: "/etc/zaher-etag-200",
                fetchFn,
                reader,
                writer,
                now,
                forceRefresh: true,
            });

            expect(fetchCalls).toHaveLength(1);
            expect(fetchCalls[0]?.init.headers["If-None-Match"]).toBeUndefined();
            expect(result.ok).toBe(true);
            const metadataCall = calls.find((c) => c.path === METADATA_RELATIVE_PATH);
            expect(metadataCall).toBeDefined();
            const writtenMeta = JSON.parse(metadataCall?.content ?? "{}");
            expect(writtenMeta.etag).toBe('"etag-new"');
        });

        test("deduplicates concurrent loadCatalog calls for the same configDir and forceRefresh: false", async () => {
            let fetchCount = 0;
            let resolveFetch!: (response: Response) => void;
            const pendingFetch = new Promise<Response>((resolveResponse) => {
                resolveFetch = resolveResponse;
            });
            const fetchFn: FetchFn = async () => {
                fetchCount += 1;
                return pendingFetch;
            };
            const { writer } = makeWriter();
            const configDir = "/etc/zaher-dedup-same";

            const firstPromise = loadCatalog({
                configDir,
                fetchFn,
                reader: noopReader,
                writer,
                now,
                forceRefresh: false,
            });
            const secondPromise = loadCatalog({
                configDir,
                fetchFn,
                reader: noopReader,
                writer,
                now,
                forceRefresh: false,
            });

            expect(fetchCount).toBe(1);
            resolveFetch(okJsonResponse(fixture));

            const [first, second] = await Promise.all([firstPromise, secondPromise]);
            expect(fetchCount).toBe(1);
            expect(first.ok).toBe(true);
            expect(second.ok).toBe(true);
            if (!first.ok || !second.ok) return;
            expect(first.cache.status).toBe("fresh");
            expect(second).toEqual(first);
        });

        test("uses a separate dedup key for a concurrent forceRefresh: true call", async () => {
            let fetchCount = 0;
            const resolvers: Array<(response: Response) => void> = [];
            const fetchFn: FetchFn = async () => {
                fetchCount += 1;
                return new Promise<Response>((resolveResponse) => {
                    resolvers.push(resolveResponse);
                });
            };
            const { writer } = makeWriter();
            const configDir = "/etc/zaher-dedup-force";

            const normalPromise = loadCatalog({
                configDir,
                fetchFn,
                reader: noopReader,
                writer,
                now,
                forceRefresh: false,
            });
            const refreshPromise = loadCatalog({
                configDir,
                fetchFn,
                reader: noopReader,
                writer,
                now,
                forceRefresh: true,
            });

            expect(fetchCount).toBe(2);
            expect(resolvers).toHaveLength(2);
            resolvers[0]?.(okJsonResponse(fixture));
            resolvers[1]?.(okJsonResponse(fixture));

            const [normalResult, refreshResult] = await Promise.all([normalPromise, refreshPromise]);
            expect(normalResult.ok).toBe(true);
            expect(refreshResult.ok).toBe(true);
            if (!normalResult.ok || !refreshResult.ok) return;
            expect(normalResult.cache.status).toBe("fresh");
            expect(refreshResult.cache.status).toBe("fresh");
        });

        test("clears dedup entry after a failed in-flight fetch so a subsequent call fetches again", async () => {
            let fetchCount = 0;
            let rejectFirstFetch!: (error: Error) => void;
            const firstPending = new Promise<Response>((_resolve, reject) => {
                rejectFirstFetch = reject;
            });
            const fetchFn: FetchFn = async () => {
                fetchCount += 1;
                if (fetchCount === 1) {
                    return firstPending;
                }
                return okJsonResponse(fixture);
            };
            const { writer } = makeWriter();
            const configDir = "/etc/zaher-dedup-retry";

            const failedPromise = loadCatalog({
                configDir,
                fetchFn,
                reader: noopReader,
                writer,
                now,
                forceRefresh: false,
            });
            rejectFirstFetch(new Error("transient outage"));

            const firstResult = await failedPromise;
            expect(firstResult.ok).toBe(false);
            if (firstResult.ok) return;
            expect(firstResult.error.code).toBe("catalog_unavailable");

            const secondResult = await loadCatalog({
                configDir,
                fetchFn,
                reader: noopReader,
                writer,
                now,
                forceRefresh: false,
            });
            expect(fetchCount).toBe(2);
            expect(secondResult.ok).toBe(true);
            if (!secondResult.ok) return;
            expect(secondResult.cache.status).toBe("fresh");
        });

        test("returns catalog_unavailable on unexpected 304 Not Modified without cached catalog", async () => {
            const { fn: fetchFn, calls: fetchCalls } = makeFetch(new Response(null, { status: 304 }));
            const { writer, calls: writeCalls } = makeWriter();

            const result = await loadCatalog({
                configDir: "/etc/zaher-unexpected-304",
                fetchFn,
                reader: noopReader,
                writer,
                now,
            });

            expect(fetchCalls).toHaveLength(1);
            expect(writeCalls).toHaveLength(0);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.code).toBe("catalog_unavailable");
            expect(result.error.message).toContain("304");
        });

        test("falls back to network fetch when cache metadata or catalog JSON is corrupt", async () => {
            const freshMeta = freshMetadata("2026-05-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z");
            const corruptCases = [
                {
                    name: "corrupt-meta",
                    files: {
                        [METADATA_RELATIVE_PATH]: "{not valid json",
                        [CATALOG_RELATIVE_PATH]: JSON.stringify(fixture),
                    },
                },
                {
                    name: "corrupt-catalog",
                    files: {
                        [METADATA_RELATIVE_PATH]: JSON.stringify(freshMeta),
                        [CATALOG_RELATIVE_PATH]: "{not valid json",
                    },
                },
            ];

            for (const { name, files } of corruptCases) {
                const reader = makeReader(files);

                // Network succeeds: recovers by fetching and rewriting cache.
                const { fn: okFetchFn, calls: okFetchCalls } = makeFetch(okJsonResponse(fixture));
                const { writer: okWriter, calls: writeCalls } = makeWriter();
                const recovered = await loadCatalog({
                    configDir: `/etc/zaher-${name}-recover`,
                    fetchFn: okFetchFn,
                    reader,
                    writer: okWriter,
                    now,
                });
                expect(okFetchCalls).toHaveLength(1);
                expect(writeCalls).toHaveLength(2);
                expect(recovered.ok).toBe(true);
                if (recovered.ok) {
                    expect(recovered.cache.status).toBe("fresh");
                }

                // Network fails: returns catalog_unavailable instead of serving corrupt cache.
                const { fn: failFetchFn, calls: failFetchCalls } = makeFetch(new Error("upstream down"));
                const { writer: failWriter } = makeWriter();
                const failed = await loadCatalog({
                    configDir: `/etc/zaher-${name}-fail`,
                    fetchFn: failFetchFn,
                    reader,
                    writer: failWriter,
                    now,
                });
                expect(failFetchCalls).toHaveLength(1);
                expect(failed.ok).toBe(false);
                if (!failed.ok) {
                    expect(failed.error.code).toBe("catalog_unavailable");
                    expect(failed.error.message).toContain("upstream down");
                }
            }
        });
    });

    describe("cache-fs", () => {
        test("resolveCachePath resolves relative paths inside configDir and rejects traversal or absolute paths", () => {
            const configDir = "/tmp/chorus-config";
            expect(resolveCachePath(configDir, CATALOG_RELATIVE_PATH)).toBe(resolve(configDir, CATALOG_RELATIVE_PATH));

            expect(() => resolveCachePath(configDir, "/etc/passwd")).toThrow(/relative/i);
            expect(() => resolveCachePath(configDir, "../outside.json")).toThrow(/escapes/i);
            expect(() => resolveCachePath(configDir, "models-cache/../../outside.json")).toThrow(/escapes/i);
            expect(() => resolveCachePath(configDir, "../chorus-config-evil/catalog.json")).toThrow(/escapes/i);
            expect(() => resolveCachePath(configDir, "..")).toThrow(/escapes/i);
            expect(() => resolveCachePath(configDir, ".")).toThrow(/escapes/i);
            expect(() => resolveCachePath(configDir, "models-cache/bad\0path")).toThrow(/invalid/i);
        });

        test("makeLocalFileWriter writes atomically and leaves no temp files behind", () => {
            const tempConfigDir = mkdtempSync(join(tmpdir(), "chorus-cache-fs-"));
            try {
                const writer = makeLocalFileWriter(tempConfigDir);
                const reader = makeLocalFileReader(tempConfigDir);

                const writeResult = writer(CATALOG_RELATIVE_PATH, '{"ok":true}', { mode: 0o600, tempSuffix: ".tmp" });
                expect(writeResult.ok).toBe(true);

                const readResult = reader(CATALOG_RELATIVE_PATH);
                expect(readResult).toEqual({ ok: true, text: '{"ok":true}' });

                const entries = readdirSync(join(tempConfigDir, "models-cache"));
                expect(entries).toEqual(["catalog.json"]);
            } finally {
                rmSync(tempConfigDir, { recursive: true, force: true });
            }
        });

        test("makeLocalFileWriter repairs pre-existing overly permissive cache directory permissions to 0700", () => {
            if (process.platform === "win32") return;

            const tempConfigDir = mkdtempSync(join(tmpdir(), "chorus-cache-perm-"));
            try {
                const cacheDir = join(tempConfigDir, "models-cache");
                mkdirSync(cacheDir, { recursive: true, mode: 0o755 });
                chmodSync(cacheDir, 0o755);

                const writer = makeLocalFileWriter(tempConfigDir);
                const writeResult = writer(CATALOG_RELATIVE_PATH, '{"ok":true}', { mode: 0o600, tempSuffix: ".tmp" });

                expect(writeResult.ok).toBe(true);
                expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
                expect(statSync(join(cacheDir, "catalog.json")).mode & 0o777).toBe(0o600);
            } finally {
                rmSync(tempConfigDir, { recursive: true, force: true });
            }
        });

        test("makeLocalFileReader and makeLocalFileWriter reject symlinks escaping configDir", () => {
            if (process.platform === "win32") return;

            const tempRoot = mkdtempSync(join(tmpdir(), "chorus-cache-symlink-"));
            try {
                const configDir = join(tempRoot, "config");
                const outsideDir = join(tempRoot, "outside");
                mkdirSync(configDir, { recursive: true });
                mkdirSync(outsideDir, { recursive: true });
                const outsideFile = join(outsideDir, "secret.json");
                writeFileSync(outsideFile, '{"secret":"do-not-read"}', "utf-8");

                // 1. Symlinked cache directory pointing outside configDir
                symlinkSync(outsideDir, join(configDir, "models-cache"));
                const writer = makeLocalFileWriter(configDir);
                const reader = makeLocalFileReader(configDir);

                const dirWrite = writer(CATALOG_RELATIVE_PATH, '{"escaped":true}', { mode: 0o600 });
                expect(dirWrite.ok).toBe(false);
                expect(readdirSync(outsideDir)).toEqual(["secret.json"]);

                const dirRead = reader("models-cache/secret.json");
                expect(dirRead).toEqual({ ok: false, code: "io_error" });

                // 2. Real cache directory with a symlinked file pointing outside configDir
                rmSync(join(configDir, "models-cache"));
                mkdirSync(join(configDir, "models-cache"), { recursive: true });
                symlinkSync(outsideFile, join(configDir, CATALOG_RELATIVE_PATH));

                const fileRead = reader(CATALOG_RELATIVE_PATH);
                expect(fileRead).toEqual({ ok: false, code: "io_error" });

                const fileWrite = writer(CATALOG_RELATIVE_PATH, '{"overwritten":true}', { mode: 0o600 });
                expect(fileWrite.ok).toBe(false);
                expect(readFileSync(outsideFile, "utf-8")).toBe('{"secret":"do-not-read"}');
            } finally {
                rmSync(tempRoot, { recursive: true, force: true });
            }
        });

        test("makeLocalFileReader returns { ok: false, code: 'missing' } when target file does not exist", () => {
            const tempConfigDir = mkdtempSync(join(tmpdir(), "chorus-cache-missing-"));
            try {
                const reader = makeLocalFileReader(tempConfigDir);
                expect(reader(CATALOG_RELATIVE_PATH)).toEqual({ ok: false, code: "missing" });
            } finally {
                rmSync(tempConfigDir, { recursive: true, force: true });
            }
        });
    });
});

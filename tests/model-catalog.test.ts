import { describe, expect, test } from "bun:test";

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
import {
    ModelsListResponseSchema,
    ProviderCatalogSchema,
} from "@/types/providers";
import fixture from "./fixtures/models-dev-catalog.fixture.json" with {
    type: "json",
};

// === Fixtures and helpers ===

const noopReader: FileReader = () => ({ ok: false, code: "missing" });

const okJsonResponse = (
    body: unknown,
    init: { status?: number; contentType?: string | null } = {},
): Response => {
    const status = init.status ?? 200;
    const headers = new Headers();
    if (init.contentType !== null) {
        headers.set("content-type", init.contentType ?? "application/json");
    }
    return new Response(
        typeof body === "string" ? body : JSON.stringify(body),
        {
            status,
            headers,
        },
    );
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

const makeReader = (
    files: Record<string, string | { code: "missing" | "io_error" }>,
): FileReader => {
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

const freshMetadata = (fetchedAt: string, expiresAt: string) => ({
    schema: CACHE_SCHEMA as "models-cache/1",
    fetched_at: fetchedAt,
    expires_at: expiresAt,
    source: MODELS_DEV_CATALOG_URL,
});

// === describe("model-catalog") ===

describe("model-catalog", () => {
    describe("fetchCatalog", () => {
        test("returns success and validates the catalog on a valid 2xx JSON response", async () => {
            const { fn, calls } = makeFetch(okJsonResponse(fixture));
            const result = await fetchCatalog(
                fn,
                () => new Date("2026-02-01T00:00:00Z"),
            );
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
            const { fn } = makeFetch(
                okJsonResponse({ error: "x" }, { status: 404 }),
            );
            const result = await fetchCatalog(fn);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error.code).toBe("http_status");
            expect(result.error.message).toContain("404");
        });

        test("returns { ok: false, code: 'content_type' } when content-type is text/html", async () => {
            const { fn } = makeFetch(
                okJsonResponse({}, { contentType: "text/html" }),
            );
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
            const metadata = freshMetadata(
                "2026-01-01T00:00:00.000Z",
                "2026-01-02T00:00:00.000Z",
            );
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
            const openaiRaw = (fixture as { providers: { openai: unknown } })
                .providers.openai;
            const providerCatalog = ProviderCatalogSchema.parse(openaiRaw);
            const models = normalizeProviderModels(
                "openai",
                "openai",
                providerCatalog,
                (fixture as { models: Record<string, unknown> }).models,
            );
            const gpt52 = models.find((m) => m.provider_model_id === "gpt-5.2");
            expect(gpt52).toBeDefined();
            expect(gpt52?.route_id).toBe("openai/gpt-5.2");
            expect(gpt52?.display_name).toBe("GPT-5.2");
            expect(gpt52?.context_window).toBe(256000);
            expect(gpt52?.output_limit).toBe(16384);
            expect(gpt52?.supports_reasoning).toBe(true);
            expect(gpt52?.supports_tools).toBe(true);
            expect(gpt52?.supports_structured_output).toBe(true);
            expect(gpt52?.canonical_model_id).toBe("openai/gpt-5.2");
        });

        test("omits optional capability fields when absent in the catalog entry", () => {
            const providerCatalog = ProviderCatalogSchema.parse({
                models: {
                    "no-caps": { name: "Bare" },
                },
            });
            const models = normalizeProviderModels(
                "openai",
                "openai",
                providerCatalog,
                {},
            );
            expect(models).toHaveLength(1);
            const m = models[0];
            if (!m) throw new Error("expected a model");
            expect(m.route_id).toBe("openai/no-caps");
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
                    "gpt-5.2": { name: "GPT-5.2" },
                },
            });
            const canonicalModels = {
                "openai/gpt-5.2-mini": {
                    id: "gpt-5.2-mini",
                    provider: "openai",
                },
                "openai/x-gpt-5.2": { id: "x-gpt-5.2", provider: "openai" },
                "wrong-provider/gpt-5.2": {
                    id: "gpt-5.2",
                    provider: "openrouter",
                },
            };
            const models = normalizeProviderModels(
                "openai",
                "openai",
                providerCatalog,
                canonicalModels,
            );
            expect(models).toHaveLength(1);
            expect(models[0]?.canonical_model_id).toBeUndefined();
        });
    });

    describe("loadCatalog", () => {
        const now = () => new Date("2026-06-01T00:00:00Z");

        test("with fresh cache skips the network", async () => {
            const metadata = freshMetadata(
                "2026-05-01T00:00:00.000Z",
                "2027-01-01T00:00:00.000Z",
            );
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
            const stale = freshMetadata(
                "2025-01-01T00:00:00.000Z",
                "2025-06-01T00:00:00.000Z",
            );
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
            const stale = freshMetadata(
                "2025-01-01T00:00:00.000Z",
                "2025-06-01T00:00:00.000Z",
            );
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
            const stale = freshMetadata(
                "2025-01-01T00:00:00.000Z",
                "2027-01-01T00:00:00.000Z",
            );
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

        test("with forceRefresh: true and fetch failure falls back to stale cache", async () => {
            const stale = freshMetadata(
                "2025-01-01T00:00:00.000Z",
                "2025-06-01T00:00:00.000Z",
            );
            const reader = makeReader({
                [METADATA_RELATIVE_PATH]: JSON.stringify(stale),
                [CATALOG_RELATIVE_PATH]: JSON.stringify(fixture),
            });
            const { writer } = makeWriter();
            const fetchError = new Error("refresh failed");
            const { fn: fetchFn } = makeFetch(fetchError);
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
            expect(result.cache.status).toBe("stale");
            expect(result.warning).toContain("refresh failed");
        });

        test("returns a payload where custom and gateway are passthrough with empty models", async () => {
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
            expect(result.providers.custom?.status).toBe("passthrough");
            expect(result.providers.custom?.models).toEqual([]);
            expect(result.providers.gateway?.status).toBe("passthrough");
            expect(result.providers.gateway?.models).toEqual([]);
        });

        test("returns a payload that validates against ModelsListResponseSchema", async () => {
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
            if (!result.ok) throw new Error("expected ok");
            const parsed = ModelsListResponseSchema.safeParse(result);
            expect(parsed.success).toBe(true);
        });
    });
});

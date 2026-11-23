import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { parseListModelsArgs, runListModelsCommand as realRunListModelsCommand } from "@/commands/list-models";
import { loadConfig as realLoadConfig } from "@/config";
import { type LoadCatalogSuccess, loadCatalog as realLoadCatalog } from "@/providers/model-catalog";
import { isProviderConfigured as realIsProviderConfigured } from "@/providers/registry";
import {
    BrokerModelInfoSchema,
    ModelsListErrorSchema,
    type ModelsListResponse,
    ModelsListResponseSchema,
    type ProviderId,
    type ProviderListEntry,
} from "@/types/providers";
import { configureLogging as realConfigureLogging } from "@/utils/logger";
import { captureOutput, testConfig } from "./helpers";

let loadConfigHandler: typeof realLoadConfig = realLoadConfig;
let configureLoggingHandler: typeof realConfigureLogging = realConfigureLogging;
let isProviderConfiguredHandler: typeof realIsProviderConfigured = realIsProviderConfigured;
let loadCatalogHandler: typeof realLoadCatalog = realLoadCatalog;

const runListModelsCommand = (args: string[]) =>
    realRunListModelsCommand(args, {
        loadConfig: (...callArgs) => loadConfigHandler(...callArgs),
        configureLogging: (...callArgs) => configureLoggingHandler(...callArgs),
        isProviderConfigured: (...callArgs) => isProviderConfiguredHandler(...callArgs),
        loadCatalog: (...callArgs) => loadCatalogHandler(...callArgs),
    });

const resetHandlersToReal = (): void => {
    loadConfigHandler = realLoadConfig;
    configureLoggingHandler = realConfigureLogging;
    isProviderConfiguredHandler = realIsProviderConfigured;
    loadCatalogHandler = realLoadCatalog;
};

type StubCatalogResponse = {
    schema: "models.list/1";
    cache: ModelsListResponse["cache"];
    providers: Record<ProviderId, ProviderListEntry>;
};

const buildResponse = (
    providers: Record<ProviderId, ProviderListEntry>,
    cache: ModelsListResponse["cache"] = {
        status: "fresh",
        fetched_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2026-01-02T00:00:00.000Z",
    },
): StubCatalogResponse => ({
    schema: "models.list/1",
    cache,
    providers,
});

const fixtureProviders = (): Record<ProviderId, ProviderListEntry> => {
    const anthropicModel = BrokerModelInfoSchema.parse({
        route_id: "anthropic/claude-3-5-sonnet",
        provider: "anthropic",
        provider_model_id: "claude-3-5-sonnet",
        display_name: "Claude 3.5 Sonnet",
        context_window: 200_000,
        supports_reasoning: true,
        supports_tools: true,
        supports_structured_output: true,
    });
    const openrouterModel = BrokerModelInfoSchema.parse({
        route_id: "openrouter/openai/gpt-5.2",
        provider: "openrouter",
        provider_model_id: "openai/gpt-5.2",
        display_name: "GPT-5.2",
        context_window: 128_000,
        supports_tools: true,
    });
    const azureModel = BrokerModelInfoSchema.parse({
        route_id: "azure/gpt-4o",
        provider: "azure",
        provider_model_id: "gpt-4o",
        display_name: "GPT-4o",
    });
    return {
        "amazon-bedrock": { status: "catalog", models: [] },
        anthropic: { status: "catalog", models: [anthropicModel] },
        azure: { status: "catalog", models: [azureModel] },
        custom: { status: "passthrough", models: [] },
        "google-vertex": { status: "catalog", models: [] },
        openrouter: { status: "catalog", models: [openrouterModel] },
    };
};

const stubConfiguredProviders = (configured: ProviderId[]): void => {
    isProviderConfiguredHandler = (id) => configured.includes(id);
};

const stubLoadCatalog = (
    response: StubCatalogResponse,
    warning?: string,
): { calls: Array<{ forceRefresh: boolean }> } => {
    const calls: Array<{ forceRefresh: boolean }> = [];
    const stubResult: LoadCatalogSuccess = {
        ok: true,
        schema: response.schema,
        cache: response.cache,
        providers: response.providers,
        ...(warning === undefined ? {} : { warning }),
    };
    loadCatalogHandler = async (options) => {
        calls.push({ forceRefresh: options.forceRefresh === true });
        return stubResult;
    };
    return { calls };
};

describe("parseListModelsArgs", () => {
    const expectSuccess = (
        args: string[],
        value: { filter: string | undefined; help: boolean; json: boolean; refresh: boolean },
    ) => {
        expect(parseListModelsArgs(args)).toEqual({ ok: true, value });
    };

    const expectFailure = (args: string[], message: string) => {
        const parsed = parseListModelsArgs(args);
        expect(parsed.ok).toBe(false);
        if (parsed.ok) {
            return;
        }
        expect(parsed.error.type).toBe("validation");
        expect(parsed.error.message).toBe(message);
    };

    it("normalizes optional filters, known booleans, and help aliases", () => {
        expectSuccess([], { filter: undefined, help: false, json: false, refresh: false });
        expectSuccess(["KiMi"], { filter: "KiMi", help: false, json: false, refresh: false });
        expectSuccess(["123"], { filter: "123", help: false, json: false, refresh: false });
        expectSuccess(["--refresh=true", "--json=false", "--help=true", "KiMi"], {
            filter: "KiMi",
            help: true,
            json: false,
            refresh: true,
        });
        expectSuccess(["--no-refresh", "--no-json", "--no-help"], {
            filter: undefined,
            help: false,
            json: false,
            refresh: false,
        });
        expectSuccess(["-h"], { filter: undefined, help: true, json: false, refresh: false });
    });

    it("uses the last known boolean value", () => {
        expectSuccess(["--refresh", "--no-refresh"], {
            filter: undefined,
            help: false,
            json: false,
            refresh: false,
        });
        expectSuccess(["--json=false", "--json"], {
            filter: undefined,
            help: false,
            json: true,
            refresh: false,
        });
        expectSuccess(["--help", "--no-help"], {
            filter: undefined,
            help: false,
            json: false,
            refresh: false,
        });
    });

    it("rejects malformed list-model arguments", () => {
        expectFailure(["--bogus"], "Unknown flag: --bogus");
        expectFailure(["-x"], "Unknown flag: -x");
        expectFailure(["kimi", "extra"], "Unknown flag: extra");
        expectFailure(["--"], "Unknown flag: --");
        expectFailure(["--", "tail"], "Unknown flag: --");
        expectFailure(["-"], "Unknown flag: -");
        expectFailure(["--refresh=invalid"], "Unknown flag: --refresh=invalid");
        expectFailure(["--json=1"], "Unknown flag: --json=1");
        expectFailure(["--help=yes"], "Unknown flag: --help=yes");
        expectFailure(["--h"], "Unknown flag: --h");
        expectFailure(["--h=true"], "Unknown flag: --h=true");
        expectFailure(["--h=false"], "Unknown flag: --h=false");
        expectFailure(["--h=0"], "Unknown flag: --h=0");
        expectFailure(["--no-h"], "Unknown flag: --no-h");
        expectFailure(["--no-refresh=false"], "Unknown flag: --no-refresh=false");
        expectFailure(["--no-json=true"], "Unknown flag: --no-json=true");
        expectFailure(["--no-help=false"], "Unknown flag: --no-help=false");
        expectFailure(["--no-h=true"], "Unknown flag: --no-h=true");
    });
});

describe("runListModelsCommand", () => {
    beforeEach(() => {
        loadConfigHandler = async () => testConfig();
        configureLoggingHandler = async () => {};
        isProviderConfiguredHandler = realIsProviderConfigured;
        loadCatalogHandler = realLoadCatalog;
    });

    afterEach(() => {
        resetHandlersToReal();
    });

    it("emits a models.list/1 payload with only configured providers and cache metadata", async () => {
        stubLoadCatalog(buildResponse(fixtureProviders()));
        stubConfiguredProviders(["anthropic", "openrouter"]);

        const { result, stdout } = await captureOutput(() => runListModelsCommand(["--json"]));
        expect(result).toBe(0);

        const payload = JSON.parse(stdout);
        expect(payload.schema).toBe("models.list/1");
        expect(payload.cache.status).toBe("fresh");
        expect(typeof payload.cache.fetched_at).toBe("string");
        expect(typeof payload.cache.expires_at).toBe("string");
        expect(Object.keys(payload.providers).sort()).toEqual(["anthropic", "openrouter"]);
        expect(payload.providers.anthropic.status).toBe("catalog");
        expect(payload.providers.anthropic.models).toHaveLength(1);
        expect(payload.providers.openrouter.models[0].route_id).toBe("openrouter/openai/gpt-5.2");
    });

    it("emits passthrough providers with status passthrough and empty models", async () => {
        stubLoadCatalog(buildResponse(fixtureProviders()));
        stubConfiguredProviders(["custom"]);

        const { result, stdout } = await captureOutput(() => runListModelsCommand(["--json"]));
        expect(result).toBe(0);

        const payload = JSON.parse(stdout);
        expect(payload.providers.custom).toEqual({
            status: "passthrough",
            models: [],
        });
    });

    it("emits a models.list.error/1 payload when the catalog is unavailable in JSON mode", async () => {
        loadCatalogHandler = async () => ({
            ok: false,
            error: {
                code: "catalog_unavailable",
                message: "network unreachable",
            },
        });
        stubConfiguredProviders([]);

        const { result, stdout } = await captureOutput(() => runListModelsCommand(["--json"]));
        expect(result).toBe(1);

        const payload = ModelsListErrorSchema.parse(JSON.parse(stdout));
        expect(payload).toEqual({
            schema: "models.list.error/1",
            error: {
                code: "catalog_unavailable",
                message: "network unreachable",
            },
        });
    });

    it("includes cache.warning in models.list/1 JSON output when loadCatalog returns a warning", async () => {
        const staleCache: ModelsListResponse["cache"] = {
            status: "stale",
            fetched_at: "2026-01-01T00:00:00.000Z",
            expires_at: "2026-01-02T00:00:00.000Z",
        };
        stubLoadCatalog(buildResponse(fixtureProviders(), staleCache), "refresh failed: network timeout");
        stubConfiguredProviders(["anthropic"]);

        const { result, stdout, stderr } = await captureOutput(() => runListModelsCommand(["--json"]));
        expect(result).toBe(0);
        expect(stderr).toBe("");

        const payload = ModelsListResponseSchema.parse(JSON.parse(stdout));
        expect(payload.cache).toEqual({
            status: "stale",
            fetched_at: "2026-01-01T00:00:00.000Z",
            expires_at: "2026-01-02T00:00:00.000Z",
            warning: "refresh failed: network timeout",
        });
    });

    it("prints the catalog warning in human mode when loadCatalog returns a warning", async () => {
        const staleCache: ModelsListResponse["cache"] = {
            status: "stale",
            fetched_at: "2026-01-01T00:00:00.000Z",
            expires_at: "2026-01-02T00:00:00.000Z",
        };
        stubLoadCatalog(buildResponse(fixtureProviders(), staleCache), "cache write failed: EACCES");
        stubConfiguredProviders(["anthropic"]);

        const { result, stdout } = await captureOutput(() => runListModelsCommand([]));
        expect(result).toBe(0);
        expect(stdout).toContain("warning: cache write failed: EACCES");
    });

    it("passes forceRefresh flag to loadCatalog as set by --refresh", async () => {
        stubConfiguredProviders(["anthropic"]);
        const response = buildResponse(fixtureProviders());

        // --refresh set -> forceRefresh: true
        {
            const { calls } = stubLoadCatalog(response);
            const { result } = await captureOutput(() => runListModelsCommand(["--json", "--refresh"]));
            expect(result).toBe(0);
            expect(calls[0]?.forceRefresh).toBe(true);
        }

        // --refresh absent -> forceRefresh: false
        {
            const { calls } = stubLoadCatalog(response);
            const { result } = await captureOutput(() => runListModelsCommand(["--json"]));
            expect(result).toBe(0);
            expect(calls[0]?.forceRefresh).toBe(false);
        }
    });

    it("prints a human-readable summary containing configured provider names and a route id", async () => {
        stubLoadCatalog(buildResponse(fixtureProviders()));
        stubConfiguredProviders(["anthropic", "openrouter"]);

        const { result, stdout } = await captureOutput(() => runListModelsCommand([]));
        expect(result).toBe(0);

        expect(stdout).toContain("anthropic");
        expect(stdout).toContain("openrouter");
        expect(stdout).toContain("anthropic/claude-3-5-sonnet");
        expect(stdout).toContain("cache:");
    });

    it("formats capability badges and the passthrough provider line in human-readable output", async () => {
        stubLoadCatalog(buildResponse(fixtureProviders()));
        stubConfiguredProviders(["anthropic", "openrouter", "azure", "custom"]);

        const { result, stdout } = await captureOutput(() => runListModelsCommand([]));
        expect(result).toBe(0);

        expect(stdout).toContain(
            "    - anthropic/claude-3-5-sonnet  Claude 3.5 Sonnet [ctx: 200000] [reasoning] [tools] [structured]",
        );
        expect(stdout).toContain("    - openrouter/openai/gpt-5.2  GPT-5.2 [ctx: 128000] [tools]");
        expect(stdout).toContain("    - azure/gpt-4o  GPT-4o\n");
        expect(stdout).toContain("  custom (passthrough)\n    (no catalog; use provider-prefixed IDs)");
    });

    it("returns 2 and prints an unknown-flag error for unrecognized flags", async () => {
        const { result, stderr } = await captureOutput(() => runListModelsCommand(["--bogus"]));
        expect(result).toBe(2);
        expect(stderr).toContain("Unknown flag: --bogus");
    });

    it("emits a models.list.error/1 payload with config_load_failed when loadConfig throws in JSON mode", async () => {
        loadConfigHandler = async () => {
            throw new Error("boom");
        };
        stubConfiguredProviders([]);

        const { result, stdout, stderr } = await captureOutput(() => runListModelsCommand(["--json"]));
        expect(result).toBe(1);
        expect(stderr).toBe("");

        const payload = ModelsListErrorSchema.parse(JSON.parse(stdout));
        expect(payload).toEqual({
            schema: "models.list.error/1",
            error: {
                code: "config_load_failed",
                message: "boom",
            },
        });
    });

    it("returns 1 and prints an error to stderr when loadConfig throws in human mode", async () => {
        loadConfigHandler = async () => {
            throw new Error("boom");
        };
        stubConfiguredProviders([]);

        const { result, stdout, stderr } = await captureOutput(() => runListModelsCommand([]));
        expect(result).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("Error");
        expect(stderr).toContain("boom");
    });

    it("returns 1 and prints a catalog error to stderr in human mode", async () => {
        loadCatalogHandler = async () => ({
            ok: false,
            error: {
                code: "catalog_unavailable",
                message: "no cache and network failed",
            },
        });
        stubConfiguredProviders([]);

        const { result, stderr } = await captureOutput(() => runListModelsCommand([]));
        expect(result).toBe(1);
        expect(stderr).toContain("Error");
        expect(stderr).toContain("no cache and network failed");
    });

    it("returns empty model lists when filter matches no models", async () => {
        stubLoadCatalog(buildResponse(fixtureProviders()));
        stubConfiguredProviders(["anthropic", "openrouter"]);

        const { result, stdout } = await captureOutput(() => runListModelsCommand(["--json", "Kimi"]));
        expect(result).toBe(0);

        const payload = ModelsListResponseSchema.parse(JSON.parse(stdout));
        expect(payload.providers.anthropic?.models).toEqual([]);
        expect(payload.providers.openrouter?.models).toEqual([]);
    });

    it("matches case-insensitive filter substrings independently on each searchable field", async () => {
        const routeOnly = BrokerModelInfoSchema.parse({
            route_id: "azure/plain-one",
            provider: "azure",
            provider_model_id: "plain-one",
            display_name: "Plain One",
            canonical_model_id: "canon-one",
        });
        const displayOnly = BrokerModelInfoSchema.parse({
            route_id: "anthropic/plain-two",
            provider: "anthropic",
            provider_model_id: "plain-two",
            display_name: "Zephyr Display Label",
            canonical_model_id: "canon-two",
        });
        const providerModelOnly = BrokerModelInfoSchema.parse({
            route_id: "openrouter/plain-three",
            provider: "openrouter",
            provider_model_id: "vendor/quartz-native",
            display_name: "Plain Three",
            canonical_model_id: "canon-three",
        });
        const canonicalOnly = BrokerModelInfoSchema.parse({
            route_id: "openrouter/plain-four",
            provider: "openrouter",
            provider_model_id: "plain-four",
            display_name: "Plain Four",
            canonical_model_id: "canonical/cobalt-id",
        });

        const providers: Record<ProviderId, ProviderListEntry> = {
            "amazon-bedrock": { status: "catalog", models: [] },
            anthropic: { status: "catalog", models: [displayOnly] },
            azure: { status: "catalog", models: [routeOnly] },
            custom: { status: "passthrough", models: [] },
            "google-vertex": { status: "catalog", models: [] },
            openrouter: { status: "catalog", models: [providerModelOnly, canonicalOnly] },
        };
        stubLoadCatalog(buildResponse(providers));
        stubConfiguredProviders(["azure", "anthropic", "openrouter"]);

        const cases: ReadonlyArray<{ field: string; query: string; expectedRouteId: string }> = [
            { field: "route_id", query: "AzUrE/", expectedRouteId: "azure/plain-one" },
            { field: "display_name", query: "zEpHyR", expectedRouteId: "anthropic/plain-two" },
            { field: "provider_model_id", query: "QuArTz", expectedRouteId: "openrouter/plain-three" },
            { field: "canonical_model_id", query: "CoBaLt", expectedRouteId: "openrouter/plain-four" },
        ];

        for (const { query, expectedRouteId } of cases) {
            const { result, stdout } = await captureOutput(() => runListModelsCommand(["--json", query]));
            expect(result).toBe(0);

            const payload = ModelsListResponseSchema.parse(JSON.parse(stdout));
            const matchedRouteIds = Object.values(payload.providers).flatMap((entry) =>
                entry.models.map((model) => model.route_id),
            );
            expect(matchedRouteIds).toEqual([expectedRouteId]);
        }
    });

    it("filters human-readable output to only matching models", async () => {
        const providers = fixtureProviders();
        const kimiModel = BrokerModelInfoSchema.parse({
            route_id: "openrouter/moonshotai/kimi-k2",
            provider: "openrouter",
            provider_model_id: "moonshotai/kimi-k2",
            display_name: "Kimi K2",
        });
        providers.openrouter = {
            status: "catalog",
            models: [...providers.openrouter.models, kimiModel],
        };
        stubLoadCatalog(buildResponse(providers));
        stubConfiguredProviders(["openrouter", "anthropic"]);

        const { result, stdout } = await captureOutput(() => runListModelsCommand(["kimi"]));
        expect(result).toBe(0);

        expect(stdout).toContain("openrouter/moonshotai/kimi-k2");
        expect(stdout).not.toContain("anthropic/claude-3-5-sonnet");
        expect(stdout).not.toContain("openrouter/openai/gpt-5.2");
    });

    it("rejects a second positional argument with exit code 2", async () => {
        stubConfiguredProviders([]);
        const { result, stderr } = await captureOutput(() => runListModelsCommand(["kimi", "extra"]));
        expect(result).toBe(2);
        expect(stderr).toContain("Unknown flag: extra");
    });

    it("rejects a bare separator before loading configuration or the catalog", async () => {
        let configCalls = 0;
        let catalogCalls = 0;
        loadConfigHandler = async () => {
            configCalls += 1;
            throw new Error("configuration should not load");
        };
        loadCatalogHandler = async () => {
            catalogCalls += 1;
            throw new Error("catalog should not load");
        };

        const { result, stdout, stderr } = await captureOutput(() => runListModelsCommand(["--"]));

        expect(result).toBe(2);
        expect(stdout).toBe("");
        expect(stderr).toBe("Unknown flag: --\n");
        expect(configCalls).toBe(0);
        expect(catalogCalls).toBe(0);
    });

    it("returns parser errors before help without loading configuration or the catalog", async () => {
        let configCalls = 0;
        let catalogCalls = 0;
        loadConfigHandler = async () => {
            configCalls += 1;
            throw new Error("configuration should not load");
        };
        loadCatalogHandler = async () => {
            catalogCalls += 1;
            throw new Error("catalog should not load");
        };

        const { result, stdout, stderr } = await captureOutput(() =>
            runListModelsCommand(["--refresh=invalid", "--help"]),
        );

        expect(result).toBe(2);
        expect(stdout).toBe("");
        expect(stderr).toBe("Unknown flag: --refresh=invalid\n");
        expect(configCalls).toBe(0);
        expect(catalogCalls).toBe(0);
    });

    it("prints help without loading configuration or the catalog", async () => {
        let configCalls = 0;
        let catalogCalls = 0;
        loadConfigHandler = async () => {
            configCalls += 1;
            throw new Error("configuration should not load");
        };
        loadCatalogHandler = async () => {
            catalogCalls += 1;
            throw new Error("catalog should not load");
        };

        const { result, stdout, stderr } = await captureOutput(() => runListModelsCommand(["--help"]));

        expect(result).toBe(0);
        expect(stdout).toContain("consensus list-models");
        expect(stderr).toBe("");
        expect(configCalls).toBe(0);
        expect(catalogCalls).toBe(0);
    });
});

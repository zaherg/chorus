import { describe, expect, it, mock } from "bun:test";

import { runListModelsCommand } from "@/commands/list-models";
import {
    BrokerModelInfoSchema,
    type ModelsListResponse,
    type ProviderListEntry,
} from "@/types/providers";
import { captureOutput, testConfig } from "./helpers";

mock.module("@/config", () => ({
    loadConfig: async () => testConfig(),
}));

mock.module("@/utils/logger", () => ({
    configureLogging: async () => {},
}));

const buildResponse = (
    providers: Record<string, ProviderListEntry>,
    cache: ModelsListResponse["cache"] = {
        status: "fresh",
        fetched_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2026-01-02T00:00:00.000Z",
    },
): ModelsListResponse => ({
    schema: "models.list/1",
    cache,
    providers,
});

const fixtureProviders = (): Record<string, ProviderListEntry> => {
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
        anthropic: { status: "catalog", models: [anthropicModel] },
        openrouter: { status: "catalog", models: [openrouterModel] },
        azure: { status: "catalog", models: [azureModel] },
        custom: { status: "passthrough", models: [] },
    };
};

const stubConfiguredProviders = (configured: string[]): void => {
    mock.module("@/providers/registry", () => ({
        isProviderConfigured: (id: string) => configured.includes(id),
    }));
};

const stubLoadCatalog = (
    response: ModelsListResponse,
    warning?: string,
): { calls: Array<{ forceRefresh: boolean }> } => {
    const calls: Array<{ forceRefresh: boolean }> = [];
    const stubResult = {
        ok: true as const,
        schema: response.schema,
        cache: response.cache,
        providers: response.providers,
        ...(warning === undefined ? {} : { warning }),
    };
    mock.module("@/providers/model-catalog", () => ({
        loadCatalog: async (options: { forceRefresh?: boolean }) => {
            calls.push({ forceRefresh: options.forceRefresh === true });
            return stubResult;
        },
    }));
    return { calls };
};

describe("runListModelsCommand", () => {
    it("emits a models.list/1 payload with only configured providers and cache metadata", async () => {
        stubLoadCatalog(buildResponse(fixtureProviders()));
        stubConfiguredProviders(["anthropic", "openrouter"]);

        const { result, stdout } = await captureOutput(() =>
            runListModelsCommand(["--json"]),
        );
        expect(result).toBe(0);

        const payload = JSON.parse(stdout);
        expect(payload.schema).toBe("models.list/1");
        expect(payload.cache.status).toBe("fresh");
        expect(typeof payload.cache.fetched_at).toBe("string");
        expect(typeof payload.cache.expires_at).toBe("string");
        expect(Object.keys(payload.providers).sort()).toEqual([
            "anthropic",
            "openrouter",
        ]);
        expect(payload.providers.anthropic.status).toBe("catalog");
        expect(payload.providers.anthropic.models).toHaveLength(1);
        expect(payload.providers.openrouter.models[0].route_id).toBe(
            "openrouter/openai/gpt-5.2",
        );
    });

    it("omits providers that are not configured", async () => {
        stubLoadCatalog(buildResponse(fixtureProviders()));
        stubConfiguredProviders(["anthropic"]);

        const { result, stdout } = await captureOutput(() =>
            runListModelsCommand(["--json"]),
        );
        expect(result).toBe(0);

        const payload = JSON.parse(stdout);
        expect(payload.providers).not.toHaveProperty("openrouter");
        expect(payload.providers).not.toHaveProperty("azure");
        expect(payload.providers).not.toHaveProperty("custom");
        expect(Object.keys(payload.providers)).toEqual(["anthropic"]);
    });

    it("emits passthrough providers with status passthrough and empty models", async () => {
        stubLoadCatalog(buildResponse(fixtureProviders()));
        stubConfiguredProviders(["custom"]);

        const { result, stdout } = await captureOutput(() =>
            runListModelsCommand(["--json"]),
        );
        expect(result).toBe(0);

        const payload = JSON.parse(stdout);
        expect(payload.providers.custom).toEqual({
            status: "passthrough",
            models: [],
        });
    });

    it("emits a models.list.error/1 payload when the catalog is unavailable in JSON mode", async () => {
        mock.module("@/providers/model-catalog", () => ({
            loadCatalog: async () => ({
                ok: false,
                error: {
                    code: "catalog_unavailable",
                    message: "network unreachable",
                },
            }),
        }));
        stubConfiguredProviders([]);

        const { result, stdout } = await captureOutput(() =>
            runListModelsCommand(["--json"]),
        );
        expect(result).toBe(1);

        const payload = JSON.parse(stdout);
        expect(payload).toEqual({
            schema: "models.list.error/1",
            error: {
                code: "catalog_unavailable",
                message: "network unreachable",
            },
        });
    });

    it("passes forceRefresh flag to loadCatalog as set by --refresh", async () => {
        stubConfiguredProviders(["anthropic"]);
        const response = buildResponse(fixtureProviders());

        // --refresh set -> forceRefresh: true
        {
            const { calls } = stubLoadCatalog(response);
            const { result } = await captureOutput(() =>
                runListModelsCommand(["--json", "--refresh"]),
            );
            expect(result).toBe(0);
            expect(calls[0]?.forceRefresh).toBe(true);
        }

        // --refresh absent -> forceRefresh: false
        {
            const { calls } = stubLoadCatalog(response);
            const { result } = await captureOutput(() =>
                runListModelsCommand(["--json"]),
            );
            expect(result).toBe(0);
            expect(calls[0]?.forceRefresh).toBe(false);
        }
    });

    it("prints a human-readable summary containing configured provider names and a route id", async () => {
        stubLoadCatalog(buildResponse(fixtureProviders()));
        stubConfiguredProviders(["anthropic", "openrouter"]);

        const { result, stdout } = await captureOutput(() =>
            runListModelsCommand([]),
        );
        expect(result).toBe(0);

        expect(stdout).toContain("anthropic");
        expect(stdout).toContain("openrouter");
        expect(stdout).toContain("anthropic/claude-3-5-sonnet");
        expect(stdout).toContain("cache:");
    });

    it("returns 2 and prints an unknown-flag error for unrecognized flags", async () => {
        const { result, stderr } = await captureOutput(() =>
            runListModelsCommand(["--bogus"]),
        );
        expect(result).toBe(2);
        expect(stderr).toContain("Unknown flag: --bogus");
    });

    it("returns 1 and prints an error when loadConfig throws", async () => {
        mock.module("@/config", () => ({
            loadConfig: async () => {
                throw new Error("boom");
            },
        }));
        stubConfiguredProviders([]);

        const { result, stderr } = await captureOutput(() =>
            runListModelsCommand(["--json"]),
        );
        expect(result).toBe(1);
        expect(stderr).toContain("Error");
        expect(stderr).toContain("boom");
    });

    it("returns 1 and prints a catalog error to stderr in human mode", async () => {
        mock.module("@/config", () => ({
            loadConfig: async () => testConfig(),
        }));
        mock.module("@/utils/logger", () => ({
            configureLogging: async () => {},
        }));
        mock.module("@/providers/model-catalog", () => ({
            loadCatalog: async () => ({
                ok: false,
                error: {
                    code: "catalog_unavailable",
                    message: "no cache and network failed",
                },
            }),
        }));
        stubConfiguredProviders([]);

        const { result, stderr } = await captureOutput(() =>
            runListModelsCommand([]),
        );
        expect(result).toBe(1);
        expect(stderr).toContain("Error");
        expect(stderr).toContain("no cache and network failed");
    });
});

import { describe, expect, test } from "bun:test";

import {
    type AmbiguityError,
    classifyInput,
    type NotFoundError,
    parseRouteId,
    type ResolveRouteResult,
    resolveRoute,
} from "@/providers/resolve-route";
import {
    type BrokerModelInfo,
    BrokerModelInfoSchema,
    type ModelsListResponse,
    type ProviderId,
} from "@/types/providers";

// === Fixture ===

const buildFixture = (): ModelsListResponse => {
    const azureGpt52: BrokerModelInfo = BrokerModelInfoSchema.parse({
        route_id: "azure/gpt-5.2",
        provider: "azure",
        provider_model_id: "gpt-5.2",
        display_name: "GPT-5.2",
        context_window: 128000,
        output_limit: 16384,
        supports_reasoning: true,
        supports_tools: true,
        supports_structured_output: true,
    });
    const azureGpt4o: BrokerModelInfo = BrokerModelInfoSchema.parse({
        route_id: "azure/gpt-4o",
        provider: "azure",
        provider_model_id: "gpt-4o",
        display_name: "GPT-4o",
    });
    const anthropicSonnet: BrokerModelInfo = BrokerModelInfoSchema.parse({
        route_id: "anthropic/claude-sonnet-4-5",
        provider: "anthropic",
        provider_model_id: "claude-sonnet-4-5",
        display_name: "Claude Sonnet 4.5",
    });
    const openrouterGpt52: BrokerModelInfo = BrokerModelInfoSchema.parse({
        route_id: "openrouter/openai/gpt-5.2",
        provider: "openrouter",
        provider_model_id: "openai/gpt-5.2",
        display_name: "GPT-5.2 (OpenRouter)",
    });
    const azureShared: BrokerModelInfo = BrokerModelInfoSchema.parse({
        route_id: "azure/shared",
        provider: "azure",
        provider_model_id: "shared",
        display_name: "Shared (Azure)",
    });
    const anthropicShared: BrokerModelInfo = BrokerModelInfoSchema.parse({
        route_id: "anthropic/shared",
        provider: "anthropic",
        provider_model_id: "shared",
        display_name: "Shared (Anthropic)",
    });

    return {
        schema: "models.list/1",
        cache: {
            status: "fresh",
            fetched_at: "2026-07-08T00:00:00.000Z",
            expires_at: "2026-07-09T00:00:00.000Z",
        },
        providers: {
            azure: {
                status: "catalog",
                models: [azureGpt52, azureGpt4o, azureShared],
            },
            anthropic: {
                status: "catalog",
                models: [anthropicSonnet, anthropicShared],
            },
            openrouter: { status: "catalog", models: [openrouterGpt52] },

            custom: { status: "passthrough", models: [] },
        },
    };
};

const expectNotFound = (result: ResolveRouteResult): NotFoundError => {
    if (result.ok) {
        throw new Error(`expected not-found result, got success: ${JSON.stringify(result.value)}`);
    }
    if (result.error.code !== "model_not_found") {
        throw new Error(`expected model_not_found, got ${result.error.code}: ${result.error.message}`);
    }
    return result.error;
};

const expectAmbiguity = (result: ResolveRouteResult): AmbiguityError => {
    if (result.ok) {
        throw new Error(`expected ambiguity, got success: ${JSON.stringify(result.value)}`);
    }
    if (result.error.code !== "ambiguous_model") {
        throw new Error(`expected ambiguous_model, got ${result.error.code}: ${result.error.message}`);
    }
    return result.error;
};

// === describe("resolve-route") ===

describe("resolve-route", () => {
    describe("parseRouteId", () => {
        test("parses or rejects based on input shape", () => {
            const cases = [
                {
                    input: "azure/gpt-5.2",
                    want: { provider: "azure", providerModelId: "gpt-5.2" },
                },
                {
                    input: "openrouter/openai/gpt-5.2",
                    want: { provider: "openrouter", providerModelId: "openai/gpt-5.2" },
                },
                {
                    input: "custom/org/model",
                    want: { provider: "custom", providerModelId: "org/model" },
                },
                { input: "gpt-5.2", want: undefined },
                { input: "unknown-provider/model", want: undefined },
                { input: "azure/", want: undefined },
                { input: "", want: undefined },
                { input: "/model", want: undefined },
            ] as const;
            for (const { input, want } of cases) {
                expect(parseRouteId(input)).toEqual(want);
            }
        });
    });

    describe("classifyInput", () => {
        test("classifies an exact route_id when the input contains '/'", () => {
            expect(classifyInput("azure/gpt-5.2")).toEqual({
                kind: "exact_route_id",
                route_id: "azure/gpt-5.2",
            });
        });

        test("classifies an unqualified provider-native id when no slash is present", () => {
            expect(classifyInput("gpt-5.2")).toEqual({
                kind: "unqualified",
                providerModelId: "gpt-5.2",
            });
        });
    });

    describe("resolveRoute", () => {
        test("exact route_id for a configured catalog-backed provider returns the row", () => {
            const catalog = buildFixture();
            const configured = new Set<ProviderId>(["azure"]);
            const result = resolveRoute(classifyInput("azure/gpt-5.2"), {
                catalog,
                configuredProviders: configured,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) {
                return;
            }
            expect(result.value.route_id).toBe("azure/gpt-5.2");
            expect(result.value.provider).toBe("azure");
            expect(result.value.provider_model_id).toBe("gpt-5.2");
            expect(result.value.display_name).toBe("GPT-5.2");
        });

        test("exact multi-slash route_id preserves the remainder after the first slash", () => {
            const catalog = buildFixture();

            const openrouterResult = resolveRoute(classifyInput("openrouter/openai/gpt-5.2"), {
                catalog,
                configuredProviders: new Set<ProviderId>(["openrouter"]),
            });
            expect(openrouterResult.ok).toBe(true);
            if (openrouterResult.ok) {
                expect(openrouterResult.value.route_id).toBe("openrouter/openai/gpt-5.2");
                expect(openrouterResult.value.provider).toBe("openrouter");
                expect(openrouterResult.value.provider_model_id).toBe("openai/gpt-5.2");
                expect(openrouterResult.value.display_name).toBe("GPT-5.2 (OpenRouter)");
            }

            const customResult = resolveRoute(classifyInput("custom/org/model"), {
                catalog,
                configuredProviders: new Set<ProviderId>(["custom"]),
            });
            expect(customResult.ok).toBe(true);
            if (customResult.ok) {
                expect(customResult.value.route_id).toBe("custom/org/model");
                expect(customResult.value.provider).toBe("custom");
                expect(customResult.value.provider_model_id).toBe("org/model");
                expect(customResult.value.display_name).toBe("org/model");
            }
        });

        test("exact route_id for an unconfigured provider returns model_not_found", () => {
            const cases: ReadonlyArray<{
                input: string;
                configured: readonly ProviderId[];
                provider: ProviderId;
            }> = [
                {
                    input: "azure/gpt-5.2",
                    configured: ["anthropic"],
                    provider: "azure",
                },
                {
                    input: "custom/local-model",
                    configured: ["azure"],
                    provider: "custom",
                },
            ];

            for (const { input, configured, provider } of cases) {
                const result = resolveRoute(classifyInput(input), {
                    catalog: buildFixture(),
                    configuredProviders: new Set(configured),
                });
                const error = expectNotFound(result);
                expect(error.message.toLowerCase()).toContain(provider);
                expect(error.message.toLowerCase()).toContain("not configured");
            }
        });

        test("exact route_id for a configured passthrough provider returns a synthetic row", () => {
            const catalog = buildFixture();
            const configured = new Set<ProviderId>(["custom"]);
            const result = resolveRoute(classifyInput("custom/local-model"), {
                catalog,
                configuredProviders: configured,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) {
                return;
            }
            expect(result.value.route_id).toBe("custom/local-model");
            expect(result.value.provider).toBe("custom");
            expect(result.value.provider_model_id).toBe("local-model");
            expect(result.value.display_name).toBe("local-model");
        });

        test("exact route_id for a model that does not exist in the catalog returns model_not_found (no passthrough fallback)", () => {
            const catalog = buildFixture();
            const configured = new Set<ProviderId>(["azure"]);
            const result = resolveRoute(classifyInput("azure/nonexistent"), {
                catalog,
                configuredProviders: configured,
            });
            const error = expectNotFound(result);
            expect(error.message).toContain("azure/nonexistent");
        });

        test("unqualified id resolved against a single configured provider returns that row", () => {
            const catalog = buildFixture();
            const configured = new Set<ProviderId>(["azure"]);
            const result = resolveRoute(classifyInput("gpt-4o"), {
                catalog,
                configuredProviders: configured,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) {
                return;
            }
            expect(result.value.route_id).toBe("azure/gpt-4o");
            expect(result.value.provider).toBe("azure");
        });

        test("unqualified id resolves cleanly under partial config and skips configured passthrough custom", () => {
            const catalog = buildFixture();

            const azureOnly = resolveRoute(classifyInput("shared"), {
                catalog,
                configuredProviders: new Set<ProviderId>(["azure"]),
            });
            expect(azureOnly.ok).toBe(true);
            if (azureOnly.ok) {
                expect(azureOnly.value.route_id).toBe("azure/shared");
                expect(azureOnly.value.provider).toBe("azure");
            }

            const azureAndCustom = resolveRoute(classifyInput("shared"), {
                catalog,
                configuredProviders: new Set<ProviderId>(["azure", "custom"]),
            });
            expect(azureAndCustom.ok).toBe(true);
            if (azureAndCustom.ok) {
                expect(azureAndCustom.value.route_id).toBe("azure/shared");
                expect(azureAndCustom.value.provider).toBe("azure");
            }

            const customOnly = resolveRoute(classifyInput("local-model"), {
                catalog,
                configuredProviders: new Set<ProviderId>(["custom"]),
            });
            const error = expectNotFound(customOnly);
            expect(error.input).toBe("local-model");
        });

        test("unqualified id exposed by multiple providers returns ambiguous_model with sorted candidates", () => {
            const catalog = buildFixture();
            const configured = new Set<ProviderId>(["azure", "anthropic"]);
            const result = resolveRoute(classifyInput("shared"), {
                catalog,
                configuredProviders: configured,
            });
            const error = expectAmbiguity(result);
            expect(error.candidates).toEqual(["anthropic/shared", "azure/shared"]);
        });

        test("unqualified id with no catalog match returns model_not_found", () => {
            const catalog = buildFixture();
            const configured = new Set<ProviderId>(["azure", "anthropic", "openrouter"]);
            const result = resolveRoute(classifyInput("nonexistent-model"), {
                catalog,
                configuredProviders: configured,
            });
            const error = expectNotFound(result);
            expect(error.input).toBe("nonexistent-model");
        });

        test("unknown route prefixes return the generic parse failure", () => {
            for (const input of ["openai/gpt-5.2", "not-a-provider/model"]) {
                const result = resolveRoute(classifyInput(input), {
                    catalog: buildFixture(),
                    configuredProviders: new Set<ProviderId>(["azure"]),
                });
                const error = expectNotFound(result);
                expect(error.message).toContain("provider/model");
            }
        });
    });
});

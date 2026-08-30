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
        throw new Error(
            `expected not-found result, got success: ${JSON.stringify(result.value)}`,
        );
    }
    if (result.error.code !== "model_not_found") {
        throw new Error(
            `expected model_not_found, got ${result.error.code}: ${result.error.message}`,
        );
    }
    return result.error;
};

const expectAmbiguity = (result: ResolveRouteResult): AmbiguityError => {
    if (result.ok) {
        throw new Error(
            `expected ambiguity, got success: ${JSON.stringify(result.value)}`,
        );
    }
    if (result.error.code !== "ambiguous_model") {
        throw new Error(
            `expected ambiguous_model, got ${result.error.code}: ${result.error.message}`,
        );
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
                { input: "gpt-5.2", want: undefined },
                { input: "unknown-provider/model", want: undefined },
                { input: "azure/", want: undefined },
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
        test("exact route_id for a configured catalog-backed provider returns the row", async () => {
            const catalog = buildFixture();
            const configured = new Set<ProviderId>(["azure"]);
            const result = await resolveRoute(classifyInput("azure/gpt-5.2"), {
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

        test("exact route_id for an unconfigured provider returns model_not_found", async () => {
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
                const result = await resolveRoute(classifyInput(input), {
                    catalog: buildFixture(),
                    configuredProviders: new Set(configured),
                });
                const error = expectNotFound(result);
                expect(error.message.toLowerCase()).toContain(provider);
                expect(error.message.toLowerCase()).toContain("not configured");
            }
        });

        test("exact route_id for a configured passthrough provider returns a synthetic row", async () => {
            const catalog = buildFixture();
            const configured = new Set<ProviderId>(["custom"]);
            const result = await resolveRoute(
                classifyInput("custom/local-model"),
                { catalog, configuredProviders: configured },
            );
            expect(result.ok).toBe(true);
            if (!result.ok) {
                return;
            }
            expect(result.value.route_id).toBe("custom/local-model");
            expect(result.value.provider).toBe("custom");
            expect(result.value.provider_model_id).toBe("local-model");
            expect(result.value.display_name).toBe("local-model");
        });

        test("exact route_id for a model that does not exist in the catalog returns model_not_found (no passthrough fallback)", async () => {
            const catalog = buildFixture();
            const configured = new Set<ProviderId>(["azure"]);
            const result = await resolveRoute(
                classifyInput("azure/nonexistent"),
                { catalog, configuredProviders: configured },
            );
            const error = expectNotFound(result);
            expect(error.message).toContain("azure/nonexistent");
        });

        test("unqualified id resolved against a single configured provider returns that row", async () => {
            const catalog = buildFixture();
            const configured = new Set<ProviderId>(["azure"]);
            const result = await resolveRoute(classifyInput("gpt-4o"), {
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

        test("unqualified id exposed by multiple providers returns ambiguous_model with sorted candidates", async () => {
            const catalog = buildFixture();
            const configured = new Set<ProviderId>(["azure", "anthropic"]);
            const result = await resolveRoute(classifyInput("shared"), {
                catalog,
                configuredProviders: configured,
            });
            const error = expectAmbiguity(result);
            expect(error.candidates).toEqual([
                "anthropic/shared",
                "azure/shared",
            ]);
        });

        test("unqualified id with no catalog match returns model_not_found", async () => {
            const catalog = buildFixture();
            const configured = new Set<ProviderId>([
                "azure",
                "anthropic",
                "openrouter",
            ]);
            const result = await resolveRoute(
                classifyInput("nonexistent-model"),
                { catalog, configuredProviders: configured },
            );
            const error = expectNotFound(result);
            expect(error.input).toBe("nonexistent-model");
        });

        test("unknown route prefixes return the generic parse failure", async () => {
            for (const input of ["openai/gpt-5.2", "not-a-provider/model"]) {
                const result = await resolveRoute(classifyInput(input), {
                    catalog: buildFixture(),
                    configuredProviders: new Set<ProviderId>(["azure"]),
                });
                const error = expectNotFound(result);
                expect(error.message).toContain("provider/model");
            }
        });
    });
});

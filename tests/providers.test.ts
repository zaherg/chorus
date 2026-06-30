import { afterEach, describe, expect, test } from "bun:test";

import { customProviderBaseUrl } from "@/providers/custom-url";
import { createProviderRegistry } from "@/providers/registry";
import {
    BrokerModelInfoSchema,
    type ModelsListResponse,
    type ProviderId,
    providerIdValues,
} from "@/types/providers";
import { testConfig } from "./helpers";

const openaiCatalog = (): ModelsListResponse => {
    const gpt = BrokerModelInfoSchema.parse({
        route_id: "openai/gpt-5.2",
        provider: "openai",
        provider_model_id: "gpt-5.2",
        display_name: "GPT-5.2",
    });
    return {
        schema: "models.list/1",
        cache: {
            status: "fresh",
            fetched_at: "2026-01-01T00:00:00.000Z",
            expires_at: "2026-01-02T00:00:00.000Z",
        },
        providers: {
            openai: { status: "catalog", models: [gpt] },
        },
    };
};

const openaiConfigured = (): ReadonlySet<ProviderId> =>
    new Set<ProviderId>(["openai"]);

describe("ProviderRegistry", () => {
    afterEach(() => {});

    describe("custom provider URL validation", () => {
        test("allows explicit loopback custom provider URLs for local OpenAI-compatible servers", async () => {
            expect(
                await customProviderBaseUrl("http://localhost:11434/v1", false),
            ).toBe("http://localhost:11434/v1");
        });

        test("still rejects non-loopback insecure custom provider URLs by default", async () => {
            await expect(
                customProviderBaseUrl("http://example.com/v1", false),
            ).rejects.toThrow(
                "custom_url must use https:// unless allow_insecure_custom is set to true",
            );
        });

        test("rejects IPv4-mapped IPv6 custom provider URLs for private hosts", async () => {
            for (const url of [
                "https://[::ffff:169.254.169.254]/v1",
                "https://[::ffff:192.168.1.1]/v1",
                "https://[::ffff:10.0.0.1]/v1",
                "https://[::ffff:a9fe:a9fe]/v1",
                "https://[::ffff:c0a8:101]/v1",
            ]) {
                await expect(customProviderBaseUrl(url, false)).rejects.toThrow(
                    "custom_url host is not allowed",
                );
            }
        });

        test("treats IPv4-mapped loopback like the equivalent IPv4 host", async () => {
            expect(
                await customProviderBaseUrl(
                    "http://[::ffff:127.0.0.1]/v1",
                    false,
                ),
            ).toBe("http://[::ffff:7f00:1]/v1");
        });
    });

    describe("isProviderConfigured", () => {
        test("returns false for every provider when no API keys are set", () => {
            const registry = createProviderRegistry(testConfig());
            for (const id of providerIdValues) {
                expect(registry.isProviderConfigured(id)).toBeFalse();
            }
        });

        test("returns true for the provider whose API key is set", () => {
            const registry = createProviderRegistry(
                testConfig({ xai_api_key: "xai-key" }),
            );
            expect(registry.isProviderConfigured("xai")).toBeTrue();
        });

        test("returns false for the provider whose API key is not set", () => {
            const registry = createProviderRegistry(
                testConfig({ xai_api_key: "xai-key" }),
            );
            expect(registry.isProviderConfigured("openai")).toBeFalse();
        });

        test("returns false when the API key is an unresolved environment variable reference", () => {
            const registry = createProviderRegistry(
                testConfig({ openai_api_key: "$OPENAI_API_KEY" }),
            );
            expect(registry.isProviderConfigured("openai")).toBeFalse();
        });

        test("returns false for custom provider when API key is unresolved even with valid URL", () => {
            const registry = createProviderRegistry(
                testConfig({
                    custom_url: "https://my-custom.example.com/v1",
                    custom_api_key: "$CUSTOM_API_KEY",
                }),
            );
            expect(registry.isProviderConfigured("custom")).toBeFalse();
        });
    });

    describe("providerConfigurationErrorMessage", () => {
        test("mentions every required config key for the custom provider", () => {
            const registry = createProviderRegistry(testConfig());
            const message = registry.generateText("openai/gpt-5.2", "hi");
            return message.then((result) => {
                expect(result.ok).toBeFalse();
                if (result.ok) return;
                // No catalog/configured providers means we never get to the
                // configuration check, but the shape must still be a Result.
                expect(result.error).toBeDefined();
                // We instead exercise the message helper directly.
                const {
                    providerConfigurationErrorMessage,
                } = require("@/providers/registry");
                const msg: string = providerConfigurationErrorMessage("custom");
                expect(msg).toContain("custom_url");
                expect(msg).toContain("custom_api_key");
            });
        });
    });

    describe("generateText", () => {
        test("calls the AI SDK through an injected generateText implementation", async () => {
            const calls: Array<Record<string, unknown>> = [];
            const registry = createProviderRegistry(
                testConfig({ openai_api_key: "openai-key" }),
                {
                    generateTextFn: async (args) => {
                        calls.push(args as Record<string, unknown>);
                        return {
                            finishReason: "stop",
                            providerMetadata: undefined,
                            reasoning: [],
                            request: {},
                            response: {
                                id: "resp_123",
                                modelId: "gpt-5.2",
                                timestamp: new Date("2026-03-10T12:00:00.000Z"),
                            },
                            steps: [],
                            text: "hello back",
                            usage: {
                                inputTokens: 12,
                                outputTokens: 4,
                                totalTokens: 16,
                            },
                            warnings: undefined,
                        } as never;
                    },
                },
            );

            const result = await registry.generateText(
                "openai/gpt-5.2",
                "hello",
                "system text",
                {
                    catalog: openaiCatalog(),
                    configuredProviders: openaiConfigured(),
                    temperature: 0.2,
                },
            );

            expect(calls).toHaveLength(1);
            expect(result.ok).toBeTrue();
            if (result.ok) {
                expect(result.value.text).toBe("hello back");
                expect(result.value.model).toBe("openai/gpt-5.2");
            }
        });

        test("adds a provider timeout abort signal to SDK calls", async () => {
            const calls: Array<Record<string, unknown>> = [];
            const registry = createProviderRegistry(
                testConfig({
                    provider_timeout_ms: 1234,
                    openai_api_key: "openai-key",
                }),
                {
                    generateTextFn: async (args) => {
                        calls.push(args as Record<string, unknown>);
                        return {
                            response: {
                                modelId: "gpt-5.2",
                                timestamp: new Date("2026-03-10T12:00:00.000Z"),
                            },
                            text: "hello back",
                            usage: {
                                inputTokens: 12,
                                outputTokens: 4,
                                totalTokens: 16,
                            },
                        } as never;
                    },
                },
            );

            const result = await registry.generateText(
                "openai/gpt-5.2",
                "hello",
                undefined,
                {
                    catalog: openaiCatalog(),
                    configuredProviders: openaiConfigured(),
                },
            );

            expect(result.ok).toBeTrue();
            expect(calls).toHaveLength(1);
            expect(calls[0]?.abortSignal).toBeInstanceOf(AbortSignal);
        });

        test("returns a timeout error when the provider request is aborted", async () => {
            const registry = createProviderRegistry(
                testConfig({ openai_api_key: "openai-key" }),
                {
                    generateTextFn: async () => {
                        throw new DOMException(
                            "The operation was aborted.",
                            "AbortError",
                        );
                    },
                },
            );

            const result = await registry.generateText(
                "openai/gpt-5.2",
                "hello",
                undefined,
                {
                    catalog: openaiCatalog(),
                    configuredProviders: openaiConfigured(),
                },
            );

            expect(result.ok).toBeFalse();
            if (!result.ok) {
                expect(result.error.type).toBe("timeout");
                expect(result.error.message).toBe("Provider request timed out");
                expect(result.error.retryable).toBeTrue();
            }
        });

        test("returns a timeout error when the provider request reaches its deadline", async () => {
            const registry = createProviderRegistry(
                testConfig({ openai_api_key: "openai-key" }),
                {
                    generateTextFn: async () => {
                        throw new DOMException(
                            "The operation timed out.",
                            "TimeoutError",
                        );
                    },
                },
            );

            const result = await registry.generateText(
                "openai/gpt-5.2",
                "hello",
                undefined,
                {
                    catalog: openaiCatalog(),
                    configuredProviders: openaiConfigured(),
                },
            );

            expect(result.ok).toBeFalse();
            if (!result.ok) {
                expect(result.error.type).toBe("timeout");
                expect(result.error.message).toBe("Provider request timed out");
                expect(result.error.retryable).toBeTrue();
            }
        });

        test("does not log raw provider exception details", async () => {
            const originalConsoleError = console.error;
            const errors: unknown[][] = [];
            console.error = (...args: unknown[]) => {
                errors.push(args);
            };

            try {
                const registry = createProviderRegistry(
                    testConfig({ openai_api_key: "openai-key" }),
                    {
                        generateTextFn: async () => {
                            throw new Error(
                                "upstream error leaked sk-test-secret-value",
                            );
                        },
                    },
                );

                const result = await registry.generateText(
                    "openai/gpt-5.2",
                    "hello",
                    undefined,
                    {
                        catalog: openaiCatalog(),
                        configuredProviders: openaiConfigured(),
                    },
                );

                expect(result.ok).toBeFalse();
                if (!result.ok) {
                    expect(result.error.message).toBe(
                        "Provider request failed",
                    );
                }

                const stderr = errors
                    .flat()
                    .map((arg) =>
                        arg instanceof Error ? arg.message : String(arg),
                    )
                    .join("\n");
                expect(stderr).not.toContain("sk-test-secret-value");
            } finally {
                console.error = originalConsoleError;
            }
        });

        test("returns a model_not_found error for unknown models", async () => {
            const registry = createProviderRegistry(
                testConfig({ openai_api_key: "openai-key" }),
            );
            const result = await registry.generateText(
                "nonexistent-model",
                "hello",
                undefined,
                {
                    catalog: openaiCatalog(),
                    configuredProviders: openaiConfigured(),
                },
            );
            expect(result.ok).toBeFalse();
            if (!result.ok) {
                expect(result.error.type).toBe("not_found");
                expect(result.error.message).toContain("nonexistent-model");
            }
        });

        test("returns a not_found error when no catalog is provided", async () => {
            const registry = createProviderRegistry(
                testConfig({ openai_api_key: "openai-key" }),
            );
            const result = await registry.generateText(
                "openai/gpt-5.2",
                "hello",
            );
            expect(result.ok).toBeFalse();
            if (!result.ok) {
                expect(result.error.type).toBe("not_found");
            }
        });

        test("returns a model_not_found error when the provider is not configured", async () => {
            const registry = createProviderRegistry(testConfig());
            const result = await registry.generateText(
                "openai/gpt-5.2",
                "hello",
                undefined,
                {
                    catalog: openaiCatalog(),
                    configuredProviders: new Set<ProviderId>(),
                },
            );
            expect(result.ok).toBeFalse();
            if (!result.ok) {
                expect(result.error.type).toBe("not_found");
                expect(result.error.message).toContain("openai/gpt-5.2");
            }
        });

        test("routes provider-prefixed passthrough IDs to the correct factory", async () => {
            const emptyCatalog = (): ModelsListResponse => ({
                schema: "models.list/1",
                cache: {
                    status: "fresh",
                    fetched_at: "2026-01-01T00:00:00.000Z",
                    expires_at: "2026-01-02T00:00:00.000Z",
                },
                providers: {},
            });
            const providerModelIds: string[] = [];
            const registry = createProviderRegistry(
                testConfig({ gateway_api_key: "gateway-key" }),
                {
                    providerFactories: {
                        gateway: {
                            languageModel: (modelId) => {
                                providerModelIds.push(modelId);
                                return { modelId } as never;
                            },
                        },
                    },
                    generateTextFn: async () =>
                        ({
                            response: {
                                modelId: "example-model",
                                timestamp: new Date("2026-03-10T12:00:00.000Z"),
                            },
                            text: "gateway response",
                            usage: {
                                inputTokens: 2,
                                outputTokens: 3,
                                totalTokens: 5,
                            },
                        }) as never,
                },
            );

            const result = await registry.generateText(
                "gateway/example-model",
                "hello",
                undefined,
                {
                    catalog: emptyCatalog(),
                    configuredProviders: new Set<ProviderId>(["gateway"]),
                },
            );

            expect(result.ok).toBeTrue();
            expect(providerModelIds).toEqual(["example-model"]);
        });
    });

    describe("custom provider factory", () => {
        test("creates custom provider factory with safe fetch", async () => {
            let capturedModel: unknown = null;
            const registry = createProviderRegistry(
                testConfig({
                    custom_api_key: "test-key",
                    custom_url: "http://localhost:11434/v1",
                }),
                {
                    generateTextFn: async (args) => {
                        capturedModel = args.model;
                        return {
                            text: "ok",
                            usage: {
                                inputTokens: 1,
                                outputTokens: 1,
                                totalTokens: 2,
                            },
                            response: {
                                modelId: "default",
                                timestamp: new Date(),
                            },
                        } as never;
                    },
                },
            );

            const customModel = BrokerModelInfoSchema.parse({
                route_id: "custom/default",
                provider: "custom",
                provider_model_id: "default",
                display_name: "Custom Default",
            });
            const catalog: ModelsListResponse = {
                schema: "models.list/1",
                cache: {
                    status: "fresh",
                    fetched_at: "2026-01-01T00:00:00.000Z",
                    expires_at: "2026-01-02T00:00:00.000Z",
                },
                providers: {
                    custom: { status: "catalog", models: [customModel] },
                },
            };

            const result = await registry.generateText(
                "custom/default",
                "hello",
                undefined,
                {
                    catalog,
                    configuredProviders: new Set<ProviderId>(["custom"]),
                },
            );

            expect(result.ok).toBeTrue();
            expect(capturedModel).toBeTruthy();
            if (capturedModel) {
                const m = capturedModel as { modelId?: string };
                expect(m.modelId).toBe("default");
            }
        });
    });

    describe("custom provider configuration", () => {
        test("is configured only when both URL and API key are set", () => {
            const urlOnlyRegistry = createProviderRegistry(
                testConfig({ custom_url: "https://example.com/v1" }),
            );
            const keyOnlyRegistry = createProviderRegistry(
                testConfig({ custom_api_key: "custom-key" }),
            );
            const completeRegistry = createProviderRegistry(
                testConfig({
                    custom_api_key: "custom-key",
                    custom_url: "https://example.com/v1",
                }),
            );

            expect(urlOnlyRegistry.isProviderConfigured("custom")).toBeFalse();
            expect(keyOnlyRegistry.isProviderConfigured("custom")).toBeFalse();
            expect(completeRegistry.isProviderConfigured("custom")).toBeTrue();
        });

        test("configuration errors mention URL and API key", async () => {
            const registry = createProviderRegistry(testConfig());
            // Build a catalog with a custom model so resolution succeeds and
            // we hit the configuration check.
            const customModel = BrokerModelInfoSchema.parse({
                route_id: "custom/default",
                provider: "custom",
                provider_model_id: "default",
                display_name: "Custom Default",
            });
            const catalog: ModelsListResponse = {
                schema: "models.list/1",
                cache: {
                    status: "fresh",
                    fetched_at: "2026-01-01T00:00:00.000Z",
                    expires_at: "2026-01-02T00:00:00.000Z",
                },
                providers: {
                    custom: { status: "catalog", models: [customModel] },
                },
            };
            const result = await registry.generateText(
                "custom/default",
                "hello",
                undefined,
                {
                    catalog,
                    configuredProviders: new Set<ProviderId>(["custom"]),
                },
            );
            expect(result.ok).toBeFalse();
            if (!result.ok) {
                expect(result.error.type).toBe("configuration");
                expect(result.error.message).toContain("custom_url");
                expect(result.error.message).toContain("custom_api_key");
            }
        });
    });
});

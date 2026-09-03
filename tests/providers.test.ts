import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { customProviderBaseUrl } from "@/providers/custom-url";
import { createProviderRegistry } from "@/providers/registry";
import { BrokerModelInfoSchema, type ModelsListResponse, type ProviderId, providerIdValues } from "@/types/providers";
import { testConfig } from "./helpers";

const openrouterCatalog = (): ModelsListResponse => {
    const gpt = BrokerModelInfoSchema.parse({
        route_id: "openrouter/openai/gpt-5.2",
        provider: "openrouter",
        provider_model_id: "openai/gpt-5.2",
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
            openrouter: { status: "catalog", models: [gpt] },
        },
    };
};

const openrouterConfigured = (): ReadonlySet<ProviderId> => new Set<ProviderId>(["openrouter"]);

describe("ProviderRegistry", () => {
    afterEach(() => {
        mock.restore();
    });

    describe("custom provider URL validation", () => {
        test("allows loopback custom provider URLs", async () => {
            const cases = [
                {
                    input: "http://localhost:11434/v1",
                    expected: "http://localhost:11434/v1",
                },
                {
                    input: "http://[::ffff:127.0.0.1]/v1",
                    expected: "http://[::ffff:7f00:1]/v1",
                },
            ];

            for (const { input, expected } of cases) {
                expect(await customProviderBaseUrl(input, false)).toBe(expected);
            }
        });

        test("still rejects non-loopback insecure custom provider URLs by default", async () => {
            await expect(customProviderBaseUrl("http://example.com/v1", false)).rejects.toThrow(
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
                await expect(customProviderBaseUrl(url, false)).rejects.toThrow("custom_url host is not allowed");
            }
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
            const registry = createProviderRegistry(testConfig({ azure_api_key: "azure-key" }));
            expect(registry.isProviderConfigured("azure")).toBeTrue();
        });

        test("returns false for the provider whose API key is not set", () => {
            const registry = createProviderRegistry(testConfig({ azure_api_key: "azure-key" }));
            expect(registry.isProviderConfigured("openrouter")).toBeFalse();
        });

        test("returns false when the API key is an unresolved environment variable reference", () => {
            const registry = createProviderRegistry(testConfig({ openrouter_api_key: "$OPENROUTER_API_KEY" }));
            expect(registry.isProviderConfigured("openrouter")).toBeFalse();
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

    describe("generateText", () => {
        test("calls the AI SDK through an injected generateText implementation", async () => {
            const calls: Array<Record<string, unknown>> = [];
            const registry = createProviderRegistry(testConfig({ openrouter_api_key: "openrouter-key" }), {
                generateTextFn: async (args) => {
                    calls.push(args as Record<string, unknown>);
                    return {
                        finishReason: "stop",
                        providerMetadata: undefined,
                        reasoning: [],
                        request: {},
                        response: {
                            id: "resp_123",
                            modelId: "openai/gpt-5.2",
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
            });

            const result = await registry.generateText("openrouter/openai/gpt-5.2", "hello", "system text", {
                catalog: openrouterCatalog(),
                configuredProviders: openrouterConfigured(),
                temperature: 0.2,
            });

            expect(calls).toHaveLength(1);
            expect(calls[0]).not.toHaveProperty("providerOptions");
            expect(result.ok).toBeTrue();
            if (result.ok) {
                expect(result.value.text).toBe("hello back");
                expect(result.value.model).toBe("openrouter/openai/gpt-5.2");
            }
        });

        test("maps thinking modes to OpenRouter reasoning effort", async () => {
            const calls: Array<Record<string, unknown>> = [];
            const registry = createProviderRegistry(testConfig({ openrouter_api_key: "openrouter-key" }), {
                providerFactories: {
                    openrouter: {
                        languageModel: (modelId) => ({ modelId }) as never,
                    },
                },
                generateTextFn: async (args) => {
                    calls.push(args as Record<string, unknown>);
                    return {
                        response: {
                            modelId: "openai/gpt-5.2",
                            timestamp: new Date("2026-08-27T00:00:00.000Z"),
                        },
                        text: "response",
                        usage: {
                            inputTokens: 1,
                            outputTokens: 1,
                            totalTokens: 2,
                        },
                    } as never;
                },
            });

            const expectedEfforts = [
                ["minimal", "minimal"],
                ["low", "low"],
                ["medium", "medium"],
                ["high", "high"],
                ["max", "xhigh"],
            ] as const;

            for (const [thinkingMode] of expectedEfforts) {
                const result = await registry.generateText("openrouter/openai/gpt-5.2", "hello", undefined, {
                    catalog: openrouterCatalog(),
                    configuredProviders: openrouterConfigured(),
                    thinkingMode,
                });
                expect(result.ok).toBeTrue();
            }

            expect(calls.map((call) => call.providerOptions)).toEqual(
                expectedEfforts.map(([, effort]) => ({
                    openrouter: { reasoning: { effort } },
                })),
            );
        });

        test("adds a provider timeout abort signal to SDK calls", async () => {
            const timeoutId = 1 as unknown as ReturnType<typeof setTimeout>;
            const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockReturnValue(timeoutId);
            spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
            const calls: Array<Record<string, unknown>> = [];
            const registry = createProviderRegistry(
                testConfig({
                    provider_timeout_ms: 1234,
                    openrouter_api_key: "openrouter-key",
                }),
                {
                    generateTextFn: async (args) => {
                        calls.push(args as Record<string, unknown>);
                        return {
                            response: {
                                modelId: "openai/gpt-5.2",
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

            const result = await registry.generateText("openrouter/openai/gpt-5.2", "hello", undefined, {
                catalog: openrouterCatalog(),
                configuredProviders: openrouterConfigured(),
            });

            expect(result.ok).toBeTrue();
            expect(calls).toHaveLength(1);
            expect(calls[0]?.abortSignal).toBeInstanceOf(AbortSignal);
            expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1234);
        });

        test("uses the fallback provider timeout when configured timeout is zero", async () => {
            const timeoutId = 1 as unknown as ReturnType<typeof setTimeout>;
            const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockReturnValue(timeoutId);
            spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
            const registry = createProviderRegistry(
                testConfig({
                    provider_timeout_ms: 0,
                    openrouter_api_key: "openrouter-key",
                }),
                {
                    generateTextFn: async () => {
                        return {
                            response: {
                                modelId: "openai/gpt-5.2",
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

            const result = await registry.generateText("openrouter/openai/gpt-5.2", "hello", undefined, {
                catalog: openrouterCatalog(),
                configuredProviders: openrouterConfigured(),
            });

            expect(result.ok).toBeTrue();
            expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1_800_000);
        });

        test("clears the provider timeout when the SDK call rejects", async () => {
            const timeoutId = 1 as unknown as ReturnType<typeof setTimeout>;
            const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockReturnValue(timeoutId);
            const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
            const parentController = new AbortController();
            const removeEventListenerSpy = spyOn(parentController.signal, "removeEventListener");
            const registry = createProviderRegistry(testConfig({ openrouter_api_key: "openrouter-key" }), {
                generateTextFn: async () => {
                    throw new Error("provider rejected");
                },
            });

            const result = await registry.generateText("openrouter/openai/gpt-5.2", "hello", undefined, {
                abortSignal: parentController.signal,
                catalog: openrouterCatalog(),
                configuredProviders: openrouterConfigured(),
            });

            expect(result.ok).toBeFalse();
            expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
            expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutId);
            expect(removeEventListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function));
        });

        test("maps provider cancellation failures to retryable timeouts", async () => {
            const cases = [
                {
                    message: "The operation was aborted.",
                    name: "AbortError",
                },
                {
                    message: "The operation timed out.",
                    name: "TimeoutError",
                },
            ];

            for (const { message, name } of cases) {
                const registry = createProviderRegistry(testConfig({ openrouter_api_key: "openrouter-key" }), {
                    generateTextFn: async () => {
                        throw new DOMException(message, name);
                    },
                });
                const result = await registry.generateText("openrouter/openai/gpt-5.2", "hello", undefined, {
                    catalog: openrouterCatalog(),
                    configuredProviders: openrouterConfigured(),
                });

                expect(result.ok).toBeFalse();
                if (!result.ok) {
                    expect(result.error.type).toBe("timeout");
                    expect(result.error.message).toBe("Provider request timed out");
                    expect(result.error.retryable).toBeTrue();
                }
            }
        });

        test("does not log raw provider exception details", async () => {
            const originalConsoleError = console.error;
            const errors: unknown[][] = [];
            console.error = (...args: unknown[]) => {
                errors.push(args);
            };

            try {
                const registry = createProviderRegistry(testConfig({ openrouter_api_key: "openrouter-key" }), {
                    generateTextFn: async () => {
                        throw new Error("upstream error leaked sk-test-secret-value");
                    },
                });

                const result = await registry.generateText("openrouter/openai/gpt-5.2", "hello", undefined, {
                    catalog: openrouterCatalog(),
                    configuredProviders: openrouterConfigured(),
                });

                expect(result.ok).toBeFalse();
                if (!result.ok) {
                    expect(result.error.message).toBe("Provider request failed");
                }

                const stderr = errors
                    .flat()
                    .map((arg) => (arg instanceof Error ? arg.message : String(arg)))
                    .join("\n");
                expect(stderr).not.toContain("sk-test-secret-value");
            } finally {
                console.error = originalConsoleError;
            }
        });

        test("returns a model_not_found error for unknown models", async () => {
            const registry = createProviderRegistry(testConfig({ openrouter_api_key: "openrouter-key" }));
            const result = await registry.generateText("nonexistent-model", "hello", undefined, {
                catalog: openrouterCatalog(),
                configuredProviders: openrouterConfigured(),
            });
            expect(result.ok).toBeFalse();
            if (!result.ok) {
                expect(result.error.type).toBe("not_found");
                expect(result.error.message).toContain("nonexistent-model");
            }
        });

        test("returns a not_found error when no catalog is provided", async () => {
            const registry = createProviderRegistry(testConfig({ openrouter_api_key: "openrouter-key" }));
            const result = await registry.generateText("openrouter/openai/gpt-5.2", "hello");
            expect(result.ok).toBeFalse();
            if (!result.ok) {
                expect(result.error.type).toBe("not_found");
            }
        });

        test("returns a model_not_found error when the provider is not configured", async () => {
            const registry = createProviderRegistry(testConfig());
            const result = await registry.generateText("openrouter/openai/gpt-5.2", "hello", undefined, {
                catalog: openrouterCatalog(),
                configuredProviders: new Set<ProviderId>(),
            });
            expect(result.ok).toBeFalse();
            if (!result.ok) {
                expect(result.error.type).toBe("not_found");
                expect(result.error.message).toContain("openrouter/openai/gpt-5.2");
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
                testConfig({
                    custom_api_key: "custom-key",
                    custom_url: "https://custom.example.com/v1",
                }),
                {
                    providerFactories: {
                        custom: {
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
                            text: "custom response",
                            usage: {
                                inputTokens: 2,
                                outputTokens: 3,
                                totalTokens: 5,
                            },
                        }) as never,
                },
            );

            const result = await registry.generateText("custom/example-model", "hello", undefined, {
                catalog: emptyCatalog(),
                configuredProviders: new Set<ProviderId>(["custom"]),
            });

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

            const result = await registry.generateText("custom/default", "hello", undefined, {
                catalog,
                configuredProviders: new Set<ProviderId>(["custom"]),
            });

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
            const urlOnlyRegistry = createProviderRegistry(testConfig({ custom_url: "https://example.com/v1" }));
            const keyOnlyRegistry = createProviderRegistry(testConfig({ custom_api_key: "custom-key" }));
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
            const result = await registry.generateText("custom/default", "hello", undefined, {
                catalog,
                configuredProviders: new Set<ProviderId>(["custom"]),
            });
            expect(result.ok).toBeFalse();
            if (!result.ok) {
                expect(result.error.type).toBe("configuration");
                expect(result.error.message).toContain("custom_url");
                expect(result.error.message).toContain("custom_api_key");
            }
        });
    });
});

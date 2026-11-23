import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { APICallError, RetryError } from "ai";

import { customProviderBaseUrl } from "@/providers/custom-url";
import { createProviderRegistry, ThinkingModeSchema, thinkingModeValues } from "@/providers/registry";
import { BrokerModelInfoSchema, type ModelsListResponse, type ProviderId, providerIdValues } from "@/types/providers";
import { testConfig } from "./helpers";

const PROVIDER_ENV_KEYS = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
    "AWS_ENDPOINT_URL",
    "AZURE_RESOURCE_NAME",
    "GOOGLE_VERTEX_PROJECT",
    "GOOGLE_VERTEX_LOCATION",
] as const;

const withProviderEnv = (overrides: Record<string, string | undefined>, run: () => void): void => {
    const originals = new Map<string, string | undefined>();
    const keys = new Set<string>([...PROVIDER_ENV_KEYS, ...Object.keys(overrides)]);
    for (const key of keys) {
        originals.set(key, process.env[key]);
        const nextValue = overrides[key];
        if (nextValue === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = nextValue;
        }
    }

    try {
        run();
    } finally {
        for (const [key, original] of originals) {
            if (original === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = original;
            }
        }
    }
};

const expectRejectedError = async (promise: Promise<unknown>): Promise<Error> => {
    try {
        await promise;
    } catch (error: unknown) {
        return error instanceof Error ? error : new Error(String(error));
    }
    throw new Error("Expected promise to reject");
};

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
            const err = await expectRejectedError(customProviderBaseUrl("http://example.com/v1", false));
            expect(err.message).toContain("custom_url must use https:// unless allow_insecure_custom is set to true");
        });

        test("rejects IPv4-mapped IPv6 custom provider URLs for private hosts", async () => {
            for (const url of [
                "https://[::ffff:169.254.169.254]/v1",
                "https://[::ffff:192.168.1.1]/v1",
                "https://[::ffff:10.0.0.1]/v1",
                "https://[::ffff:a9fe:a9fe]/v1",
                "https://[::ffff:c0a8:101]/v1",
            ]) {
                const err = await expectRejectedError(customProviderBaseUrl(url, false));
                expect(err.message).toContain("custom_url host is not allowed");
            }
        });
    });

    describe("ThinkingModeSchema", () => {
        test("accepts all supported thinking mode values and rejects invalid values", () => {
            expect(thinkingModeValues).toEqual(["minimal", "low", "medium", "high", "max"]);
            for (const value of thinkingModeValues) {
                expect(ThinkingModeSchema.parse(value)).toBe(value);
            }
            expect(ThinkingModeSchema.safeParse("extreme").success).toBeFalse();
        });
    });

    describe("isProviderConfigured", () => {
        test("returns false for every provider when no API keys or cloud env vars are set", () => {
            withProviderEnv({}, () => {
                const registry = createProviderRegistry(testConfig());
                for (const id of providerIdValues) {
                    expect(registry.isProviderConfigured(id)).toBeFalse();
                }
            });
        });

        test("returns true for Azure only when API key and resource name or base URL are set", () => {
            withProviderEnv({}, () => {
                expect(
                    createProviderRegistry(testConfig({ azure_api_key: "azure-key" })).isProviderConfigured("azure"),
                ).toBeFalse();
                expect(
                    createProviderRegistry(
                        testConfig({ azure_api_key: "azure-key", azure_resource_name: "my-azure" }),
                    ).isProviderConfigured("azure"),
                ).toBeTrue();
                expect(
                    createProviderRegistry(
                        testConfig({ azure_api_key: "azure-key", azure_base_url: "https://my-azure.openai.azure.com" }),
                    ).isProviderConfigured("azure"),
                ).toBeTrue();
                expect(
                    createProviderRegistry(
                        testConfig({ azure_api_key: "azure-key", azure_resource_name: `\${AZURE_RESOURCE_NAME}` }),
                    ).isProviderConfigured("azure"),
                ).toBeFalse();
            });

            withProviderEnv({ AZURE_RESOURCE_NAME: "env-azure" }, () => {
                expect(
                    createProviderRegistry(testConfig({ azure_api_key: "azure-key" })).isProviderConfigured("azure"),
                ).toBeTrue();
            });
        });

        test("returns true for Amazon Bedrock when auth and region or endpoint are set", () => {
            withProviderEnv({}, () => {
                expect(
                    createProviderRegistry(testConfig({ amazon_bedrock_api_key: "bedrock-key" })).isProviderConfigured(
                        "amazon-bedrock",
                    ),
                ).toBeFalse();
                expect(
                    createProviderRegistry(
                        testConfig({ amazon_bedrock_api_key: "bedrock-key", amazon_bedrock_region: "us-east-1" }),
                    ).isProviderConfigured("amazon-bedrock"),
                ).toBeTrue();
            });

            withProviderEnv({ AWS_REGION: "us-west-2" }, () => {
                expect(
                    createProviderRegistry(testConfig({ amazon_bedrock_api_key: "bedrock-key" })).isProviderConfigured(
                        "amazon-bedrock",
                    ),
                ).toBeTrue();
            });

            withProviderEnv(
                {
                    AWS_ACCESS_KEY_ID: "AKIA_TEST",
                    AWS_SECRET_ACCESS_KEY: "secret",
                    AWS_REGION: "us-east-1",
                },
                () => {
                    expect(createProviderRegistry(testConfig()).isProviderConfigured("amazon-bedrock")).toBeTrue();
                },
            );

            withProviderEnv({ AWS_PROFILE: "dev", AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "https://bedrock.local" }, () => {
                expect(createProviderRegistry(testConfig()).isProviderConfigured("amazon-bedrock")).toBeTrue();
            });
        });

        test("returns true for Google Vertex in express mode or ADC mode", () => {
            withProviderEnv({}, () => {
                expect(
                    createProviderRegistry(testConfig({ google_vertex_api_key: "vertex-key" })).isProviderConfigured(
                        "google-vertex",
                    ),
                ).toBeTrue();
                expect(
                    createProviderRegistry(testConfig({ google_vertex_project: "my-proj" })).isProviderConfigured(
                        "google-vertex",
                    ),
                ).toBeFalse();
                expect(
                    createProviderRegistry(
                        testConfig({ google_vertex_project: "my-proj", google_vertex_location: "us-central1" }),
                    ).isProviderConfigured("google-vertex"),
                ).toBeTrue();
            });

            withProviderEnv({ GOOGLE_VERTEX_PROJECT: "env-proj", GOOGLE_VERTEX_LOCATION: "global" }, () => {
                expect(createProviderRegistry(testConfig()).isProviderConfigured("google-vertex")).toBeTrue();
            });
        });

        test("returns false for the provider whose API key is not set", () => {
            withProviderEnv({}, () => {
                const registry = createProviderRegistry(
                    testConfig({ azure_api_key: "azure-key", azure_resource_name: "my-azure" }),
                );
                expect(registry.isProviderConfigured("openrouter")).toBeFalse();
            });
        });

        test("returns false when the API key is an unresolved environment variable reference", () => {
            const bareRegistry = createProviderRegistry(testConfig({ openrouter_api_key: "$OPENROUTER_API_KEY" }));
            const bracedRegistry = createProviderRegistry(testConfig({ openrouter_api_key: `\${OPENROUTER_API_KEY}` }));
            expect(bareRegistry.isProviderConfigured("openrouter")).toBeFalse();
            expect(bracedRegistry.isProviderConfigured("openrouter")).toBeFalse();
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

        test("clamps Anthropic thinking budget and computes remaining maxOutputTokens", async () => {
            const calls: Array<Record<string, unknown>> = [];
            const makeCatalog = (outputLimit?: number): ModelsListResponse => {
                const claude = BrokerModelInfoSchema.parse({
                    route_id: "anthropic/claude-sonnet-4-5",
                    provider: "anthropic",
                    provider_model_id: "claude-sonnet-4-5",
                    display_name: "Claude Sonnet 4.5",
                    ...(outputLimit !== undefined ? { output_limit: outputLimit } : {}),
                });
                return {
                    schema: "models.list/1",
                    cache: {
                        status: "fresh",
                        fetched_at: "2026-01-01T00:00:00.000Z",
                        expires_at: "2026-01-02T00:00:00.000Z",
                    },
                    providers: {
                        anthropic: { status: "catalog", models: [claude] },
                    },
                };
            };
            const registry = createProviderRegistry(testConfig({ anthropic_api_key: "anthropic-key" }), {
                providerFactories: {
                    anthropic: {
                        languageModel: (modelId) => ({ modelId }) as never,
                    },
                },
                generateTextFn: async (args) => {
                    calls.push(args as Record<string, unknown>);
                    return {
                        response: {
                            modelId: "claude-sonnet-4-5",
                            timestamp: new Date("2026-08-27T00:00:00.000Z"),
                        },
                        text: "ok",
                        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                    } as never;
                },
            });
            const configured = new Set<ProviderId>(["anthropic"]);

            // 1. max (80k) on 64k output_limit clamps budget to 62,976 and leaves 1,024 output tokens.
            await registry.generateText("anthropic/claude-sonnet-4-5", "hi", undefined, {
                catalog: makeCatalog(64_000),
                configuredProviders: configured,
                thinkingMode: "max",
            });
            // 2. medium (20k) on 64k output_limit leaves 44,000 output tokens.
            await registry.generateText("anthropic/claude-sonnet-4-5", "hi", undefined, {
                catalog: makeCatalog(64_000),
                configuredProviders: configured,
                thinkingMode: "medium",
            });
            // 3. Explicit tighter caller maxOutputTokens is respected.
            await registry.generateText("anthropic/claude-sonnet-4-5", "hi", undefined, {
                catalog: makeCatalog(64_000),
                configuredProviders: configured,
                maxOutputTokens: 4_096,
                thinkingMode: "medium",
            });
            // 4. output_limit <= 1024 omits thinking options and keeps caller temperature.
            await registry.generateText("anthropic/claude-sonnet-4-5", "hi", undefined, {
                catalog: makeCatalog(1_024),
                configuredProviders: configured,
                temperature: 0.4,
                thinkingMode: "minimal",
            });
            // 5. Undefined output_limit caps requested budget safely at 32,000.
            await registry.generateText("anthropic/claude-sonnet-4-5", "hi", undefined, {
                catalog: makeCatalog(undefined),
                configuredProviders: configured,
                thinkingMode: "max",
            });

            expect(calls).toHaveLength(5);
            expect(calls[0]?.providerOptions).toEqual({
                anthropic: { thinking: { type: "enabled", budgetTokens: 62_976 } },
            });
            expect(calls[0]?.maxOutputTokens).toBe(1_024);
            expect(calls[0]?.temperature).toBe(0);

            expect(calls[1]?.providerOptions).toEqual({
                anthropic: { thinking: { type: "enabled", budgetTokens: 20_000 } },
            });
            expect(calls[1]?.maxOutputTokens).toBe(44_000);

            expect(calls[2]?.maxOutputTokens).toBe(4_096);

            expect(calls[3]).not.toHaveProperty("providerOptions");
            expect(calls[3]?.temperature).toBe(0.4);

            expect(calls[4]?.providerOptions).toEqual({
                anthropic: { thinking: { type: "enabled", budgetTokens: 32_000 } },
            });
        });

        test("clamps oversized provider_timeout_ms to signed 32-bit max", async () => {
            const timeoutId = 1 as unknown as ReturnType<typeof setTimeout>;
            const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockReturnValue(timeoutId);
            spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
            const registry = createProviderRegistry(
                testConfig({
                    provider_timeout_ms: 9_999_999_999,
                    openrouter_api_key: "openrouter-key",
                }),
                {
                    generateTextFn: async () =>
                        ({
                            response: { modelId: "openai/gpt-5.2", timestamp: new Date() },
                            text: "ok",
                            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                        }) as never,
                },
            );

            const result = await registry.generateText("openrouter/openai/gpt-5.2", "hello", undefined, {
                catalog: openrouterCatalog(),
                configuredProviders: openrouterConfigured(),
            });

            expect(result.ok).toBeTrue();
            expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2_147_483_647);
        });

        test("falls back on sub-millisecond fractional provider_timeout_ms and classifies wrapped TimeoutError causes", async () => {
            const timeoutId = 1 as unknown as ReturnType<typeof setTimeout>;
            const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockReturnValue(timeoutId);
            spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);

            const fractionalRegistry = createProviderRegistry(
                testConfig({
                    provider_timeout_ms: 0.5,
                    openrouter_api_key: "openrouter-key",
                }),
                {
                    generateTextFn: async () =>
                        ({
                            response: { modelId: "openai/gpt-5.2", timestamp: new Date() },
                            text: "ok",
                            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                        }) as never,
                },
            );
            const fractionalResult = await fractionalRegistry.generateText(
                "openrouter/openai/gpt-5.2",
                "hello",
                undefined,
                {
                    catalog: openrouterCatalog(),
                    configuredProviders: openrouterConfigured(),
                },
            );
            expect(fractionalResult.ok).toBeTrue();
            expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1_800_000);

            const wrappedRegistry = createProviderRegistry(testConfig({ openrouter_api_key: "openrouter-key" }), {
                generateTextFn: async () => {
                    throw new TypeError("fetch failed", {
                        cause: new DOMException("The operation timed out.", "TimeoutError"),
                    });
                },
            });
            const wrappedResult = await wrappedRegistry.generateText("openrouter/openai/gpt-5.2", "hello", undefined, {
                catalog: openrouterCatalog(),
                configuredProviders: openrouterConfigured(),
            });
            expect(wrappedResult.ok).toBeFalse();
            if (!wrappedResult.ok) {
                expect(wrappedResult.error.type).toBe("timeout");
                expect(wrappedResult.error.retryable).toBeTrue();
            }
        });

        test("distinguishes caller abortSignal cancellation from internal timeout", async () => {
            const parentController = new AbortController();
            const cancelRegistry = createProviderRegistry(testConfig({ openrouter_api_key: "openrouter-key" }), {
                generateTextFn: async (args) =>
                    await new Promise((_, reject) => {
                        args.abortSignal?.addEventListener("abort", () => {
                            reject(new DOMException("The operation was aborted.", "AbortError"));
                        });
                        parentController.abort();
                    }),
            });

            const cancelled = await cancelRegistry.generateText("openrouter/openai/gpt-5.2", "hello", undefined, {
                abortSignal: parentController.signal,
                catalog: openrouterCatalog(),
                configuredProviders: openrouterConfigured(),
            });

            expect(cancelled.ok).toBeFalse();
            if (!cancelled.ok) {
                expect(cancelled.error.type).toBe("cancelled");
                expect(cancelled.error.message).toBe("Provider request cancelled");
                expect(cancelled.error.retryable).toBeFalse();
            }

            const alreadyAborted = new AbortController();
            alreadyAborted.abort();
            let called = false;
            const shortCircuitRegistry = createProviderRegistry(testConfig({ openrouter_api_key: "openrouter-key" }), {
                generateTextFn: async () => {
                    called = true;
                    throw new Error("should not run");
                },
            });
            const preCancelled = await shortCircuitRegistry.generateText(
                "openrouter/openai/gpt-5.2",
                "hello",
                undefined,
                {
                    abortSignal: alreadyAborted.signal,
                    catalog: openrouterCatalog(),
                    configuredProviders: openrouterConfigured(),
                },
            );
            expect(called).toBeFalse();
            expect(preCancelled.ok).toBeFalse();
            if (!preCancelled.ok) {
                expect(preCancelled.error.type).toBe("cancelled");
                expect(preCancelled.error.retryable).toBeFalse();
            }

            const timeoutRegistry = createProviderRegistry(
                testConfig({ openrouter_api_key: "openrouter-key", provider_timeout_ms: 10 }),
                {
                    generateTextFn: async (args) =>
                        await new Promise((_, reject) => {
                            args.abortSignal?.addEventListener("abort", () => {
                                reject(new DOMException("The operation was aborted.", "AbortError"));
                            });
                        }),
                },
            );

            const timedOut = await timeoutRegistry.generateText("openrouter/openai/gpt-5.2", "hello", undefined, {
                catalog: openrouterCatalog(),
                configuredProviders: openrouterConfigured(),
            });
            expect(timedOut.ok).toBeFalse();
            if (!timedOut.ok) {
                expect(timedOut.error.type).toBe("timeout");
                expect(timedOut.error.message).toBe("Provider request timed out");
                expect(timedOut.error.retryable).toBeTrue();
            }
        });

        test("passes maxRetries 0 and maps APICallError, RetryError, and SSRF retryability", async () => {
            const capturedCalls: Array<Record<string, unknown>> = [];
            const makeRegistry = (errorToThrow: unknown) =>
                createProviderRegistry(testConfig({ openrouter_api_key: "openrouter-key" }), {
                    generateTextFn: async (args) => {
                        capturedCalls.push(args as Record<string, unknown>);
                        throw errorToThrow;
                    },
                });

            const badRequest = new APICallError({
                message: "invalid request",
                url: "https://openrouter.ai/api/v1/chat/completions",
                requestBodyValues: {},
                statusCode: 400,
                isRetryable: false,
            });
            const res400 = await makeRegistry(badRequest).generateText(
                "openrouter/openai/gpt-5.2",
                "hello",
                undefined,
                {
                    catalog: openrouterCatalog(),
                    configuredProviders: openrouterConfigured(),
                },
            );
            expect(capturedCalls[0]?.maxRetries).toBe(0);
            expect(res400.ok).toBeFalse();
            if (!res400.ok) {
                expect(res400.error.type).toBe("execution");
                expect(res400.error.retryable).toBeFalse();
            }

            const rateLimited = new APICallError({
                message: "rate limited",
                url: "https://openrouter.ai/api/v1/chat/completions",
                requestBodyValues: {},
                statusCode: 429,
                isRetryable: true,
            });
            const res429 = await makeRegistry(rateLimited).generateText(
                "openrouter/openai/gpt-5.2",
                "hello",
                undefined,
                {
                    catalog: openrouterCatalog(),
                    configuredProviders: openrouterConfigured(),
                },
            );
            expect(res429.ok).toBeFalse();
            if (!res429.ok) {
                expect(res429.error.type).toBe("execution");
                expect(res429.error.retryable).toBeTrue();
            }

            const wrappedRetryError = new RetryError({
                message: "retries exhausted",
                reason: "maxRetriesExceeded",
                errors: [badRequest],
            });
            const resRetry = await makeRegistry(wrappedRetryError).generateText(
                "openrouter/openai/gpt-5.2",
                "hello",
                undefined,
                {
                    catalog: openrouterCatalog(),
                    configuredProviders: openrouterConfigured(),
                },
            );
            expect(resRetry.ok).toBeFalse();
            if (!resRetry.ok) {
                expect(resRetry.error.type).toBe("execution");
                expect(resRetry.error.retryable).toBeFalse();
            }

            const ssrfBlocked = new APICallError({
                message: "Cannot connect to API",
                url: "https://custom.example.com/v1/chat/completions",
                requestBodyValues: {},
                isRetryable: true,
                cause: new Error("custom_url host is not allowed"),
            });
            const resSsrf = await makeRegistry(ssrfBlocked).generateText(
                "openrouter/openai/gpt-5.2",
                "hello",
                undefined,
                {
                    catalog: openrouterCatalog(),
                    configuredProviders: openrouterConfigured(),
                },
            );
            expect(resSsrf.ok).toBeFalse();
            if (!resSsrf.ok) {
                expect(resSsrf.error.type).toBe("execution");
                expect(resSsrf.error.retryable).toBeFalse();
            }
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

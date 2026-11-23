import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import http from "node:http";

import { APICallError, RetryError } from "ai";

import { createProviderRegistry, ThinkingModeSchema, thinkingModeValues } from "@/providers/registry";
import { BrokerModelInfoSchema, type ModelsListResponse, type ProviderId, providerIdValues } from "@/types/providers";
import { estimateTokenCount } from "@/utils/helpers";
import { logger } from "@/utils/logger";
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

const listenOnLoopback = async (handler: http.RequestListener): Promise<{ server: http.Server; port: number }> => {
    const server = http.createServer(handler);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
        server.close();
        throw new Error("Failed to bind local test server");
    }

    return { server, port: address.port };
};

const closeServer = async (server: http.Server): Promise<void> => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
        server.close((err) => {
            if (err) {
                reject(err);
                return;
            }
            resolve();
        });
    });
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

        test("maps provider cancellation failures to retryable timeouts", async () => {
            const errors: unknown[] = [
                new DOMException("The operation was aborted.", "AbortError"),
                new DOMException("The operation timed out.", "TimeoutError"),
                new TypeError("fetch failed", {
                    cause: new DOMException("The operation timed out.", "TimeoutError"),
                }),
            ];

            for (const error of errors) {
                const registry = createProviderRegistry(testConfig({ openrouter_api_key: "openrouter-key" }), {
                    generateTextFn: async () => {
                        throw error;
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
            const warnSpy = spyOn(logger, "warn").mockImplementation(() => undefined);

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
                expect(result.error.message).not.toContain("sk-test-secret-value");
            }

            expect(warnSpy).toHaveBeenCalledTimes(1);
            const [loggedMessage, loggedPayload] = warnSpy.mock.calls[0] ?? [];
            expect(loggedMessage).toBe("Provider request failed");
            expect(JSON.stringify(loggedPayload)).not.toContain("sk-test-secret-value");
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

        test("normalizes partial and missing provider token usage fallbacks", async () => {
            const prompt = "hello world from chorus";
            const responseText = "normalized token response";
            const runWithUsage = async (usage: Record<string, number | undefined> | undefined) => {
                const registry = createProviderRegistry(testConfig({ openrouter_api_key: "openrouter-key" }), {
                    generateTextFn: async () =>
                        ({
                            response: {
                                modelId: "openai/gpt-5.2",
                                timestamp: new Date("2026-03-10T12:00:00.000Z"),
                            },
                            text: responseText,
                            usage,
                        }) as never,
                });

                return registry.generateText("openrouter/openai/gpt-5.2", prompt, undefined, {
                    catalog: openrouterCatalog(),
                    configuredProviders: openrouterConfigured(),
                });
            };

            const totalOnly = await runWithUsage({ totalTokens: 42 });
            expect(totalOnly.ok).toBeTrue();
            if (totalOnly.ok) {
                expect(totalOnly.value.usage).toEqual({
                    input_tokens: 0,
                    output_tokens: 0,
                    total_tokens: 42,
                });
            }

            const missingUsage = await runWithUsage(undefined);
            const expectedInput = estimateTokenCount(prompt);
            const expectedOutput = estimateTokenCount(responseText);
            expect(missingUsage.ok).toBeTrue();
            if (missingUsage.ok) {
                expect(missingUsage.value.usage).toEqual({
                    input_tokens: expectedInput,
                    output_tokens: expectedOutput,
                    total_tokens: expectedInput + expectedOutput,
                });
            }

            const splitOnly = await runWithUsage({ inputTokens: 10, outputTokens: 7 });
            expect(splitOnly.ok).toBeTrue();
            if (splitOnly.ok) {
                expect(splitOnly.value.usage).toEqual({
                    input_tokens: 10,
                    output_tokens: 7,
                    total_tokens: 17,
                });
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
            let redirectedHit = false;
            let capturedAuthHeader = "";
            const { server, port } = await listenOnLoopback((req, res) => {
                if (req.url === "/v1/chat/completions") {
                    capturedAuthHeader = req.headers.authorization ?? "";
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(
                        JSON.stringify({
                            id: "chatcmpl-local-test",
                            object: "chat.completion",
                            created: 1_700_000_000,
                            model: "default",
                            choices: [
                                {
                                    index: 0,
                                    message: {
                                        role: "assistant",
                                        content: "hello from local custom server",
                                    },
                                    finish_reason: "stop",
                                },
                            ],
                            usage: {
                                prompt_tokens: 4,
                                completion_tokens: 5,
                                total_tokens: 9,
                            },
                        }),
                    );
                    return;
                }
                if (req.url === "/redirect/chat/completions") {
                    res.writeHead(302, { location: `http://127.0.0.1:${port}/redirected` });
                    res.end();
                    return;
                }
                if (req.url === "/redirected") {
                    redirectedHit = true;
                    res.writeHead(200, { "content-type": "text/plain" });
                    res.end("should never be reached");
                    return;
                }
                res.writeHead(404);
                res.end();
            });

            const catalog: ModelsListResponse = {
                schema: "models.list/1",
                cache: {
                    status: "fresh",
                    fetched_at: "2026-01-01T00:00:00.000Z",
                    expires_at: "2026-01-02T00:00:00.000Z",
                },
                providers: {
                    custom: { status: "passthrough", models: [] },
                },
            };

            try {
                const registry = createProviderRegistry(
                    testConfig({
                        custom_api_key: "test-key",
                        custom_url: `http://127.0.0.1:${port}/v1`,
                    }),
                );

                const result = await registry.generateText("custom/default", "hello", undefined, {
                    catalog,
                    configuredProviders: new Set<ProviderId>(["custom"]),
                });

                expect(result.ok).toBeTrue();
                expect(capturedAuthHeader).toBe("Bearer test-key");
                if (result.ok) {
                    expect(result.value.model).toBe("custom/default");
                    expect(result.value.provider).toBe("custom");
                    expect(result.value.text).toBe("hello from local custom server");
                    expect(result.value.usage).toEqual({
                        input_tokens: 4,
                        output_tokens: 5,
                        total_tokens: 9,
                    });
                }

                const redirectRegistry = createProviderRegistry(
                    testConfig({
                        custom_api_key: "test-key",
                        custom_url: `http://127.0.0.1:${port}/redirect`,
                    }),
                );

                const redirectResult = await redirectRegistry.generateText("custom/default", "hello", undefined, {
                    catalog,
                    configuredProviders: new Set<ProviderId>(["custom"]),
                });

                expect(redirectResult.ok).toBeFalse();
                if (!redirectResult.ok) {
                    expect(redirectResult.error.type).toBe("execution");
                    expect(redirectResult.error.retryable).toBeFalse();
                }
                expect(redirectedHit).toBeFalse();
            } finally {
                await closeServer(server);
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

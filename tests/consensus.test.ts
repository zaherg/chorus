import { describe, expect, it } from "bun:test";

import { runConsensus } from "@/consensus";
import type { ProviderRegistry } from "@/providers/registry";
import type {
    BrokerModelInfo,
    ModelsListResponse,
    ProviderId,
} from "@/types/providers";
import type { Result, ToolError } from "@/types/tools";
import { testModel } from "./helpers";

const providerFor = (modelId: string): ProviderId => {
    if (modelId.startsWith("gpt-")) return "openai";
    if (modelId.startsWith("gemini-")) return "google";
    return "anthropic";
};

const makeModel = (id: string, provider: ProviderId): BrokerModelInfo =>
    testModel({
        route_id: id,
        provider,
        provider_model_id: id,
        display_name: id,
    });

const registryModels: BrokerModelInfo[] = [
    makeModel("gpt-5.2", "openai"),
    makeModel("gemini-2.5-pro", "google"),
    makeModel("claude-sonnet-4-20250514", "anthropic"),
];

const configuredProviders: ReadonlySet<ProviderId> = new Set<ProviderId>([
    "openai",
    "google",
    "anthropic",
]);

type GenerateTextResult = {
    model: string;
    provider: ProviderId;
    text: string;
    usage: {
        input_tokens: number;
        output_tokens: number;
        total_tokens: number;
    };
};

type GenerateTextImpl = (
    modelId: string,
    prompt: string,
    systemPrompt: string | undefined,
    options:
        | {
              abortSignal?: AbortSignal;
              maxOutputTokens?: number;
              temperature?: number;
              thinkingMode?: string;
          }
        | undefined,
) => Promise<Result<GenerateTextResult, ToolError>>;

type RegistryOverrides = {
    models?: BrokerModelInfo[];
    generateTextImpl?: GenerateTextImpl;
    callLog?: Array<{ model: string; prompt: string; options?: unknown }>;
};

const mockRegistry = (overrides: RegistryOverrides = {}): ProviderRegistry => {
    const allModels = overrides.models ?? registryModels;
    const callLog = overrides.callLog ?? [];

    const defaultGenerateText: GenerateTextImpl = async (modelId) => ({
        ok: true,
        value: {
            model: modelId,
            provider: providerFor(modelId),
            text: `Response from ${modelId}`,
            usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        },
    });

    const generateTextImpl = overrides.generateTextImpl ?? defaultGenerateText;

    const registry = {
        getModelInfo: async (
            id: string,
            _options?: {
                catalog?: ModelsListResponse;
                configuredProviders?: ReadonlySet<ProviderId>;
            },
        ) =>
            allModels.find(
                (model) =>
                    model.route_id === id || model.provider_model_id === id,
            ),
        isProviderConfigured: (_p: string) => true,
        generateText: async (
            modelId: string,
            prompt: string,
            systemPrompt: string | undefined,
            options:
                | {
                      abortSignal?: AbortSignal;
                      maxOutputTokens?: number;
                      temperature?: number;
                      thinkingMode?: string;
                  }
                | undefined,
        ): Promise<Result<GenerateTextResult, ToolError>> => {
            callLog.push({ model: modelId, prompt, options });
            return generateTextImpl(modelId, prompt, systemPrompt, options);
        },
    } as unknown as ProviderRegistry;

    return registry;
};

const okResult = (
    modelId: string,
    text = "ok",
): Result<GenerateTextResult, ToolError> => ({
    ok: true,
    value: {
        model: modelId,
        provider: providerFor(modelId),
        text,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
});

const failResult = (
    message = "API timeout",
    retryable = true,
): Result<GenerateTextResult, ToolError> => ({
    ok: false,
    error: { type: "timeout", message, retryable },
});

const buildRequest = (overrides: {
    models: Array<{ model: string; stance?: "for" | "against" | "neutral" }>;
    synthesisModel?: string;
    parallel?: boolean;
    maxConcurrency?: number;
    abortSignal?: AbortSignal;
}) => {
    const catalog: ModelsListResponse = {
        schema: "models.list/1",
        cache: {
            status: "fresh",
            fetched_at: "2026-01-01T00:00:00.000Z",
            expires_at: "2026-01-02T00:00:00.000Z",
        },
        providers: {},
    };
    return {
        catalog,
        configuredProviders,
        findings: "f",
        step: "s",
        ...overrides,
    };
};

describe("runConsensus", () => {
    it("returns cli.consensus/2 with 2 successful participants and no synthesis", async () => {
        const registry = mockRegistry();
        const result = await runConsensus({
            providerRegistry: registry,
            ...buildRequest({
                models: [
                    { model: "gpt-5.2", stance: "for" },
                    { model: "gemini-2.5-pro", stance: "against" },
                ],
                parallel: true,
            }),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.schema).toBe("cli.consensus/2");
        expect(result.models).toHaveLength(2);
        expect(result.models[0].route_id).toBe("gpt-5.2");
        expect(result.models[0].response).toBeTruthy();
        expect(result.models[0].stance).toBe("for");
        expect(result.models[1].route_id).toBe("gemini-2.5-pro");
        expect(result.models[1].stance).toBe("against");
    });

    it("returns ok with one failed and one successful participant", async () => {
        const registry = mockRegistry({
            generateTextImpl: async (modelId) =>
                modelId === "gemini-2.5-pro"
                    ? failResult()
                    : okResult(modelId, "yes"),
        });

        const result = await runConsensus({
            providerRegistry: registry,
            ...buildRequest({
                models: [{ model: "gpt-5.2" }, { model: "gemini-2.5-pro" }],
                parallel: true,
            }),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.models).toHaveLength(2);
        const failed = result.models.find((m) => m.error !== null);
        const succeeded = result.models.find((m) => m.response !== null);
        expect(failed).toBeDefined();
        expect(failed?.route_id).toBe("gemini-2.5-pro");
        expect(failed?.error?.code).toBe("provider_request_failed");
        expect(failed?.error?.retryable).toBe(true);
        expect(succeeded?.route_id).toBe("gpt-5.2");
        expect(succeeded?.response).toBe("yes");
    });

    it("returns ok=false when a single participant call fails and no synthesis is set", async () => {
        const registry = mockRegistry({
            generateTextImpl: async () => failResult(),
        });

        const result = await runConsensus({
            providerRegistry: registry,
            ...buildRequest({
                models: [{ model: "gpt-5.2" }],
                parallel: true,
            }),
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors[0]).toMatch(/All participant|fail/i);
    });

    it("returns ok with 3 participants, one failed, two succeeded, and synthesis populated", async () => {
        const registry = mockRegistry({
            generateTextImpl: async (modelId) =>
                modelId === "gemini-2.5-pro"
                    ? failResult()
                    : okResult(modelId, `ok-${modelId}`),
        });

        const result = await runConsensus({
            providerRegistry: registry,
            ...buildRequest({
                models: [
                    { model: "gpt-5.2" },
                    { model: "gemini-2.5-pro" },
                    { model: "claude-sonnet-4-20250514" },
                ],
                parallel: true,
                synthesisModel: "claude-sonnet-4-20250514",
            }),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.models).toHaveLength(3);
        const failed = result.models.find((m) => m.error !== null);
        expect(failed?.route_id).toBe("gemini-2.5-pro");
        expect(result.synthesis).toBeTruthy();
        expect(result.synthesis_error).toBeNull();
    });

    it("populates synthesis when --synthesis-model is set and the call succeeds", async () => {
        const callLog: Array<{
            model: string;
            prompt: string;
            options?: unknown;
        }> = [];
        const registry = mockRegistry({ callLog });
        const result = await runConsensus({
            providerRegistry: registry,
            ...buildRequest({
                models: [{ model: "gpt-5.2" }, { model: "gemini-2.5-pro" }],
                parallel: true,
                synthesisModel: "claude-sonnet-4-20250514",
            }),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.synthesis).toBe("Response from claude-sonnet-4-20250514");
        expect(result.synthesis_error).toBeNull();
        expect(
            callLog.some((c) => c.model === "claude-sonnet-4-20250514"),
        ).toBe(true);
    });

    it("keeps raw responses and sets synthesis_error when synthesis call fails", async () => {
        const registry = mockRegistry({
            generateTextImpl: async (modelId) => {
                if (modelId === "claude-sonnet-4-20250514") {
                    return failResult("synthesis blew up", false);
                }
                return okResult(modelId, "ok");
            },
        });

        const result = await runConsensus({
            providerRegistry: registry,
            ...buildRequest({
                models: [{ model: "gpt-5.2" }, { model: "gemini-2.5-pro" }],
                parallel: true,
                synthesisModel: "claude-sonnet-4-20250514",
            }),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.synthesis).toBeNull();
        expect(result.synthesis_error).toEqual({
            code: "provider_request_failed",
            message: "synthesis blew up",
            retryable: false,
        });
        expect(result.models).toHaveLength(2);
        expect(result.models.every((m) => m.response !== null)).toBe(true);
    });

    it("does not call generateText for synthesis when --synthesis-model is absent", async () => {
        const callLog: Array<{
            model: string;
            prompt: string;
            options?: unknown;
        }> = [];
        const registry = mockRegistry({ callLog });
        const result = await runConsensus({
            providerRegistry: registry,
            ...buildRequest({
                models: [{ model: "gpt-5.2" }, { model: "gemini-2.5-pro" }],
                parallel: true,
            }),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(callLog).toHaveLength(2);
        expect(result.synthesis).toBeNull();
        expect(result.synthesis_error).toBeNull();
    });

    it("runs sequentially when parallel is false and participants see prior responses", async () => {
        const seenPrompts: string[] = [];
        const registry = mockRegistry({
            generateTextImpl: async (modelId, prompt) => {
                seenPrompts.push(prompt);
                return okResult(modelId, modelId);
            },
        });

        const result = await runConsensus({
            providerRegistry: registry,
            ...buildRequest({
                models: [{ model: "gpt-5.2" }, { model: "gemini-2.5-pro" }],
                parallel: false,
            }),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.models).toHaveLength(2);
        expect(seenPrompts[1]).toContain("<previous-model-responses>");
        expect(seenPrompts[1]).toContain("gpt-5.2");
        expect(seenPrompts[0]).not.toContain("<previous-model-responses>");
    });

    it("caps active parallel calls at maxConcurrency", async () => {
        let active = 0;
        let maxActive = 0;
        const registry = mockRegistry({
            generateTextImpl: async (modelId) => {
                active++;
                maxActive = Math.max(maxActive, active);
                await Bun.sleep(10);
                active--;
                return okResult(modelId);
            },
        });

        const result = await runConsensus({
            providerRegistry: registry,
            ...buildRequest({
                models: [
                    { model: "gpt-5.2" },
                    { model: "gemini-2.5-pro" },
                    { model: "claude-sonnet-4-20250514" },
                ],
                parallel: true,
                maxConcurrency: 1,
            }),
        });

        expect(result.ok).toBe(true);
        expect(maxActive).toBe(1);
    });

    it("passes the abort signal to provider calls", async () => {
        let received: AbortSignal | undefined;
        const registry = mockRegistry({
            generateTextImpl: async (modelId, _p, _s, options) => {
                received = options?.abortSignal;
                return okResult(modelId);
            },
        });
        const controller = new AbortController();

        const result = await runConsensus({
            providerRegistry: registry,
            ...buildRequest({
                models: [{ model: "gpt-5.2" }, { model: "gemini-2.5-pro" }],
                parallel: true,
                abortSignal: controller.signal,
            }),
        });

        expect(result.ok).toBe(true);
        expect(received).toBe(controller.signal);
    });

    it("marks skipped aborted participants as non-retryable", async () => {
        let calls = 0;
        const controller = new AbortController();
        const registry = mockRegistry({
            generateTextImpl: async (modelId) => {
                calls += 1;
                controller.abort();
                return okResult(modelId);
            },
        });

        const result = await runConsensus({
            providerRegistry: registry,
            ...buildRequest({
                models: [{ model: "gpt-5.2" }, { model: "gemini-2.5-pro" }],
                parallel: false,
                abortSignal: controller.signal,
            }),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(calls).toBe(1);
        expect(result.models).toHaveLength(2);
        expect(result.models[1].error?.retryable).toBeFalse();
    });

    it("returns ok=false with an error when zero models are provided", async () => {
        const registry = mockRegistry();
        const result = await runConsensus({
            providerRegistry: registry,
            ...buildRequest({ models: [] }),
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors[0]).toContain("At least one model");
    });
});

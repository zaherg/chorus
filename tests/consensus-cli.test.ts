import { describe, expect, it, mock } from "bun:test";
import { Readable } from "node:stream";

import { runCli } from "@/cli";
import { runConsensusCommand } from "@/commands/consensus";
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

const fixtureModels = (): ModelsListResponse => {
    const openaiModel = BrokerModelInfoSchema.parse({
        route_id: "openai/gpt-5.2",
        provider: "openai",
        provider_model_id: "gpt-5.2",
        display_name: "GPT-5.2",
    });
    const geminiModel = BrokerModelInfoSchema.parse({
        route_id: "google/gemini-2.5-pro",
        provider: "google",
        provider_model_id: "gemini-2.5-pro",
        display_name: "Gemini 2.5 Pro",
    });
    const anthropicModel = BrokerModelInfoSchema.parse({
        route_id: "anthropic/claude-sonnet-4-5",
        provider: "anthropic",
        provider_model_id: "claude-sonnet-4-5",
        display_name: "Claude Sonnet 4.5",
    });
    const providers: Record<string, ProviderListEntry> = {
        openai: { status: "catalog", models: [openaiModel] },
        google: { status: "catalog", models: [geminiModel] },
        anthropic: { status: "catalog", models: [anthropicModel] },
    };
    return {
        schema: "models.list/1",
        cache: {
            status: "fresh",
            fetched_at: "2026-01-01T00:00:00.000Z",
            expires_at: "2026-01-02T00:00:00.000Z",
        },
        providers,
    };
};

const stubCatalog = (response: ModelsListResponse): void => {
    mock.module("@/providers/model-catalog", () => ({
        loadCatalog: async () => ({
            ok: true,
            schema: response.schema,
            cache: response.cache,
            providers: response.providers,
        }),
    }));
};

const stubCatalogUnavailable = (message: string): void => {
    mock.module("@/providers/model-catalog", () => ({
        loadCatalog: async () => ({
            ok: false,
            error: { code: "catalog_unavailable", message },
        }),
    }));
};

const stubConfiguredProviders = (configured: string[]): void => {
    mock.module("@/providers/registry", () => ({
        isProviderConfigured: (id: string) => configured.includes(id),
        createProviderRegistry: () => ({
            getModelInfo: async () => undefined,
            isProviderConfigured: (id: string) => configured.includes(id),
            generateText: async () => ({
                ok: true as const,
                value: {
                    model: "x",
                    provider: "openai" as const,
                    text: "x",
                    usage: {
                        input_tokens: 0,
                        output_tokens: 0,
                        total_tokens: 0,
                    },
                },
            }),
        }),
    }));
};

const stubRunConsensus = (
    impl: (request: unknown) => Promise<unknown>,
): void => {
    mock.module("@/consensus", () => ({
        runConsensus: impl,
    }));
};

const defaultConsensusImpl = (): Promise<unknown> =>
    Promise.resolve({
        ok: true,
        schema: "cli.consensus/2",
        models: [
            {
                route_id: "openai/gpt-5.2",
                provider: "openai",
                provider_model_id: "gpt-5.2",
                response: "ok",
                stance: "neutral",
                error: null,
            },
        ],
        synthesis: null,
        synthesis_error: null,
        embeddedFiles: {
            embedded_files: [],
            embedded_text: "",
            skipped_files: [],
            total_tokens: 0,
        },
    });

const stubDefaults = (): void => {
    stubCatalog(fixtureModels());
    stubConfiguredProviders(["openai", "google", "anthropic"]);
    stubRunConsensus(defaultConsensusImpl);
};

const mockStdin = async (
    run: () => Promise<number>,
    input: string,
): Promise<{ result: number; stderr: string; stdout: string }> => {
    const stream = Readable.from(Buffer.from(input));
    const original = process.stdin;
    Object.defineProperty(process, "stdin", {
        value: stream,
        writable: true,
        configurable: true,
    });
    try {
        return await captureOutput(run);
    } finally {
        Object.defineProperty(process, "stdin", {
            value: original,
            writable: true,
            configurable: true,
        });
        stream.destroy();
    }
};

describe("runConsensusCommand", () => {
    it("returns 2 for invalid model/prompt input", async () => {
        const cases: Array<{ args: string[]; checkStderr?: string }> = [
            { args: ["--prompt", "test"] },
            { args: ["--models", "openai/gpt-5.2,google/gemini-2.5-pro"] },
            { args: ["--models", ",,", "--prompt", "test"] },
            {
                args: ["--models", "openai/gpt-5.2", "--prompt", "test"],
                checkStderr: "at least two models",
            },
        ];
        for (const { args, checkStderr } of cases) {
            stubDefaults();
            const { result, stderr } = await captureOutput(() =>
                runConsensusCommand(args),
            );
            expect(result).toBe(2);
            if (checkStderr) expect(stderr).toContain(checkStderr);
        }
    });

    it("prints schema JSON with --schema flag", async () => {
        stubDefaults();
        const { result, stdout } = await captureOutput(() =>
            runConsensusCommand(["--schema"]),
        );
        expect(result).toBe(0);
        const parsed = JSON.parse(stdout.trim());
        expect(parsed.schema).toBe("cli.consensus/2");
        expect(parsed.ok).toBe("boolean");
        expect(Array.isArray(parsed.models)).toBe(true);
        expect(parsed.synthesis).toBeDefined();
        expect(parsed.synthesis_error).toBeDefined();
        expect(parsed.models[0].stance).toBe("for | against | neutral | null");
        expect(parsed.embeddedFiles).toBeDefined();
        expect(parsed.embeddedFiles.embedded_files).toBe("string[]");
        expect(parsed.embeddedFiles.skipped_files).toBe("string[]");
        expect(parsed.embeddedFiles.embedded_text).toBe("string");
        expect(parsed.embeddedFiles.total_tokens).toBe("number");
    });

    it("emits ok: true and embeddedFiles on a successful consensus", async () => {
        stubDefaults();
        const { result, stdout } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "openai/gpt-5.2,google/gemini-2.5-pro",
                "--prompt",
                "test",
            ]),
        );
        expect(result).toBe(0);
        const payload = JSON.parse(stdout);
        expect(payload.ok).toBe(true);
        expect(payload.schema).toBe("cli.consensus/2");
        expect(payload.embeddedFiles).toBeDefined();
        expect(payload.embeddedFiles.embedded_files).toEqual([]);
        expect(payload.embeddedFiles.skipped_files).toEqual([]);
        expect(payload.embeddedFiles.embedded_text).toBe("");
        expect(payload.embeddedFiles.total_tokens).toBe(0);
    });

    it("returns 2 for invalid --stdin-json", async () => {
        const cases = [
            "not valid json {",
            JSON.stringify({ models: [], prompt: "test" }),
        ];
        for (const input of cases) {
            stubDefaults();
            const { result } = await mockStdin(
                () => runConsensusCommand(["--stdin-json"]),
                input,
            );
            expect(result).toBe(2);
        }
    });

    it("returns 2 when --stdin-json contains fewer than two models", async () => {
        stubDefaults();
        const { result, stderr } = await mockStdin(
            () => runConsensusCommand(["--stdin-json"]),
            JSON.stringify({ models: ["openai/gpt-5.2"], prompt: "test" }),
        );
        expect(result).toBe(2);
        expect(stderr).toContain("at least two models");
    });

    it("returns 3 and prints cli.consensus.error/1 for ambiguous model", async () => {
        stubCatalog(fixtureModels());
        stubConfiguredProviders(["openai", "google", "anthropic"]);
        // Override resolve-route to return ambiguity
        mock.module("@/providers/resolve-route", () => ({
            classifyInput: (input: string) =>
                input.includes("/")
                    ? { kind: "exact_route_id" as const, route_id: input }
                    : { kind: "unqualified" as const, providerModelId: input },
            resolveRoute: async () => ({
                ok: false as const,
                error: {
                    code: "ambiguous_model" as const,
                    input: "shared",
                    candidates: ["openai/shared", "google/shared"],
                    message:
                        "Model 'shared' is exposed by multiple configured providers.",
                },
            }),
        }));
        stubRunConsensus(defaultConsensusImpl);

        const { result, stdout } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "shared,openai/gpt-5.2",
                "--prompt",
                "test",
            ]),
        );

        expect(result).toBe(3);
        const payload = JSON.parse(stdout);
        expect(payload.ok).toBe(false);
        expect(payload.schema).toBe("cli.consensus.error/1");
        expect(payload.error.code).toBe("ambiguous_model");
        expect(payload.error.input).toBe("shared");
        expect(payload.error.candidates).toContain("openai/shared");
        expect(payload.error.candidates).toContain("google/shared");
        expect(payload.error.candidates.length).toBe(2);
    });

    it("returns 3 and prints cli.consensus.error/1 for unknown model", async () => {
        stubCatalog(fixtureModels());
        stubConfiguredProviders(["openai", "google", "anthropic"]);
        mock.module("@/providers/resolve-route", () => ({
            classifyInput: (input: string) =>
                input.includes("/")
                    ? { kind: "exact_route_id" as const, route_id: input }
                    : { kind: "unqualified" as const, providerModelId: input },
            resolveRoute: async () => ({
                ok: false as const,
                error: {
                    code: "model_not_found" as const,
                    input: "missing",
                    message: "No configured provider exposes model 'missing'.",
                },
            }),
        }));
        stubRunConsensus(defaultConsensusImpl);

        const { result, stdout } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "missing,openai/gpt-5.2",
                "--prompt",
                "test",
            ]),
        );

        expect(result).toBe(3);
        const payload = JSON.parse(stdout);
        expect(payload.ok).toBe(false);
        expect(payload.schema).toBe("cli.consensus.error/1");
        expect(payload.error.code).toBe("unknown_model");
        expect(payload.error.input).toBe("missing");
    });

    it("returns 0 with synthesis=null when synthesis-model cannot be resolved", async () => {
        stubCatalog(fixtureModels());
        stubConfiguredProviders(["openai", "google", "anthropic"]);
        // Allow real resolution for participant models but fail for synthesis
        mock.module("@/providers/resolve-route", () => ({
            classifyInput: (input: string) =>
                input.includes("/")
                    ? { kind: "exact_route_id" as const, route_id: input }
                    : { kind: "unqualified" as const, providerModelId: input },
            resolveRoute: async (input: {
                kind: string;
                route_id?: string;
                providerModelId?: string;
            }) => {
                const id =
                    input.kind === "exact_route_id"
                        ? input.route_id
                        : input.providerModelId;
                if (id === "synth-missing") {
                    return {
                        ok: false as const,
                        error: {
                            code: "model_not_found" as const,
                            input: "synth-missing",
                            message: "synth model not found",
                        },
                    };
                }
                return {
                    ok: true as const,
                    value: {
                        route_id: id ?? "openai/gpt-5.2",
                        provider: "openai" as const,
                        provider_model_id: "gpt-5.2",
                        display_name: "GPT-5.2",
                    },
                };
            },
        }));
        let passedSynthesis: unknown = "sentinel";
        stubRunConsensus(async (req: unknown) => {
            const r = req as { synthesisModel?: string };
            passedSynthesis = r.synthesisModel;
            return defaultConsensusImpl();
        });

        const { result, stdout } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "openai/gpt-5.2,google/gemini-2.5-pro",
                "--prompt",
                "test",
                "--synthesis-model",
                "synth-missing",
            ]),
        );

        expect(result).toBe(0);
        expect(passedSynthesis).toBeUndefined();
        const payload = JSON.parse(stdout);
        expect(payload.schema).toBe("cli.consensus/2");
        expect(payload.synthesis).toBeNull();
        expect(payload.synthesis_error).toEqual({
            code: "synthesis_model_unresolved",
            message: "synth model not found",
            retryable: false,
        });
        expect(Array.isArray(payload.models)).toBe(true);
        expect(payload.models).toHaveLength(1);
    });

    it("returns 1 when the catalog is unavailable", async () => {
        stubCatalogUnavailable("network unreachable");
        stubConfiguredProviders([]);
        stubRunConsensus(defaultConsensusImpl);

        const { result, stdout } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "openai/gpt-5.2,google/gemini-2.5-pro",
                "--prompt",
                "test",
            ]),
        );

        expect(result).toBe(1);
        const payload = JSON.parse(stdout);
        expect(payload.ok).toBe(false);
        expect(payload.schema).toBe("cli.consensus.error/1");
        expect(payload.error.code).toBe("catalog_unavailable");
        expect(payload.error.message).toBe("network unreachable");
    });

    it("returns 1 when config loading fails and prints to stderr", async () => {
        mock.module("@/config", () => ({
            loadConfig: async () => {
                throw new Error("boom");
            },
        }));
        mock.module("@/utils/logger", () => ({
            configureLogging: async () => {},
        }));
        stubCatalog(fixtureModels());
        stubConfiguredProviders(["openai"]);
        stubRunConsensus(defaultConsensusImpl);

        const { result, stderr } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "openai/gpt-5.2,google/gemini-2.5-pro",
                "--prompt",
                "test",
            ]),
        );

        expect(result).toBe(1);
        expect(stderr).toContain("Error");
        expect(stderr).toContain("boom");
    });
});

describe("runCli", () => {
    it("help text does not claim auto-picked synthesis model", async () => {
        stubDefaults();
        const { result, stdout } = await captureOutput(() =>
            runCli(["--help"]),
        );
        expect(result).toBe(0);
        expect(stdout).not.toContain("auto-picked");
        expect(stdout).toContain("skipped when absent");
        expect(stdout).toContain("route_id");
    });
});

import { describe, expect, it, mock } from "bun:test";
import { Readable } from "node:stream";

import { runCli } from "@/cli";
import { parseConsensusArgs, runConsensusCommand } from "@/commands/consensus";
import { BrokerModelInfoSchema, type ModelsListResponse, type ProviderListEntry } from "@/types/providers";
import { captureOutput, testConfig } from "./helpers";

mock.module("@/config", () => ({
    loadConfig: async () => testConfig(),
}));

mock.module("@/utils/logger", () => ({
    configureLogging: async () => {},
}));

const fixtureModels = (): ModelsListResponse => {
    const openaiModel = BrokerModelInfoSchema.parse({
        route_id: "openrouter/openai/gpt-5.2",
        provider: "openrouter",
        provider_model_id: "openai/gpt-5.2",
        display_name: "GPT-5.2",
    });
    const geminiModel = BrokerModelInfoSchema.parse({
        route_id: "google-vertex/gemini-2.5-pro",
        provider: "google-vertex",
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
        openrouter: { status: "catalog", models: [openaiModel] },
        "google-vertex": { status: "catalog", models: [geminiModel] },
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
                    provider: "openrouter" as const,
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

const stubRunConsensus = (impl: (request: unknown) => Promise<unknown>): void => {
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
                route_id: "openrouter/openai/gpt-5.2",
                provider: "openrouter",
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
    stubConfiguredProviders(["openrouter", "google-vertex", "anthropic"]);
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

describe("parseConsensusArgs", () => {
    const parseSuccess = (args: string[]) => {
        const parsed = parseConsensusArgs(args);
        if (!parsed.ok) {
            throw new Error(parsed.error.message);
        }
        return parsed.value;
    };

    const parseErrorMessage = (args: string[]) => {
        const parsed = parseConsensusArgs(args);
        if (parsed.ok) {
            throw new Error("Expected consensus argument parsing to fail");
        }
        return parsed.error.message;
    };

    it("parses all scalar options in separated form", () => {
        expect(
            parseSuccess([
                "--models",
                "model-a,model-b",
                "--prompt",
                "prompt",
                "--temperature",
                "0.25",
                "--synthesis-model",
                "synth",
                "--files",
                "a.ts,b.ts",
            ]),
        ).toEqual({
            models: "model-a,model-b",
            prompt: "prompt",
            temperature: "0.25",
            synthesisModel: "synth",
            files: "a.ts,b.ts",
            stance: [],
            thinkingMode: [],
            temperatureModel: [],
            sequential: false,
            stdinJson: false,
            schema: false,
        });
    });

    it("parses all scalar options in equals form", () => {
        expect(
            parseSuccess([
                "--models=model-a,model-b",
                "--prompt=prompt",
                "--temperature=0.25",
                "--synthesis-model=synth",
                "--files=a.ts,b.ts",
            ]),
        ).toEqual({
            models: "model-a,model-b",
            prompt: "prompt",
            temperature: "0.25",
            synthesisModel: "synth",
            files: "a.ts,b.ts",
            stance: [],
            thinkingMode: [],
            temperatureModel: [],
            sequential: false,
            stdinJson: false,
            schema: false,
        });
    });

    it("normalizes one and repeated options to ordered arrays", () => {
        expect(parseSuccess(["--stance", "model-a=for"]).stance).toEqual(["model-a=for"]);
        expect(
            parseSuccess([
                "--stance=model-a=for",
                "--stance",
                "model-b=against",
                "--thinking-mode=model-a=high",
                "--thinking-mode",
                "model-b=low",
                "--temperature-model=model-a=0.25",
                "--temperature-model",
                "model-b=0.75",
            ]),
        ).toMatchObject({
            stance: ["model-a=for", "model-b=against"],
            thinkingMode: ["model-a=high", "model-b=low"],
            temperatureModel: ["model-a=0.25", "model-b=0.75"],
        });
    });

    it("parses standard true, false, and negated boolean forms", () => {
        expect(parseSuccess(["--sequential=true", "--stdin-json=false", "--no-schema"])).toMatchObject({
            sequential: true,
            stdinJson: false,
            schema: false,
        });
    });

    it("uses minimist last-value behavior for repeated and contradictory booleans", () => {
        expect(parseSuccess(["--sequential", "--no-sequential", "--sequential=false"]).sequential).toBe(false);
    });

    it("keeps numeric-looking temperature values as strings", () => {
        expect(parseSuccess(["--temperature=0.25"]).temperature).toBe("0.25");
    });

    it("rejects invalid boolean assignments, unknown options, positionals, and separator tails", () => {
        expect(parseErrorMessage(["--sequential=invalid"])).toBe("Error: --sequential must be true or false");
        expect(parseErrorMessage(["--no-sequential=true"])).toBe(
            "Error: --no-sequential does not accept an assigned value",
        );
        expect(parseErrorMessage(["--bogus"])).toBe("Error: unknown option --bogus");
        expect(parseErrorMessage(["unexpected"])).toBe("Error: unexpected argument unexpected");
        expect(parseErrorMessage(["--"])).toBe("Error: arguments after -- are not supported");
        expect(parseErrorMessage(["--", "unexpected"])).toBe("Error: arguments after -- are not supported");
    });

    it("rejects duplicate and missing or empty value-bearing scalar options", () => {
        for (const option of ["models", "prompt", "temperature", "synthesis-model", "files"]) {
            expect(parseErrorMessage([`--${option}`, "first", `--${option}`, "second"])).toBe(
                `Error: --${option} may only be specified once`,
            );
            expect(parseErrorMessage([`--${option}=`])).toBe(`Error: --${option} requires a value`);
        }
        expect(parseErrorMessage(["--models"])).toBe("Error: --models requires a value");
    });

    it("accepts hyphen-prefixed scalar values through the equals form", () => {
        expect(parseSuccess(["--prompt=-example"]).prompt).toBe("-example");
    });
});

describe("runConsensusCommand", () => {
    it("returns 2 for invalid model/prompt input", async () => {
        const cases: Array<{ args: string[]; checkStderr?: string }> = [
            { args: ["--prompt", "test"] },
            {
                args: ["--models", "openrouter/openai/gpt-5.2,google-vertex/gemini-2.5-pro"],
            },
            { args: ["--models", ",,", "--prompt", "test"] },
            {
                args: ["--models", "openrouter/openai/gpt-5.2", "--prompt", "test"],
                checkStderr: "at least two models",
            },
        ];
        for (const { args, checkStderr } of cases) {
            stubDefaults();
            const { result, stderr } = await captureOutput(() => runConsensusCommand(args));
            expect(result).toBe(2);
            if (checkStderr) expect(stderr).toContain(checkStderr);
        }
    });

    it("prints schema JSON with --schema flag", async () => {
        stubDefaults();
        const { result, stdout } = await captureOutput(() => runConsensusCommand(["--schema"]));
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

    it("prints schema after valid parsing without loading configuration or the catalog", async () => {
        let configLoadCount = 0;
        let catalogLoadCount = 0;
        mock.module("@/config", () => ({
            loadConfig: async () => {
                configLoadCount += 1;
                return testConfig();
            },
        }));
        mock.module("@/providers/model-catalog", () => ({
            loadCatalog: async () => {
                catalogLoadCount += 1;
                return fixtureModels();
            },
        }));

        const { result, stderr, stdout } = await captureOutput(() => runConsensusCommand(["--schema"]));
        expect(result).toBe(0);
        expect(stderr).toBe("");
        expect(JSON.parse(stdout).schema).toBe("cli.consensus/2");
        expect(configLoadCount).toBe(0);
        expect(catalogLoadCount).toBe(0);
    });

    it("rejects malformed --schema invocations before loading configuration or the catalog", async () => {
        let configLoadCount = 0;
        let catalogLoadCount = 0;
        mock.module("@/config", () => ({
            loadConfig: async () => {
                configLoadCount += 1;
                return testConfig();
            },
        }));
        mock.module("@/providers/model-catalog", () => ({
            loadCatalog: async () => {
                catalogLoadCount += 1;
                return fixtureModels();
            },
        }));

        const cases: Array<{ args: string[]; expected: string }> = [
            { args: ["--schema", "--bogus"], expected: "unknown option" },
            { args: ["--schema", "--prompt", "one", "--prompt", "two"], expected: "may only be specified once" },
            { args: ["--schema", "unexpected"], expected: "unexpected argument" },
            { args: ["--schema", "--", "unexpected"], expected: "arguments after --" },
        ];

        for (const { args, expected } of cases) {
            const { result, stderr, stdout } = await captureOutput(() => runConsensusCommand(args));
            expect(result).toBe(2);
            expect(stdout).toBe("");
            expect(stderr).toContain(expected);
        }
        expect(configLoadCount).toBe(0);
        expect(catalogLoadCount).toBe(0);
    });

    it("emits ok: true and embeddedFiles on a successful consensus", async () => {
        stubDefaults();
        const { result, stdout } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "openrouter/openai/gpt-5.2,google-vertex/gemini-2.5-pro",
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

    it("preserves files, sequential execution, and request-level domain validation", async () => {
        stubDefaults();
        let receivedRequest: unknown;
        stubRunConsensus(async (request: unknown) => {
            receivedRequest = request;
            return defaultConsensusImpl();
        });

        const { result } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "openrouter/openai/gpt-5.2,google-vertex/gemini-2.5-pro",
                "--prompt",
                "test",
                "--temperature",
                "0.25",
                "--files",
                "a.ts,b.ts",
                "--sequential",
                "--stance",
                "openrouter/openai/gpt-5.2=for",
                "--stance",
                "google-vertex/gemini-2.5-pro=against",
                "--thinking-mode",
                "openrouter/openai/gpt-5.2=high",
                "--thinking-mode",
                "google-vertex/gemini-2.5-pro=low",
                "--temperature-model",
                "openrouter/openai/gpt-5.2=0.5",
                "--temperature-model",
                "google-vertex/gemini-2.5-pro=0.75",
            ]),
        );

        expect(result).toBe(0);
        expect(receivedRequest).toMatchObject({
            parallel: false,
            temperature: 0.25,
            relevantFiles: ["a.ts", "b.ts"],
            models: [
                {
                    model: "openrouter/openai/gpt-5.2",
                    stance: "for",
                    thinking_mode: "high",
                    temperature: 0.5,
                },
                {
                    model: "google-vertex/gemini-2.5-pro",
                    stance: "against",
                    thinking_mode: "low",
                    temperature: 0.75,
                },
            ],
        });
    });

    it("uses stdin JSON request fields while retaining the CLI synthesis fallback", async () => {
        stubDefaults();
        let receivedRequest: unknown;
        stubRunConsensus(async (request: unknown) => {
            receivedRequest = request;
            return defaultConsensusImpl();
        });

        const input = JSON.stringify({
            models: ["openrouter/openai/gpt-5.2", "google-vertex/gemini-2.5-pro"],
            prompt: "stdin prompt",
            temperature: 0.4,
            files: ["stdin.ts"],
        });
        const { result } = await mockStdin(
            () =>
                runConsensusCommand([
                    "--stdin-json",
                    "--models",
                    "only-one-model",
                    "--prompt",
                    "ignored prompt",
                    "--temperature",
                    "invalid-temperature",
                    "--files",
                    "ignored.ts",
                    "--stance",
                    "not-model-value",
                    "--thinking-mode",
                    "model=invalid",
                    "--temperature-model",
                    "model=2",
                    "--synthesis-model",
                    "anthropic/claude-sonnet-4-5",
                    "--sequential",
                ]),
            input,
        );

        expect(result).toBe(0);
        expect(receivedRequest).toMatchObject({
            findings: "stdin prompt",
            step: "stdin prompt",
            parallel: false,
            temperature: 0.4,
            relevantFiles: ["stdin.ts"],
            synthesisModel: "anthropic/claude-sonnet-4-5",
            models: [{ model: "openrouter/openai/gpt-5.2" }, { model: "google-vertex/gemini-2.5-pro" }],
        });
    });

    it("rejects malformed CLI options in stdin JSON mode before loading configuration or the catalog", async () => {
        let configLoadCount = 0;
        let catalogLoadCount = 0;
        mock.module("@/config", () => ({
            loadConfig: async () => {
                configLoadCount += 1;
                return testConfig();
            },
        }));
        mock.module("@/providers/model-catalog", () => ({
            loadCatalog: async () => {
                catalogLoadCount += 1;
                return fixtureModels();
            },
        }));

        const input = JSON.stringify({
            models: ["openrouter/openai/gpt-5.2", "google-vertex/gemini-2.5-pro"],
            prompt: "stdin prompt",
        });
        const cases: Array<{ args: string[]; expected: string }> = [
            { args: ["--stdin-json", "--bogus"], expected: "unknown option" },
            {
                args: ["--stdin-json", "--synthesis-model", "one", "--synthesis-model", "two"],
                expected: "may only be specified once",
            },
            { args: ["--stdin-json", "--sequential=invalid"], expected: "must be true or false" },
        ];

        for (const { args, expected } of cases) {
            const { result, stderr, stdout } = await mockStdin(() => runConsensusCommand(args), input);
            expect(result).toBe(2);
            expect(stdout).toBe("");
            expect(stderr).toContain(expected);
        }
        expect(configLoadCount).toBe(0);
        expect(catalogLoadCount).toBe(0);
    });

    it("rejects invalid non-stdin temperature and model=value request fields", async () => {
        const validRequest = ["--models", "openrouter/openai/gpt-5.2,google-vertex/gemini-2.5-pro", "--prompt", "test"];
        const cases: Array<{ args: string[]; expected: string }> = [
            { args: ["--temperature", "2"], expected: "--temperature must be a number between 0 and 1" },
            { args: ["--stance", "model=invalid"], expected: "--stance must use model=for|against|neutral" },
            { args: ["--stance", "not-model-value"], expected: "--stance must use model=for|against|neutral" },
            {
                args: ["--thinking-mode", "model=invalid"],
                expected: "--thinking-mode must use model=minimal|low|medium|high|max",
            },
            {
                args: ["--temperature-model", "model=2"],
                expected: "--temperature-model must use model=<number between 0 and 1>",
            },
        ];

        for (const { args, expected } of cases) {
            stubDefaults();
            const { result, stderr } = await captureOutput(() => runConsensusCommand([...validRequest, ...args]));
            expect(result).toBe(2);
            expect(stderr).toContain(expected);
        }
    });

    it("rejects malformed temperatures before loading configuration or the catalog", async () => {
        let configLoadCount = 0;
        let catalogLoadCount = 0;
        const catalogResponse = fixtureModels();
        mock.module("@/config", () => ({
            loadConfig: async () => {
                configLoadCount += 1;
                return testConfig();
            },
        }));
        mock.module("@/providers/model-catalog", () => ({
            loadCatalog: async () => {
                catalogLoadCount += 1;
                return {
                    ok: true,
                    schema: catalogResponse.schema,
                    cache: catalogResponse.cache,
                    providers: catalogResponse.providers,
                };
            },
        }));

        const validRequest = ["--models", "openrouter/openai/gpt-5.2,google-vertex/gemini-2.5-pro", "--prompt", "test"];
        const cases: Array<{ args: string[]; expected: string }> = [
            {
                args: ["--temperature", "0.5trailing"],
                expected: "--temperature must be a number between 0 and 1",
            },
            {
                args: ["--temperature", "not-a-number"],
                expected: "--temperature must be a number between 0 and 1",
            },
            {
                args: ["--temperature-model", "openrouter/openai/gpt-5.2=0.5trailing"],
                expected: "--temperature-model must use model=<number between 0 and 1>",
            },
        ];

        for (const { args, expected } of cases) {
            const { result, stderr } = await captureOutput(() => runConsensusCommand([...validRequest, ...args]));
            expect(result).toBe(2);
            expect(stderr).toContain(expected);
        }
        expect(configLoadCount).toBe(0);
        expect(catalogLoadCount).toBe(0);
    });

    it("returns 2 for malformed or undersized --stdin-json", async () => {
        const cases = [
            { input: "not valid json {", expectedStderr: null },
            {
                input: JSON.stringify({ models: [], prompt: "test" }),
                expectedStderr: null,
            },
            {
                input: JSON.stringify({
                    models: ["openrouter/openai/gpt-5.2"],
                    prompt: "test",
                }),
                expectedStderr: "at least two models",
            },
        ];

        for (const { input, expectedStderr } of cases) {
            stubDefaults();
            const { result, stderr } = await mockStdin(() => runConsensusCommand(["--stdin-json"]), input);
            expect(result).toBe(2);
            if (expectedStderr) {
                expect(stderr).toContain(expectedStderr);
            }
        }
    });

    it("returns 3 and prints cli.consensus.error/1 for ambiguous model", async () => {
        stubCatalog(fixtureModels());
        stubConfiguredProviders(["openrouter", "google-vertex", "anthropic"]);
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
                    candidates: ["anthropic/shared", "azure/shared"],
                    message: "Model 'shared' is exposed by multiple configured providers.",
                },
            }),
        }));
        stubRunConsensus(defaultConsensusImpl);

        const { result, stdout } = await captureOutput(() =>
            runConsensusCommand(["--models", "shared,openrouter/openai/gpt-5.2", "--prompt", "test"]),
        );

        expect(result).toBe(3);
        const payload = JSON.parse(stdout);
        expect(payload.ok).toBe(false);
        expect(payload.schema).toBe("cli.consensus.error/1");
        expect(payload.error.code).toBe("ambiguous_model");
        expect(payload.error.input).toBe("shared");
        expect(payload.error.candidates).toContain("anthropic/shared");
        expect(payload.error.candidates).toContain("azure/shared");
        expect(payload.error.candidates.length).toBe(2);
    });

    it("returns 3 and prints cli.consensus.error/1 for unknown model", async () => {
        stubCatalog(fixtureModels());
        stubConfiguredProviders(["openrouter", "google-vertex", "anthropic"]);
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
            runConsensusCommand(["--models", "missing,openrouter/openai/gpt-5.2", "--prompt", "test"]),
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
        stubConfiguredProviders(["openrouter", "google-vertex", "anthropic"]);
        // Allow real resolution for participant models but fail for synthesis
        mock.module("@/providers/resolve-route", () => ({
            classifyInput: (input: string) =>
                input.includes("/")
                    ? { kind: "exact_route_id" as const, route_id: input }
                    : { kind: "unqualified" as const, providerModelId: input },
            resolveRoute: async (input: { kind: string; route_id?: string; providerModelId?: string }) => {
                const id = input.kind === "exact_route_id" ? input.route_id : input.providerModelId;
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
                        route_id: id ?? "openrouter/openai/gpt-5.2",
                        provider: "openrouter" as const,
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
                "openrouter/openai/gpt-5.2,google-vertex/gemini-2.5-pro",
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
                "openrouter/openai/gpt-5.2,google-vertex/gemini-2.5-pro",
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
        stubConfiguredProviders(["openrouter"]);
        stubRunConsensus(defaultConsensusImpl);

        const { result, stderr } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "openrouter/openai/gpt-5.2,google-vertex/gemini-2.5-pro",
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
        const { result, stdout } = await captureOutput(() => runCli(["--help"]));
        expect(result).toBe(0);
        expect(stdout).not.toContain("auto-picked");
        expect(stdout).toContain("skipped when absent");
        expect(stdout).toContain("route_id");
    });
});

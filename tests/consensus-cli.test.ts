import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Readable } from "node:stream";

import { runCli } from "@/cli";
import {
    DEFAULT_STDIN_MAX_BYTES,
    parseConsensusArgs,
    readStdinBounded,
    runConsensusCommand,
} from "@/commands/consensus";
import * as actualConfigModule from "@/config";
import * as actualConsensusModule from "@/consensus";
import * as actualModelCatalogModule from "@/providers/model-catalog";
import * as actualRegistryModule from "@/providers/registry";
import * as actualResolveRouteModule from "@/providers/resolve-route";
import { CliConsensusOutputSchema } from "@/types/consensus";
import {
    BrokerModelInfoSchema,
    type ModelsListResponse,
    type ProviderId,
    type ProviderListEntry,
} from "@/types/providers";
import * as actualLoggerModule from "@/utils/logger";
import { captureOutput, testConfig } from "./helpers";

const originalConfigExports = { ...actualConfigModule };
const originalConsensusExports = { ...actualConsensusModule };
const originalModelCatalogExports = { ...actualModelCatalogModule };
const originalRegistryExports = { ...actualRegistryModule };
const originalResolveRouteExports = { ...actualResolveRouteModule };
const originalLoggerExports = { ...actualLoggerModule };

type FullModelsListResponse = Omit<ModelsListResponse, "providers"> & {
    providers: Record<ProviderId, ProviderListEntry>;
};

const fixtureModels = (): FullModelsListResponse => {
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
    const providers: Record<ProviderId, ProviderListEntry> = {
        openrouter: { status: "catalog", models: [openaiModel] },
        "google-vertex": { status: "catalog", models: [geminiModel] },
        anthropic: { status: "catalog", models: [anthropicModel] },
        azure: { status: "catalog", models: [] },
        "amazon-bedrock": { status: "catalog", models: [] },
        custom: { status: "passthrough", models: [] },
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

const makeMockRegistry = (configured: string[]): ReturnType<typeof actualRegistryModule.createProviderRegistry> => ({
    getModelInfo: async () => undefined,
    isProviderConfigured: (id) => configured.includes(id),
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
});

type LoadCatalogResult = Awaited<ReturnType<typeof actualModelCatalogModule.loadCatalog>>;
type ResolveRouteFn = typeof actualResolveRouteModule.resolveRoute;
type ResolveRouteResult = ReturnType<ResolveRouteFn>;
type ClassifyInputFn = typeof actualResolveRouteModule.classifyInput;

let loadConfigHandler: typeof actualConfigModule.loadConfig;
let configureLoggingHandler: typeof actualLoggerModule.configureLogging;
let loadCatalogHandler: () => Promise<LoadCatalogResult>;
let isProviderConfiguredHandler: (id: string) => boolean;
let createProviderRegistryHandler: () => ReturnType<typeof actualRegistryModule.createProviderRegistry>;
let classifyInputHandler: ClassifyInputFn;
let resolveRouteHandler: ResolveRouteFn;
let runConsensusHandler: (request: unknown) => Promise<unknown>;

const resetMocks = (): void => {
    loadConfigHandler = async () => testConfig();
    configureLoggingHandler = async () => {};
    const defaultCatalog = fixtureModels();
    loadCatalogHandler = async () => ({
        ok: true,
        schema: defaultCatalog.schema,
        cache: defaultCatalog.cache,
        providers: defaultCatalog.providers,
    });
    const defaultConfigured = ["openrouter", "google-vertex", "anthropic"];
    isProviderConfiguredHandler = (id: string) => defaultConfigured.includes(id);
    createProviderRegistryHandler = () => makeMockRegistry(defaultConfigured);
    classifyInputHandler = originalResolveRouteExports.classifyInput;
    resolveRouteHandler = originalResolveRouteExports.resolveRoute;
    runConsensusHandler = defaultConsensusImpl;
};

resetMocks();

mock.module("@/config", () => ({
    ...originalConfigExports,
    loadConfig: (...args: Parameters<typeof actualConfigModule.loadConfig>) => loadConfigHandler(...args),
}));

mock.module("@/utils/logger", () => ({
    ...originalLoggerExports,
    configureLogging: (...args: Parameters<typeof actualLoggerModule.configureLogging>) =>
        configureLoggingHandler(...args),
}));

mock.module("@/providers/model-catalog", () => ({
    ...originalModelCatalogExports,
    loadCatalog: () => loadCatalogHandler(),
}));

mock.module("@/providers/registry", () => ({
    ...originalRegistryExports,
    isProviderConfigured: (id: string) => isProviderConfiguredHandler(id),
    createProviderRegistry: () => createProviderRegistryHandler(),
}));

mock.module("@/providers/resolve-route", () => ({
    ...originalResolveRouteExports,
    classifyInput: (input: string) => classifyInputHandler(input),
    resolveRoute: (input: Parameters<ResolveRouteFn>[0], options: Parameters<ResolveRouteFn>[1]) =>
        resolveRouteHandler(input, options),
}));

mock.module("@/consensus", () => ({
    ...originalConsensusExports,
    runConsensus: (request: unknown) => runConsensusHandler(request),
}));

beforeEach(() => {
    resetMocks();
});

afterEach(() => {
    resetMocks();
});

afterAll(() => {
    mock.module("@/config", () => originalConfigExports);
    mock.module("@/utils/logger", () => originalLoggerExports);
    mock.module("@/providers/model-catalog", () => originalModelCatalogExports);
    mock.module("@/providers/registry", () => originalRegistryExports);
    mock.module("@/providers/resolve-route", () => originalResolveRouteExports);
    mock.module("@/consensus", () => originalConsensusExports);
});

const stubConfig = (impl: typeof actualConfigModule.loadConfig): void => {
    loadConfigHandler = impl;
};

const stubCatalog = (response: FullModelsListResponse): void => {
    loadCatalogHandler = async () => ({
        ok: true,
        schema: response.schema,
        cache: response.cache,
        providers: response.providers,
    });
};

const stubCatalogUnavailable = (message: string): void => {
    loadCatalogHandler = async () => ({
        ok: false,
        error: { code: "catalog_unavailable", message },
    });
};

const stubConfiguredProviders = (configured: string[]): void => {
    isProviderConfiguredHandler = (id: string) => configured.includes(id);
    createProviderRegistryHandler = () => makeMockRegistry(configured);
};

const stubRunConsensus = (impl: (request: unknown) => Promise<unknown>): void => {
    runConsensusHandler = impl;
};

const stubDefaults = (): void => {
    resetMocks();
};

const stubDownstreamWorkCounters = () => {
    const counters = {
        configLoad: 0,
        catalogLoad: 0,
        routeWork: 0,
        consensus: 0,
    };
    stubConfig(async () => {
        counters.configLoad += 1;
        return testConfig();
    });
    loadCatalogHandler = async () => {
        counters.catalogLoad += 1;
        const response = fixtureModels();
        return {
            ok: true as const,
            schema: response.schema,
            cache: response.cache,
            providers: response.providers,
        };
    };
    classifyInputHandler = (input: string) => {
        counters.routeWork += 1;
        return input.includes("/")
            ? { kind: "exact_route_id" as const, route_id: input }
            : { kind: "unqualified" as const, providerModelId: input };
    };
    resolveRouteHandler = () => {
        counters.routeWork += 1;
        throw new Error("route resolution must not run");
    };
    stubRunConsensus(async () => {
        counters.consensus += 1;
        return defaultConsensusImpl();
    });
    return counters;
};

const stubRouteResolver = (resolveInput: (input: string) => ResolveRouteResult) => {
    const classificationCounts = new Map<string, number>();
    const resolutionCounts = new Map<string, number>();
    classifyInputHandler = (input: string) => {
        classificationCounts.set(input, (classificationCounts.get(input) ?? 0) + 1);
        return input.includes("/")
            ? { kind: "exact_route_id" as const, route_id: input }
            : { kind: "unqualified" as const, providerModelId: input };
    };
    resolveRouteHandler = (input) => {
        const rawInput = input.kind === "exact_route_id" ? input.route_id : input.providerModelId;
        resolutionCounts.set(rawInput, (resolutionCounts.get(rawInput) ?? 0) + 1);
        return resolveInput(rawInput);
    };
    return { classificationCounts, resolutionCounts };
};

const mockStdin = async (
    run: () => Promise<number>,
    input: string | Readable,
): Promise<{ result: number; stderr: string; stdout: string }> => {
    const stream = typeof input === "string" ? Readable.from([Buffer.from(input)]) : input;
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", {
        value: stream,
        writable: true,
        configurable: true,
    });
    try {
        return await captureOutput(run);
    } finally {
        if (originalDescriptor) {
            Object.defineProperty(process, "stdin", originalDescriptor);
        } else {
            delete (process as { stdin?: NodeJS.ReadStream }).stdin;
        }
        stream.destroy();
    }
};

const createTrackedStdin = (): { reads: { count: number }; stream: Readable } => {
    const reads = { count: 0 };
    const stream = new Readable({
        read() {
            reads.count += 1;
            this.push(null);
        },
    });
    return { reads, stream };
};

const expectStdinJsonRejection = async (args: string[], expectedError: string): Promise<void> => {
    const { reads, stream } = createTrackedStdin();
    const { result, stderr, stdout } = await mockStdin(() => runConsensusCommand(args), stream);

    expect(result).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toBe(`${expectedError}\n`);
    expect(reads.count).toBe(0);
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
            help: false,
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
            help: false,
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
        expect(parseSuccess(["--stdin-json", "--no-stdin-json", "--stdin-json=false"]).stdinJson).toBe(false);
        expect(parseSuccess(["--stdin-json=false", "--no-stdin-json", "--stdin-json"]).stdinJson).toBe(true);
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

    it("rejects negated value options like --no-models before minimist runs", () => {
        for (const option of [
            "models",
            "prompt",
            "files",
            "temperature",
            "stance",
            "thinking-mode",
            "temperature-model",
            "synthesis-model",
        ]) {
            expect(parseErrorMessage([`--no-${option}`])).toBe(`Error: unknown option --no-${option}`);
            expect(parseErrorMessage([`--no-${option}=value`])).toBe(`Error: unknown option --no-${option}`);
        }
    });

    it("parses --help and -h as known boolean options and still rejects unknown options", () => {
        expect(parseSuccess(["--models", "m1,m2", "--help"]).help).toBe(true);
        expect(parseSuccess(["--models", "m1,m2", "-h"]).help).toBe(true);
        expect(parseSuccess(["--no-help"]).help).toBe(false);
        expect(parseErrorMessage(["--help=invalid"])).toBe("Error: --help must be true or false");
        expect(parseErrorMessage(["--models", "m1,m2", "--help", "--bogus"])).toBe("Error: unknown option --bogus");
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

    it("prints real JSON Schema covering cli.consensus/2 and cli.consensus.error/1 with --schema flag", async () => {
        stubDefaults();
        const { result, stdout } = await captureOutput(() => runConsensusCommand(["--schema"]));
        expect(result).toBe(0);
        const parsed = JSON.parse(stdout.trim()) as {
            $schema?: string;
            anyOf?: Array<{
                type?: string;
                properties?: Record<string, { const?: unknown; type?: unknown }>;
                required?: string[];
            }>;
        };
        expect(parsed.$schema).toMatch(/json-schema\.org/);
        expect(Array.isArray(parsed.anyOf)).toBe(true);
        expect(parsed.anyOf).toHaveLength(2);

        const successBranch = parsed.anyOf?.find((branch) => branch.properties?.schema?.const === "cli.consensus/2");
        const errorBranch = parsed.anyOf?.find(
            (branch) => branch.properties?.schema?.const === "cli.consensus.error/1",
        );
        expect(successBranch).toBeDefined();
        expect(errorBranch).toBeDefined();
        expect(successBranch?.properties?.ok?.const).toBe(true);
        expect(successBranch?.properties?.models?.type).toBe("array");
        expect(successBranch?.properties?.synthesis).toBeDefined();
        expect(successBranch?.properties?.synthesis_error).toBeDefined();
        expect(successBranch?.properties?.embeddedFiles).toBeDefined();
        expect(errorBranch?.properties?.ok?.const).toBe(false);
        expect(errorBranch?.properties?.error).toBeDefined();
    });

    it("prints schema before stdin conflict validation or downstream work after valid parsing", async () => {
        const counters = stubDownstreamWorkCounters();
        const { reads, stream } = createTrackedStdin();

        const { result, stderr, stdout } = await mockStdin(
            () => runConsensusCommand(["--stdin-json", "--models", "first,second", "--prompt=ignored", "--schema"]),
            stream,
        );

        expect(result).toBe(0);
        expect(stderr).toBe("");
        const parsed = JSON.parse(stdout) as {
            $schema?: string;
            anyOf?: Array<{ properties?: { schema?: { const?: string } } }>;
        };
        expect(parsed.$schema).toMatch(/json-schema\.org/);
        expect(parsed.anyOf?.some((branch) => branch.properties?.schema?.const === "cli.consensus/2")).toBe(true);
        expect(parsed.anyOf?.some((branch) => branch.properties?.schema?.const === "cli.consensus.error/1")).toBe(true);
        expect(reads.count).toBe(0);
        expect(counters.configLoad).toBe(0);
        expect(counters.catalogLoad).toBe(0);
    });

    it("rejects malformed --schema invocations before loading configuration or the catalog", async () => {
        const counters = stubDownstreamWorkCounters();

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
        expect(counters.configLoad).toBe(0);
        expect(counters.catalogLoad).toBe(0);
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
                    model_id: "openrouter/openai/gpt-5.2",
                    stance: "for",
                    thinking_mode: "high",
                    temperature: 0.5,
                },
                {
                    model_id: "google-vertex/gemini-2.5-pro",
                    stance: "against",
                    thinking_mode: "low",
                    temperature: 0.75,
                },
            ],
        });
    });

    it("uses the final parsed stdin JSON boolean value for operational execution", async () => {
        stubDefaults();
        const receivedRequests: unknown[] = [];
        stubRunConsensus(async (request: unknown) => {
            receivedRequests.push(request);
            return defaultConsensusImpl();
        });
        const models = "openrouter/openai/gpt-5.2,google-vertex/gemini-2.5-pro";
        const cliCases: Array<{ args: string[]; findings: string }> = [
            {
                args: ["--stdin-json=false", "--models", models, "--prompt", "explicit false"],
                findings: "explicit false",
            },
            {
                args: ["--no-stdin-json", `--models=${models}`, "--prompt=negated"],
                findings: "negated",
            },
            {
                args: ["--stdin-json", "--models", models, "--prompt", "repeated false", "--no-stdin-json"],
                findings: "repeated false",
            },
        ];

        for (const { args } of cliCases) {
            const { result, stderr } = await captureOutput(() => runConsensusCommand(args));
            expect(result).toBe(0);
            expect(stderr).toBe("");
        }
        expect(receivedRequests).toMatchObject(cliCases.map(({ findings }) => ({ findings, step: findings })));

        await expectStdinJsonRejection(
            ["--stdin-json=false", "--models", models, "--prompt", "ignored", "--stdin-json"],
            "Error: --models cannot be combined with --stdin-json",
        );
        expect(receivedRequests).toHaveLength(cliCases.length);
    });

    it("uses only the stdin JSON synthesis model for a standard-input request", async () => {
        stubDefaults();
        let receivedRequest: unknown;
        stubRunConsensus(async (request: unknown) => {
            receivedRequest = request;
            return defaultConsensusImpl();
        });

        const input = JSON.stringify({
            models: ["openrouter/openai/gpt-5.2", "gemini-2.5-pro"],
            prompt: "stdin prompt",
            temperature: 0.4,
            files: ["stdin.ts"],
            stances: { "gemini-2.5-pro": "for" },
            thinking_modes: { "gemini-2.5-pro": "high" },
            temperatures: { "gemini-2.5-pro": 0.6 },
            synthesis_model: "anthropic/claude-sonnet-4-5",
        });
        const { result } = await mockStdin(() => runConsensusCommand(["--stdin-json", "--sequential"]), input);

        expect(result).toBe(0);
        expect(receivedRequest).toMatchObject({
            findings: "stdin prompt",
            step: "stdin prompt",
            parallel: false,
            temperature: 0.4,
            relevantFiles: ["stdin.ts"],
            synthesisModel: "anthropic/claude-sonnet-4-5",
            models: [
                { model_id: "openrouter/openai/gpt-5.2" },
                {
                    model_id: "google-vertex/gemini-2.5-pro",
                    stance: "for",
                    thinking_mode: "high",
                    temperature: 0.6,
                },
            ],
        });
    });

    it("rejects a CLI synthesis model instead of using it as a stdin JSON fallback", async () => {
        stubDefaults();
        let consensusCalls = 0;
        stubRunConsensus(async () => {
            consensusCalls += 1;
            return defaultConsensusImpl();
        });

        await expectStdinJsonRejection(
            ["--stdin-json", "--synthesis-model", "anthropic/claude-sonnet-4-5"],
            "Error: --synthesis-model cannot be combined with --stdin-json",
        );

        expect(consensusCalls).toBe(0);
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
        const counters = stubDownstreamWorkCounters();

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
        expect(counters.configLoad).toBe(0);
        expect(counters.catalogLoad).toBe(0);
    });

    it("applies all CLI per-model fields from a uniquely resolved bare selector", async () => {
        stubDefaults();
        let receivedRequest: unknown;
        stubRunConsensus(async (request: unknown) => {
            receivedRequest = request;
            return defaultConsensusImpl();
        });

        const { result } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "gemini-2.5-pro,openrouter/openai/gpt-5.2",
                "--prompt",
                "test",
                "--stance",
                "gemini-2.5-pro=for",
                "--thinking-mode",
                "gemini-2.5-pro=high",
                "--temperature-model",
                "gemini-2.5-pro=0.6",
            ]),
        );

        expect(result).toBe(0);
        expect(receivedRequest).toMatchObject({
            models: [
                {
                    model_id: "google-vertex/gemini-2.5-pro",
                    stance: "for",
                    thinking_mode: "high",
                    temperature: 0.6,
                },
                { model_id: "openrouter/openai/gpt-5.2" },
            ],
        });
    });

    it("applies a canonical selector to a participant selected by bare ID", async () => {
        stubDefaults();
        let receivedRequest: unknown;
        stubRunConsensus(async (request: unknown) => {
            receivedRequest = request;
            return defaultConsensusImpl();
        });

        const { result } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "gemini-2.5-pro,openrouter/openai/gpt-5.2",
                "--prompt",
                "test",
                "--stance",
                "google-vertex/gemini-2.5-pro=against",
            ]),
        );

        expect(result).toBe(0);
        expect(receivedRequest).toMatchObject({
            models: [
                { model_id: "google-vertex/gemini-2.5-pro", stance: "against" },
                { model_id: "openrouter/openai/gpt-5.2" },
            ],
        });
    });

    it("accepts equal CLI bare and canonical aliases for string and numeric values", async () => {
        stubDefaults();
        let receivedRequest: unknown;
        stubRunConsensus(async (request: unknown) => {
            receivedRequest = request;
            return defaultConsensusImpl();
        });

        const { result } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "gemini-2.5-pro,openrouter/openai/gpt-5.2",
                "--prompt",
                "test",
                "--stance",
                "gemini-2.5-pro=for",
                "--stance",
                "google-vertex/gemini-2.5-pro=for",
                "--temperature-model",
                "gemini-2.5-pro=0.6",
                "--temperature-model",
                "google-vertex/gemini-2.5-pro=0.6",
            ]),
        );

        expect(result).toBe(0);
        expect(receivedRequest).toMatchObject({
            models: [
                {
                    model_id: "google-vertex/gemini-2.5-pro",
                    stance: "for",
                    temperature: 0.6,
                },
                { model_id: "openrouter/openai/gpt-5.2" },
            ],
        });
    });

    it("rejects conflicting CLI bare and canonical aliases for string and numeric values", async () => {
        const cases = [
            {
                flags: ["--stance", "gemini-2.5-pro=for", "--stance", "google-vertex/gemini-2.5-pro=against"],
                field: "stance",
            },
            {
                flags: [
                    "--temperature-model",
                    "gemini-2.5-pro=0.4",
                    "--temperature-model",
                    "google-vertex/gemini-2.5-pro=0.6",
                ],
                field: "temperature",
            },
        ];

        for (const { flags, field } of cases) {
            stubDefaults();
            let consensusCallCount = 0;
            stubRunConsensus(async () => {
                consensusCallCount += 1;
                return defaultConsensusImpl();
            });

            const { result, stderr, stdout } = await captureOutput(() =>
                runConsensusCommand([
                    "--models",
                    "gemini-2.5-pro,openrouter/openai/gpt-5.2",
                    "--prompt",
                    "test",
                    ...flags,
                ]),
            );

            expect(result).toBe(2);
            expect(stdout).toBe("");
            expect(stderr).toContain(field);
            expect(stderr).toContain("google-vertex/gemini-2.5-pro");
            expect(consensusCallCount).toBe(0);
        }
    });

    it("accepts equal stdin bare and canonical aliases for string and numeric values", async () => {
        stubDefaults();
        let receivedRequest: unknown;
        stubRunConsensus(async (request: unknown) => {
            receivedRequest = request;
            return defaultConsensusImpl();
        });

        const input = JSON.stringify({
            models: ["gemini-2.5-pro", "openrouter/openai/gpt-5.2"],
            prompt: "test",
            stances: {
                "gemini-2.5-pro": "for",
                "google-vertex/gemini-2.5-pro": "for",
            },
            temperatures: {
                "gemini-2.5-pro": 0.6,
                "google-vertex/gemini-2.5-pro": 0.6,
            },
        });
        const { result } = await mockStdin(() => runConsensusCommand(["--stdin-json"]), input);

        expect(result).toBe(0);
        expect(receivedRequest).toMatchObject({
            models: [
                {
                    model_id: "google-vertex/gemini-2.5-pro",
                    stance: "for",
                    temperature: 0.6,
                },
                { model_id: "openrouter/openai/gpt-5.2" },
            ],
        });
    });

    it("rejects conflicting stdin bare and canonical aliases for string and numeric values", async () => {
        const cases = [
            {
                field: "stances",
                values: {
                    "gemini-2.5-pro": "for",
                    "google-vertex/gemini-2.5-pro": "against",
                },
                errorField: "stance",
            },
            {
                field: "temperatures",
                values: {
                    "gemini-2.5-pro": 0.4,
                    "google-vertex/gemini-2.5-pro": 0.6,
                },
                errorField: "temperature",
            },
        ];

        for (const { field, values, errorField } of cases) {
            stubDefaults();
            let consensusCallCount = 0;
            stubRunConsensus(async () => {
                consensusCallCount += 1;
                return defaultConsensusImpl();
            });
            const input = JSON.stringify({
                models: ["gemini-2.5-pro", "openrouter/openai/gpt-5.2"],
                prompt: "test",
                [field]: values,
            });

            const { result, stderr, stdout } = await mockStdin(() => runConsensusCommand(["--stdin-json"]), input);

            expect(result).toBe(2);
            expect(stdout).toBe("");
            expect(stderr).toContain(errorField);
            expect(stderr).toContain("google-vertex/gemini-2.5-pro");
            expect(consensusCallCount).toBe(0);
        }
    });

    it("returns structured code 3 for an unknown per-model selector", async () => {
        stubDefaults();
        let consensusCallCount = 0;
        stubRunConsensus(async () => {
            consensusCallCount += 1;
            return defaultConsensusImpl();
        });

        const { result, stderr, stdout } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "openrouter/openai/gpt-5.2,google-vertex/gemini-2.5-pro",
                "--prompt",
                "test",
                "--stance",
                "missing=for",
            ]),
        );

        expect(result).toBe(3);
        expect(stderr).toBe("");
        const payload = JSON.parse(stdout);
        expect(payload.schema).toBe("cli.consensus.error/1");
        expect(payload.error.code).toBe("unknown_model");
        expect(payload.error.input).toBe("missing");
        expect(consensusCallCount).toBe(0);
    });

    it("rejects a resolved per-model selector for an unselected participant", async () => {
        stubDefaults();
        let consensusCallCount = 0;
        stubRunConsensus(async () => {
            consensusCallCount += 1;
            return defaultConsensusImpl();
        });

        const { result, stderr, stdout } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "openrouter/openai/gpt-5.2,google-vertex/gemini-2.5-pro",
                "--prompt",
                "test",
                "--stance",
                "claude-sonnet-4-5=for",
            ]),
        );

        expect(result).toBe(2);
        expect(stdout).toBe("");
        expect(stderr).toContain("claude-sonnet-4-5");
        expect(stderr).toContain("anthropic/claude-sonnet-4-5");
        expect(stderr).toContain("selected participant");
        expect(consensusCallCount).toBe(0);
    });

    it("keeps a bare per-model selector globally ambiguous when only one matching route is selected", async () => {
        const baseCatalog = fixtureModels();
        const googleEntry = baseCatalog.providers["google-vertex"];
        const anthropicEntry = baseCatalog.providers.anthropic;
        if (googleEntry.status !== "catalog" || anthropicEntry.status !== "catalog") {
            throw new Error("Expected catalog-backed fixture providers");
        }
        const sharedGoogle = BrokerModelInfoSchema.parse({
            route_id: "google-vertex/shared",
            provider: "google-vertex",
            provider_model_id: "shared",
            display_name: "Shared Google model",
        });
        const sharedAnthropic = BrokerModelInfoSchema.parse({
            route_id: "anthropic/shared",
            provider: "anthropic",
            provider_model_id: "shared",
            display_name: "Shared Anthropic model",
        });
        stubCatalog({
            ...baseCatalog,
            providers: {
                ...baseCatalog.providers,
                "google-vertex": {
                    ...googleEntry,
                    models: [...googleEntry.models, sharedGoogle],
                },
                anthropic: {
                    ...anthropicEntry,
                    models: [...anthropicEntry.models, sharedAnthropic],
                },
            },
        });
        stubConfiguredProviders(["openrouter", "google-vertex", "anthropic"]);
        let consensusCallCount = 0;
        stubRunConsensus(async () => {
            consensusCallCount += 1;
            return defaultConsensusImpl();
        });

        const { result, stderr, stdout } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "google-vertex/shared,openrouter/openai/gpt-5.2",
                "--prompt",
                "test",
                "--stance",
                "shared=for",
            ]),
        );

        expect(result).toBe(3);
        expect(stderr).toBe("");
        const payload = JSON.parse(stdout);
        expect(payload.error.code).toBe("ambiguous_model");
        expect(payload.error.input).toBe("shared");
        expect(payload.error.candidates).toEqual(["anthropic/shared", "google-vertex/shared"]);
        expect(consensusCallCount).toBe(0);
    });

    it("returns structured code 3 for a special-key selector", async () => {
        stubDefaults();
        let consensusCallCount = 0;
        stubRunConsensus(async () => {
            consensusCallCount += 1;
            return defaultConsensusImpl();
        });

        const { result, stderr, stdout } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "openrouter/openai/gpt-5.2,google-vertex/gemini-2.5-pro",
                "--prompt",
                "test",
                "--stance",
                "__proto__=for",
            ]),
        );

        expect(result).toBe(3);
        expect(stderr).toBe("");
        const payload = JSON.parse(stdout);
        expect(payload.schema).toBe("cli.consensus.error/1");
        expect(payload.error.code).toBe("unknown_model");
        expect(payload.error.input).toBe("__proto__");
        expect(consensusCallCount).toBe(0);
    });

    it("rejects conflicting repeated assignments for a special-key selector", async () => {
        stubDefaults();
        let consensusCallCount = 0;
        stubRunConsensus(async () => {
            consensusCallCount += 1;
            return defaultConsensusImpl();
        });

        const { result, stderr, stdout } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "openrouter/openai/gpt-5.2,google-vertex/gemini-2.5-pro",
                "--prompt",
                "test",
                "--stance",
                "__proto__=for",
                "--stance",
                "__proto__=against",
            ]),
        );

        expect(result).toBe(2);
        expect(stdout).toBe("");
        expect(stderr).toContain("--stance");
        expect(stderr).toContain("__proto__");
        expect(consensusCallCount).toBe(0);
    });

    it("accepts equal repeated raw CLI selectors and rejects conflicting repeats", async () => {
        stubDefaults();
        let receivedRequest: unknown;
        stubRunConsensus(async (request: unknown) => {
            receivedRequest = request;
            return defaultConsensusImpl();
        });

        const equal = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "gemini-2.5-pro,openrouter/openai/gpt-5.2",
                "--prompt",
                "test",
                "--stance",
                "gemini-2.5-pro=for",
                "--stance",
                "gemini-2.5-pro=for",
            ]),
        );
        expect(equal.result).toBe(0);
        expect(receivedRequest).toMatchObject({
            models: [
                { model_id: "google-vertex/gemini-2.5-pro", stance: "for" },
                { model_id: "openrouter/openai/gpt-5.2" },
            ],
        });

        stubDefaults();
        let conflictCallCount = 0;
        stubRunConsensus(async () => {
            conflictCallCount += 1;
            return defaultConsensusImpl();
        });
        const conflict = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "gemini-2.5-pro,openrouter/openai/gpt-5.2",
                "--prompt",
                "test",
                "--stance",
                "gemini-2.5-pro=for",
                "--stance",
                "gemini-2.5-pro=against",
            ]),
        );
        expect(conflict.result).toBe(2);
        expect(conflict.stdout).toBe("");
        expect(conflict.stderr).toContain("--stance");
        expect(conflict.stderr).toContain("gemini-2.5-pro");
        expect(conflictCallCount).toBe(0);
    });

    it("accepts valid stdin JSON split across multiple chunks and restores the stdin descriptor", async () => {
        stubDefaults();
        let receivedRequest: unknown;
        stubRunConsensus(async (request: unknown) => {
            receivedRequest = request;
            return defaultConsensusImpl();
        });
        const originalDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
        const input = JSON.stringify({
            models: ["openrouter/openai/gpt-5.2", "google-vertex/gemini-2.5-pro"],
            prompt: "multi-chunk",
        });
        const midpoint = Math.floor(input.length / 2);
        const stream = Readable.from([Buffer.from(input.slice(0, midpoint)), Buffer.from(input.slice(midpoint))]);

        const { result, stderr } = await mockStdin(() => runConsensusCommand(["--stdin-json"]), stream);

        expect(result).toBe(0);
        expect(stderr).toBe("");
        expect(receivedRequest).toMatchObject({ findings: "multi-chunk", step: "multi-chunk" });
        expect(Object.getOwnPropertyDescriptor(process, "stdin")).toEqual(originalDescriptor);
        expect(stream.destroyed).toBe(true);
    });

    it("returns 2 for malformed or undersized --stdin-json", async () => {
        const cases = [
            { input: "not valid json {", expectedStderr: "Error: Invalid --stdin-json input:" },
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
        stubRouteResolver(() => ({
            ok: false as const,
            error: {
                code: "ambiguous_model" as const,
                input: "shared",
                candidates: ["anthropic/shared", "azure/shared"],
                message: "Model 'shared' is exposed by multiple configured providers.",
            },
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
        stubRouteResolver(() => ({
            ok: false as const,
            error: {
                code: "model_not_found" as const,
                input: "missing",
                message: "No configured provider exposes model 'missing'.",
            },
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
        stubRouteResolver((id) => {
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
                    route_id: id,
                    provider: "openrouter" as const,
                    provider_model_id: "gpt-5.2",
                    display_name: "GPT-5.2",
                },
            };
        });
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

    it("keeps stdin JSON unresolved synthesis warnings source-neutral without changing request behavior", async () => {
        stubDefaults();
        const openrouterModel = BrokerModelInfoSchema.parse({
            route_id: "openrouter/openai/gpt-5.2",
            provider: "openrouter",
            provider_model_id: "openai/gpt-5.2",
            display_name: "GPT-5.2",
        });
        const googleModel = BrokerModelInfoSchema.parse({
            route_id: "google-vertex/gemini-2.5-pro",
            provider: "google-vertex",
            provider_model_id: "gemini-2.5-pro",
            display_name: "Gemini 2.5 Pro",
        });
        stubRouteResolver((input) => {
            if (input === "openrouter/openai/gpt-5.2") {
                return { ok: true as const, value: openrouterModel };
            }
            if (input === "google-vertex/gemini-2.5-pro") {
                return { ok: true as const, value: googleModel };
            }
            if (input === "synth-missing") {
                return {
                    ok: false as const,
                    error: {
                        code: "model_not_found" as const,
                        input,
                        message: "synth model not found",
                    },
                };
            }
            throw new Error(`Unexpected route input: ${input}`);
        });
        let receivedRequest: unknown;
        stubRunConsensus(async (request: unknown) => {
            receivedRequest = request;
            return defaultConsensusImpl();
        });
        const input = JSON.stringify({
            models: ["openrouter/openai/gpt-5.2", "google-vertex/gemini-2.5-pro"],
            prompt: "stdin prompt",
            synthesis_model: "synth-missing",
        });

        const { result, stderr, stdout } = await mockStdin(() => runConsensusCommand(["--stdin-json"]), input);

        expect(result).toBe(0);
        expect(stderr).toContain(
            "Warning: synthesis model could not be resolved (synth-missing); synthesis will be skipped.",
        );
        expect(stderr).not.toContain("--synthesis-model");
        expect(receivedRequest).toMatchObject({
            findings: "stdin prompt",
            step: "stdin prompt",
            synthesisModel: undefined,
            models: [{ model_id: "openrouter/openai/gpt-5.2" }, { model_id: "google-vertex/gemini-2.5-pro" }],
        });
        const payload = JSON.parse(stdout);
        expect(payload.synthesis).toBeNull();
        expect(payload.synthesis_error).toEqual({
            code: "synthesis_model_unresolved",
            message: "synth model not found",
            retryable: false,
        });
    });

    it("classifies and resolves one active selector only once across all three maps", async () => {
        stubDefaults();
        const googleModel = BrokerModelInfoSchema.parse({
            route_id: "google-vertex/gemini-2.5-pro",
            provider: "google-vertex",
            provider_model_id: "gemini-2.5-pro",
            display_name: "Gemini 2.5 Pro",
        });
        const openrouterModel = BrokerModelInfoSchema.parse({
            route_id: "openrouter/openai/gpt-5.2",
            provider: "openrouter",
            provider_model_id: "openai/gpt-5.2",
            display_name: "GPT-5.2",
        });
        const { classificationCounts, resolutionCounts } = stubRouteResolver((input) => {
            if (input === "google-vertex/gemini-2.5-pro" || input === "gemini-2.5-pro") {
                return { ok: true as const, value: googleModel };
            }
            if (input === "openrouter/openai/gpt-5.2") {
                return { ok: true as const, value: openrouterModel };
            }
            throw new Error(`Unexpected route input: ${input}`);
        });
        let receivedRequest: unknown;
        stubRunConsensus(async (request: unknown) => {
            receivedRequest = request;
            return defaultConsensusImpl();
        });

        const { result } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "google-vertex/gemini-2.5-pro,openrouter/openai/gpt-5.2",
                "--prompt",
                "test",
                "--stance",
                "gemini-2.5-pro=for",
                "--thinking-mode",
                "gemini-2.5-pro=high",
                "--temperature-model",
                "gemini-2.5-pro=0.6",
            ]),
        );

        expect(result).toBe(0);
        expect(classificationCounts.get("gemini-2.5-pro")).toBe(1);
        expect(resolutionCounts.get("gemini-2.5-pro")).toBe(1);
        expect(receivedRequest).toMatchObject({
            models: [
                {
                    model_id: "google-vertex/gemini-2.5-pro",
                    stance: "for",
                    thinking_mode: "high",
                    temperature: 0.6,
                },
                { model_id: "openrouter/openai/gpt-5.2" },
            ],
        });
    });

    it("finishes selector resolution before rejecting an earlier unselected selector", async () => {
        stubDefaults();
        const googleModel = BrokerModelInfoSchema.parse({
            route_id: "google-vertex/gemini-2.5-pro",
            provider: "google-vertex",
            provider_model_id: "gemini-2.5-pro",
            display_name: "Gemini 2.5 Pro",
        });
        const openrouterModel = BrokerModelInfoSchema.parse({
            route_id: "openrouter/openai/gpt-5.2",
            provider: "openrouter",
            provider_model_id: "openai/gpt-5.2",
            display_name: "GPT-5.2",
        });
        const anthropicModel = BrokerModelInfoSchema.parse({
            route_id: "anthropic/claude-sonnet-4-5",
            provider: "anthropic",
            provider_model_id: "claude-sonnet-4-5",
            display_name: "Claude Sonnet 4.5",
        });
        const { classificationCounts, resolutionCounts } = stubRouteResolver((input) => {
            if (input === "google-vertex/gemini-2.5-pro") {
                return { ok: true as const, value: googleModel };
            }
            if (input === "openrouter/openai/gpt-5.2") {
                return { ok: true as const, value: openrouterModel };
            }
            if (input === "claude-sonnet-4-5") {
                return { ok: true as const, value: anthropicModel };
            }
            if (input === "shared") {
                return {
                    ok: false as const,
                    error: {
                        code: "ambiguous_model" as const,
                        input: "shared",
                        candidates: ["anthropic/shared", "google-vertex/shared"],
                        message: "Model 'shared' is exposed by multiple configured providers.",
                    },
                };
            }
            throw new Error(`Unexpected route input: ${input}`);
        });
        let consensusCallCount = 0;
        stubRunConsensus(async () => {
            consensusCallCount += 1;
            return defaultConsensusImpl();
        });

        const { result, stderr, stdout } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "google-vertex/gemini-2.5-pro,openrouter/openai/gpt-5.2",
                "--prompt",
                "test",
                "--stance",
                "claude-sonnet-4-5=for",
                "--thinking-mode",
                "shared=high",
            ]),
        );

        expect(result).toBe(3);
        expect(stderr).toBe("");
        const payload = JSON.parse(stdout);
        expect(payload.error.code).toBe("ambiguous_model");
        expect(payload.error.input).toBe("shared");
        expect(payload.error.candidates).toEqual(["anthropic/shared", "google-vertex/shared"]);
        expect(classificationCounts.get("claude-sonnet-4-5")).toBe(1);
        expect(resolutionCounts.get("claude-sonnet-4-5")).toBe(1);
        expect(classificationCounts.get("shared")).toBe(1);
        expect(resolutionCounts.get("shared")).toBe(1);
        expect(consensusCallCount).toBe(0);
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
        stubConfig(async () => {
            throw new Error("boom");
        });
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

    it("preserves parser-error precedence in stdin JSON mode before input or downstream work", async () => {
        const counters = stubDownstreamWorkCounters();

        for (const option of ["models", "prompt", "temperature", "synthesis-model", "files"]) {
            await expectStdinJsonRejection(["--stdin-json", `--${option}=`], `Error: --${option} requires a value`);
            await expectStdinJsonRejection(
                ["--stdin-json", `--${option}`, "first", `--${option}`, "second"],
                `Error: --${option} may only be specified once`,
            );
        }
        await expectStdinJsonRejection(["--stdin-json", "--bogus"], "Error: unknown option --bogus");
        await expectStdinJsonRejection(
            ["--stdin-json", "--sequential=invalid"],
            "Error: --sequential must be true or false",
        );

        expect(counters.configLoad).toBe(0);
        expect(counters.catalogLoad).toBe(0);
        expect(counters.routeWork).toBe(0);
        expect(counters.consensus).toBe(0);
    });

    it("rejects every operational CLI option in both forms before input or downstream work", async () => {
        const counters = stubDownstreamWorkCounters();
        const conflicts = [
            { option: "models", value: "first,second" },
            { option: "prompt", value: "review" },
            { option: "files", value: "src/a.ts" },
            { option: "temperature", value: "0.2" },
            { option: "stance", value: "model=for" },
            { option: "thinking-mode", value: "model=minimal" },
            { option: "temperature-model", value: "model=0.2" },
            { option: "synthesis-model", value: "model" },
        ] as const;

        for (const { option, value } of conflicts) {
            const forms: string[][] = [[`--${option}`, value], [`--${option}=${value}`]];
            for (const form of forms) {
                await expectStdinJsonRejection(
                    ["--stdin-json", ...form],
                    `Error: --${option} cannot be combined with --stdin-json`,
                );
            }
        }

        expect(counters.configLoad).toBe(0);
        expect(counters.catalogLoad).toBe(0);
        expect(counters.routeWork).toBe(0);
        expect(counters.consensus).toBe(0);
    });

    it("reports the first stdin JSON conflict in original command-line order", async () => {
        const counters = stubDownstreamWorkCounters();
        const cases: Array<{ args: string[]; expectedOption: string }> = [
            {
                args: ["--stdin-json", "--prompt", "review", "--models=first,second"],
                expectedOption: "prompt",
            },
            {
                args: ["--files=src/a.ts", "--stdin-json", "--temperature", "0.2"],
                expectedOption: "files",
            },
            {
                args: ["--temperature-model=model=0.2", "--stance", "model=for", "--stdin-json"],
                expectedOption: "temperature-model",
            },
        ];

        for (const { args, expectedOption } of cases) {
            await expectStdinJsonRejection(args, `Error: --${expectedOption} cannot be combined with --stdin-json`);
        }

        expect(counters.configLoad).toBe(0);
        expect(counters.catalogLoad).toBe(0);
        expect(counters.routeWork).toBe(0);
        expect(counters.consensus).toBe(0);
    });

    it("returns code 1 for an immediate stdin stream error before downstream work", async () => {
        const counters = stubDownstreamWorkCounters();
        const originalDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
        const stream = new Readable({
            read() {
                this.destroy(new Error("stdin read failed"));
            },
        });

        const { result, stderr, stdout } = await mockStdin(() => runConsensusCommand(["--stdin-json"]), stream);

        expect(result).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("stdin read failed");
        expect(counters.configLoad).toBe(0);
        expect(counters.catalogLoad).toBe(0);
        expect(counters.routeWork).toBe(0);
        expect(counters.consensus).toBe(0);
        expect(Object.getOwnPropertyDescriptor(process, "stdin")).toEqual(originalDescriptor);
        expect(stream.destroyed).toBe(true);
    });

    it("returns code 1 for partial stdin followed by a stream error before downstream work", async () => {
        const counters = stubDownstreamWorkCounters();
        const originalDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
        const stream = Readable.from(
            (async function* () {
                yield Buffer.from('{"models":["openrouter/openai/gpt-5.2"');
                throw new Error("stdin interrupted");
            })(),
        );

        const { result, stderr, stdout } = await mockStdin(() => runConsensusCommand(["--stdin-json"]), stream);

        expect(result).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("stdin interrupted");
        expect(stderr).not.toContain("Invalid --stdin-json input");
        expect(counters.configLoad).toBe(0);
        expect(counters.catalogLoad).toBe(0);
        expect(counters.routeWork).toBe(0);
        expect(counters.consensus).toBe(0);
        expect(Object.getOwnPropertyDescriptor(process, "stdin")).toEqual(originalDescriptor);
        expect(stream.destroyed).toBe(true);
    });

    it("rejects negated value options with exit code 2", async () => {
        const counters = stubDownstreamWorkCounters();
        const { result, stdout, stderr } = await captureOutput(() => runConsensusCommand(["--no-models"]));

        expect(result).toBe(2);
        expect(stdout).toBe("");
        expect(stderr).toBe("Error: unknown option --no-models\n");
        expect(counters.configLoad).toBe(0);
    });

    it("rejects whitespace-only CLI --prompt with exit code 2 while preserving intentional indentation", async () => {
        const counters = stubDownstreamWorkCounters();
        const whitespace = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "openrouter/openai/gpt-5.2,google-vertex/gemini-2.5-pro",
                "--prompt",
                "   \t\n  ",
            ]),
        );
        expect(whitespace.result).toBe(2);
        expect(whitespace.stdout).toBe("");
        expect(whitespace.stderr).toContain("--prompt must be non-empty");
        expect(counters.configLoad).toBe(0);

        stubDefaults();
        let receivedRequest: unknown;
        stubRunConsensus(async (request: unknown) => {
            receivedRequest = request;
            return defaultConsensusImpl();
        });
        const indented = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "openrouter/openai/gpt-5.2,google-vertex/gemini-2.5-pro",
                "--prompt",
                "  keep leading spaces",
            ]),
        );
        expect(indented.result).toBe(0);
        expect(receivedRequest).toMatchObject({
            findings: "  keep leading spaces",
            step: "  keep leading spaces",
        });
    });

    it("enforces strict StdinConsensusSchema validation and trims models, files, and synthesis_model", async () => {
        const rejectedCases = [
            {
                name: "unknown key synthesisModel",
                payload: {
                    models: ["openrouter/openai/gpt-5.2", "google-vertex/gemini-2.5-pro"],
                    prompt: "hello",
                    synthesisModel: "anthropic/claude-sonnet-4-5",
                },
            },
            {
                name: "unknown key thinkingMode",
                payload: {
                    models: ["openrouter/openai/gpt-5.2", "google-vertex/gemini-2.5-pro"],
                    prompt: "hello",
                    thinkingMode: "high",
                },
            },
            {
                name: "whitespace-only prompt",
                payload: {
                    models: ["openrouter/openai/gpt-5.2", "google-vertex/gemini-2.5-pro"],
                    prompt: "   \n\t ",
                },
            },
            {
                name: "empty synthesis_model",
                payload: {
                    models: ["openrouter/openai/gpt-5.2", "google-vertex/gemini-2.5-pro"],
                    prompt: "hello",
                    synthesis_model: "   ",
                },
            },
            {
                name: "blank model entry",
                payload: {
                    models: ["openrouter/openai/gpt-5.2", "   "],
                    prompt: "hello",
                },
            },
            {
                name: "blank file entry",
                payload: {
                    models: ["openrouter/openai/gpt-5.2", "google-vertex/gemini-2.5-pro"],
                    prompt: "hello",
                    files: ["   "],
                },
            },
        ];

        for (const testCase of rejectedCases) {
            stubDefaults();
            const { result, stdout, stderr } = await mockStdin(
                () => runConsensusCommand(["--stdin-json"]),
                JSON.stringify(testCase.payload),
            );
            expect(result).toBe(2);
            expect(stdout).toBe("");
            expect(stderr).toContain("Error: Invalid --stdin-json input:");
        }

        stubDefaults();
        let receivedRequest: unknown;
        stubRunConsensus(async (request: unknown) => {
            receivedRequest = request;
            return defaultConsensusImpl();
        });
        const validPayload = JSON.stringify({
            models: ["  openrouter/openai/gpt-5.2  ", "  gemini-2.5-pro  "],
            prompt: "  indented prompt",
            files: ["  src/a.ts  "],
            synthesis_model: "  anthropic/claude-sonnet-4-5  ",
        });
        const { result, stderr } = await mockStdin(() => runConsensusCommand(["--stdin-json"]), validPayload);
        expect(result).toBe(0);
        expect(stderr).toContain("Warning: --files embeds local file contents");
        expect(receivedRequest).toMatchObject({
            findings: "  indented prompt",
            step: "  indented prompt",
            relevantFiles: ["src/a.ts"],
            synthesisModel: "anthropic/claude-sonnet-4-5",
            models: [{ model_id: "openrouter/openai/gpt-5.2" }, { model_id: "google-vertex/gemini-2.5-pro" }],
        });
    });

    it("returns exit code 1 for oversized --stdin-json input before downstream work", async () => {
        const counters = stubDownstreamWorkCounters();
        const chunk = Buffer.alloc(1024 * 1024, "a");
        const chunkCount = Math.ceil(DEFAULT_STDIN_MAX_BYTES / chunk.byteLength) + 1;
        const stream = Readable.from(
            (function* () {
                for (let i = 0; i < chunkCount; i += 1) {
                    yield chunk;
                }
            })(),
        );

        const { result, stdout, stderr } = await mockStdin(() => runConsensusCommand(["--stdin-json"]), stream);

        expect(result).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("Error: stdin exceeds maximum size");
        expect(counters.configLoad).toBe(0);
        expect(counters.catalogLoad).toBe(0);
        expect(counters.routeWork).toBe(0);
        expect(counters.consensus).toBe(0);
        expect(stream.destroyed).toBe(true);
    });

    it("rejects hung stdin streams with a timeout error in readStdinBounded", async () => {
        const hungStream = new Readable({
            read() {},
        });

        await expect(readStdinBounded(hungStream, { timeoutMs: 25 })).rejects.toThrow("timed out reading stdin");
        expect(hungStream.destroyed).toBe(true);
    });

    it("rejects duplicate canonical participants for identical IDs, alias collisions, and 3-model lists", async () => {
        const cases = [
            {
                models: "openrouter/openai/gpt-5.2,openrouter/openai/gpt-5.2",
                duplicate: "openrouter/openai/gpt-5.2",
            },
            {
                models: "claude-sonnet-4-5,anthropic/claude-sonnet-4-5",
                duplicate: "anthropic/claude-sonnet-4-5",
            },
            {
                models: "gemini-2.5-pro,google-vertex/gemini-2.5-pro",
                duplicate: "google-vertex/gemini-2.5-pro",
            },
            {
                models: "openrouter/openai/gpt-5.2,openrouter/openai/gpt-5.2,google-vertex/gemini-2.5-pro",
                duplicate: "openrouter/openai/gpt-5.2",
            },
        ];

        for (const testCase of cases) {
            stubDefaults();
            let consensusCalls = 0;
            stubRunConsensus(async () => {
                consensusCalls += 1;
                return defaultConsensusImpl();
            });

            const { result, stdout, stderr } = await captureOutput(() =>
                runConsensusCommand(["--models", testCase.models, "--prompt", "test"]),
            );

            expect(result).toBe(2);
            expect(stdout).toBe("");
            expect(stderr).toContain("duplicate participant");
            expect(stderr).toContain(testCase.duplicate);
            expect(consensusCalls).toBe(0);
        }
    });

    it("exits 130 on SIGINT and 143 on SIGTERM without writing partial stdout JSON", async () => {
        const signalCases: Array<{ signal: "SIGINT" | "SIGTERM"; expectedCode: number; shouldThrow: boolean }> = [
            { signal: "SIGINT", expectedCode: 130, shouldThrow: false },
            { signal: "SIGTERM", expectedCode: 143, shouldThrow: false },
            { signal: "SIGINT", expectedCode: 130, shouldThrow: true },
            { signal: "SIGTERM", expectedCode: 143, shouldThrow: true },
        ];

        for (const { signal, expectedCode, shouldThrow } of signalCases) {
            stubDefaults();
            let aborted = false;
            stubRunConsensus(
                (request: unknown) =>
                    new Promise((resolve, reject) => {
                        const { abortSignal } = request as { abortSignal: AbortSignal };
                        abortSignal.addEventListener("abort", () => {
                            aborted = true;
                            if (shouldThrow) {
                                reject(new Error("aborted"));
                            } else {
                                resolve(defaultConsensusImpl());
                            }
                        });
                        queueMicrotask(() => {
                            process.emit(signal, signal);
                        });
                    }),
            );

            const { result, stdout } = await captureOutput(() =>
                runConsensusCommand([
                    "--models",
                    "openrouter/openai/gpt-5.2,google-vertex/gemini-2.5-pro",
                    "--prompt",
                    "test",
                ]),
            );

            expect(aborted).toBe(true);
            expect(result).toBe(expectedCode);
            expect(stdout).toBe("");
        }
    });

    it("aborts runConsensus when cli_timeout_ms expires", async () => {
        stubConfig(async () => ({
            ...testConfig(),
            cli_timeout_ms: 25,
        }));
        let sawAbort = false;
        stubRunConsensus(
            (request: unknown) =>
                new Promise((resolve) => {
                    const { abortSignal } = request as { abortSignal: AbortSignal };
                    abortSignal.addEventListener("abort", () => {
                        sawAbort = true;
                        resolve(defaultConsensusImpl());
                    });
                }),
        );

        const { result } = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "openrouter/openai/gpt-5.2,google-vertex/gemini-2.5-pro",
                "--prompt",
                "test",
            ]),
        );

        expect(sawAbort).toBe(true);
        expect(result).toBe(0);
    });

    it("emits a stderr warning when --thinking-mode is assigned to providers that ignore it", async () => {
        const baseCatalog = fixtureModels();
        const azureModel = BrokerModelInfoSchema.parse({
            route_id: "azure/gpt-4o",
            provider: "azure",
            provider_model_id: "gpt-4o",
            display_name: "GPT-4o",
        });
        const bedrockModel = BrokerModelInfoSchema.parse({
            route_id: "amazon-bedrock/claude-3-7",
            provider: "amazon-bedrock",
            provider_model_id: "claude-3-7",
            display_name: "Claude 3.7",
        });
        const fullCatalog: FullModelsListResponse = {
            ...baseCatalog,
            providers: {
                ...baseCatalog.providers,
                azure: { status: "catalog", models: [azureModel] },
                "amazon-bedrock": { status: "catalog", models: [bedrockModel] },
            },
        };

        const unsupportedTargets = [
            { routeId: "azure/gpt-4o", provider: "azure" },
            { routeId: "google-vertex/gemini-2.5-pro", provider: "google-vertex" },
            { routeId: "amazon-bedrock/claude-3-7", provider: "amazon-bedrock" },
            { routeId: "custom/local-llm", provider: "custom" },
        ];

        for (const { routeId, provider } of unsupportedTargets) {
            stubCatalog(fullCatalog);
            stubConfiguredProviders(["openrouter", "google-vertex", "anthropic", "azure", "amazon-bedrock", "custom"]);
            stubRunConsensus(defaultConsensusImpl);

            const { result, stderr } = await captureOutput(() =>
                runConsensusCommand([
                    "--models",
                    `${routeId},openrouter/openai/gpt-5.2`,
                    "--prompt",
                    "test",
                    "--thinking-mode",
                    `${routeId}=high`,
                ]),
            );

            expect(result).toBe(0);
            expect(stderr).toContain("--thinking-mode is ignored");
            expect(stderr).toContain(provider);
            expect(stderr).toContain(routeId);
        }

        // No warning for anthropic and openrouter.
        stubCatalog(fullCatalog);
        stubConfiguredProviders(["openrouter", "anthropic"]);
        stubRunConsensus(defaultConsensusImpl);
        const supported = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "anthropic/claude-sonnet-4-5,openrouter/openai/gpt-5.2",
                "--prompt",
                "test",
                "--thinking-mode",
                "anthropic/claude-sonnet-4-5=high",
                "--thinking-mode",
                "openrouter/openai/gpt-5.2=medium",
            ]),
        );
        expect(supported.result).toBe(0);
        expect(supported.stderr).toBe("");
    });

    it("emits stdout JSON conforming to CliConsensusOutputSchema across success and error codes", async () => {
        // 1. Success response (cli.consensus/2)
        stubDefaults();
        const okRun = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "openrouter/openai/gpt-5.2,anthropic/claude-sonnet-4-5",
                "--prompt",
                "verify schema",
            ]),
        );
        expect(okRun.result).toBe(0);
        const parsedOk = CliConsensusOutputSchema.parse(JSON.parse(okRun.stdout));
        expect(parsedOk.ok).toBe(true);
        expect(parsedOk.schema).toBe("cli.consensus/2");

        // 2. Unresolved synthesis still conforms to cli.consensus/2
        stubDefaults();
        const unresolvedSynth = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "openrouter/openai/gpt-5.2,anthropic/claude-sonnet-4-5",
                "--prompt",
                "verify schema",
                "--synthesis-model",
                "openrouter/nonexistent-model",
            ]),
        );
        expect(unresolvedSynth.result).toBe(0);
        const parsedUnresolved = CliConsensusOutputSchema.parse(JSON.parse(unresolvedSynth.stdout));
        expect(parsedUnresolved.ok).toBe(true);
        if (parsedUnresolved.ok) {
            expect(parsedUnresolved.synthesis_error?.code).toBe("synthesis_model_unresolved");
        }

        // 3. Unknown model error (cli.consensus.error/1)
        stubDefaults();
        const unknownRun = await captureOutput(() =>
            runConsensusCommand(["--models", "openrouter/openai/gpt-5.2,no-such-model", "--prompt", "verify schema"]),
        );
        expect(unknownRun.result).toBe(3);
        const parsedUnknown = CliConsensusOutputSchema.parse(JSON.parse(unknownRun.stdout));
        expect(parsedUnknown.ok).toBe(false);
        if (!parsedUnknown.ok) {
            expect(parsedUnknown.error.code).toBe("unknown_model");
        }

        // 4. Broker error when all participants fail (cli.consensus.error/1)
        stubDefaults();
        stubRunConsensus(async () => ({ ok: false, errors: ["all models failed"] }));
        const brokerFail = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "openrouter/openai/gpt-5.2,anthropic/claude-sonnet-4-5",
                "--prompt",
                "verify schema",
            ]),
        );
        expect(brokerFail.result).toBe(1);
        const parsedBrokerFail = CliConsensusOutputSchema.parse(JSON.parse(brokerFail.stdout));
        expect(parsedBrokerFail.ok).toBe(false);
        if (!parsedBrokerFail.ok) {
            expect(parsedBrokerFail.error.code).toBe("broker_error");
        }

        // 5. Ambiguous model error (cli.consensus.error/1)
        stubDefaults();
        stubRouteResolver(() => ({
            ok: false as const,
            error: {
                code: "ambiguous_model" as const,
                input: "shared",
                candidates: ["anthropic/shared", "openrouter/shared"],
                message: "Model 'shared' is exposed by multiple configured providers.",
            },
        }));
        const ambiguousRun = await captureOutput(() =>
            runConsensusCommand(["--models", "shared,openrouter/openai/gpt-5.2", "--prompt", "verify schema"]),
        );
        expect(ambiguousRun.result).toBe(3);
        const parsedAmbiguous = CliConsensusOutputSchema.parse(JSON.parse(ambiguousRun.stdout));
        expect(parsedAmbiguous.ok).toBe(false);
        if (!parsedAmbiguous.ok) {
            expect(parsedAmbiguous.error.code).toBe("ambiguous_model");
            expect(parsedAmbiguous.error.candidates).toEqual(["anthropic/shared", "openrouter/shared"]);
        }

        // 6. Catalog unavailable error (cli.consensus.error/1)
        stubDefaults();
        stubCatalogUnavailable("models.dev unreachable");
        const catalogFail = await captureOutput(() =>
            runConsensusCommand([
                "--models",
                "openrouter/openai/gpt-5.2,anthropic/claude-sonnet-4-5",
                "--prompt",
                "verify schema",
            ]),
        );
        expect(catalogFail.result).toBe(1);
        const parsedCatalogFail = CliConsensusOutputSchema.parse(JSON.parse(catalogFail.stdout));
        expect(parsedCatalogFail.ok).toBe(false);
        if (!parsedCatalogFail.ok) {
            expect(parsedCatalogFail.error.code).toBe("catalog_unavailable");
        }
    });
});

describe("runCli", () => {
    it("documents synthesis and stdin JSON contracts", async () => {
        stubDefaults();
        const { result, stdout } = await captureOutput(() => runCli(["--help"]));
        expect(result).toBe(0);
        expect(stdout).not.toContain("auto-picked");
        expect(stdout).toContain("skipped when absent");
        expect(stdout).toContain("route_id");
        expect(stdout).toContain("exact route_id or a uniquely resolved bare provider_model_id");
        expect(stdout).toContain("exact unique provider_model_id match");
        expect(stdout).toContain("No suffix matching or automatic provider choice.");
        expect(stdout).not.toContain("suffix-matched selectors are accepted");
        expect(stdout).not.toContain("a provider is chosen automatically");

        const stdinSection = stdout.slice(stdout.indexOf("STDIN JSON:"), stdout.indexOf("PER-MODEL SELECTORS:"));
        expect(stdinSection).toContain("When --stdin-json is active, do not combine it with");
        for (const option of [
            "--models",
            "--prompt",
            "--files",
            "--temperature",
            "--stance",
            "--thinking-mode",
            "--temperature-model",
            "--synthesis-model",
        ]) {
            expect(stdinSection).toContain(option);
        }
        expect(stdinSection).toContain("JSON supplies all value-bearing operational fields.");
        expect(stdinSection).toContain("JSON synthesis_model is the only synthesis source in this mode.");
        expect(stdinSection).toContain("Boolean controls such as --sequential remain valid.");
        expect(stdinSection).toContain("Arguments are parsed first, so syntax errors take precedence.");
        expect(stdinSection).toContain("A valid --schema request exits before stdin conflict validation.");
        expect(stdinSection).toContain(
            "Otherwise, the first conflicting flag in command-line order is reported before stdin is read or downstream work starts.",
        );
        expect(stdout).not.toContain("CLI per-model flags are inactive");

        expect(stdout).toContain("1  Consensus or operational error, including stdin read failures");
        expect(stdout).toContain("2  Argument or request-validation error, including completed invalid stdin input");
        expect(stdout).toContain("malformed JSON or schema-invalid content");
    });
});

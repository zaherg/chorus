import { z } from "zod/v4";

import { printHelp } from "@/cli";
import { DEFAULT_CLI_TIMEOUT_MS, getConfigPaths, loadConfig } from "@/config";
import { runConsensus } from "@/consensus";
import { makeLocalFileReader, makeLocalFileWriter } from "@/providers/cache-fs";
import { loadCatalog } from "@/providers/model-catalog";
import {
    createProviderRegistry,
    isProviderConfigured,
    type ThinkingMode,
    ThinkingModeSchema,
    thinkingModeValues,
} from "@/providers/registry";
import { classifyInput, type ResolveRouteOptions, resolveRoute } from "@/providers/resolve-route";
import {
    type CliConsensusError,
    type CliConsensusErrorCode,
    CliConsensusOutputSchema,
    type CliConsensusResponse,
    type ParticipantError,
    type Stance,
    StanceSchema,
    stanceValues,
} from "@/types/consensus";
import { type BrokerModelInfo, providerIdValues } from "@/types/providers";
import type { Result, ToolError } from "@/types/tools";
import { clampTimeoutMs } from "@/utils/async";
import { getErrorMessage } from "@/utils/helpers";
import { configureLogging } from "@/utils/logger";
import { redactSecrets } from "@/utils/redact";
import { parseCliOptions } from "./cli-options";

export const DEFAULT_STDIN_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_STDIN_TIMEOUT_MS = 30_000;

export interface ReadStdinOptions {
    maxBytes?: number;
    timeoutMs?: number;
}

export type ReadableStdin = AsyncIterable<Buffer | Uint8Array | string> & {
    destroy?: (error?: Error) => unknown;
};

/** Reads UTF-8 text from stdin with bounded total byte size and an inactivity/overall timeout. */
export const readStdinBounded = async (stream: ReadableStdin, options: ReadStdinOptions = {}): Promise<string> => {
    const maxBytes = options.maxBytes ?? DEFAULT_STDIN_MAX_BYTES;
    const timeoutMs = clampTimeoutMs(options.timeoutMs, DEFAULT_STDIN_TIMEOUT_MS);

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            const err = new Error("timed out reading stdin");
            reject(err);
            stream.destroy?.();
        }, timeoutMs);
        if (typeof timer.unref === "function") {
            timer.unref();
        }
    });
    timeoutPromise.catch(() => {});

    const readPromise = (async (): Promise<string> => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        for await (const chunk of stream) {
            const buf = Buffer.isBuffer(chunk)
                ? chunk
                : typeof chunk === "string"
                  ? Buffer.from(chunk, "utf8")
                  : Buffer.from(chunk);
            totalBytes += buf.byteLength;
            if (totalBytes > maxBytes) {
                stream.destroy?.();
                throw new Error(`stdin exceeds maximum size (${maxBytes} bytes)`);
            }
            chunks.push(buf);
        }

        if (timedOut) {
            throw new Error("timed out reading stdin");
        }

        return Buffer.concat(chunks).toString("utf8");
    })();
    readPromise.catch(() => {});

    try {
        return await Promise.race([readPromise, timeoutPromise]);
    } catch (error) {
        if (timedOut) {
            throw new Error("timed out reading stdin");
        }
        throw error;
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
};

export const StdinConsensusSchema = z
    .object({
        models: z.array(z.string().trim().min(1)).min(1),
        prompt: z.string().refine((s) => s.trim().length > 0, "prompt must be non-empty"),
        findings: z.string().optional(),
        step: z.string().optional(),
        stances: z.record(z.string(), StanceSchema).optional(),
        thinking_modes: z.record(z.string(), ThinkingModeSchema).optional(),
        temperatures: z.record(z.string(), z.number().min(0).max(1)).optional(),
        temperature: z.number().min(0).max(1).optional(),
        files: z.array(z.string().trim().min(1)).optional(),
        synthesis_model: z.string().trim().min(1).optional(),
    })
    .strict();

const CONSENSUS_BOOLEAN_OPTIONS = ["sequential", "stdin-json", "schema", "help"] as const;

const CONSENSUS_SCALAR_OPTIONS = ["models", "prompt", "files", "temperature", "synthesis-model"] as const;

const CONSENSUS_REPEATABLE_OPTIONS = ["stance", "thinking-mode", "temperature-model"] as const;

export type ParsedConsensusArgs =
    | { mode: "help" }
    | { mode: "schema" }
    | { mode: "stdin-json"; sequential: boolean }
    | {
          mode: "flags";
          models: string | undefined;
          prompt: string | undefined;
          temperature: string | undefined;
          synthesisModel: string | undefined;
          files: string | undefined;
          stance: string[];
          thinkingMode: string[];
          temperatureModel: string[];
          sequential: boolean;
      };

const consensusArgumentError = (message: string, details?: unknown): { ok: false; error: ToolError } => ({
    ok: false,
    error: {
        type: "validation",
        message,
        details,
        retryable: false,
    },
});

const normalizeConsensusScalar = (option: string, values: readonly string[]): Result<string | undefined, ToolError> => {
    if (values.length > 1) {
        return consensusArgumentError(`Error: --${option} may only be specified once`);
    }
    if (values.length === 0) {
        return { ok: true, value: undefined };
    }
    if (values[0] === "") {
        return consensusArgumentError(`Error: --${option} requires a value`);
    }
    return { ok: true, value: values[0] };
};

const TEMPERATURE_VALUE_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const parseUnitIntervalTemperature = (value: string): number | undefined => {
    const normalized = value.trim();
    if (!TEMPERATURE_VALUE_PATTERN.test(normalized)) {
        return undefined;
    }

    const temperature = Number(normalized);
    return Number.isFinite(temperature) && temperature >= 0 && temperature <= 1 ? temperature : undefined;
};

/** Parses consensus command arguments without performing command execution. */
export const parseConsensusArgs = (args: string[]): Result<ParsedConsensusArgs, ToolError> => {
    const parsed = parseCliOptions(args, {
        booleans: CONSENSUS_BOOLEAN_OPTIONS,
        shortAliases: { h: "help" },
        scalars: CONSENSUS_SCALAR_OPTIONS,
        repeatables: CONSENSUS_REPEATABLE_OPTIONS,
    });
    if (!parsed.ok) {
        switch (parsed.kind) {
            case "separator":
                return consensusArgumentError("Error: arguments after -- are not supported");
            case "negated_boolean_value":
                return consensusArgumentError(`Error: ${parsed.option} does not accept an assigned value`, {
                    token: parsed.token,
                });
            case "invalid_boolean_value":
                return consensusArgumentError(`Error: ${parsed.option} must be true or false`, {
                    token: parsed.token,
                });
            case "unknown_option":
                return consensusArgumentError(`Error: unknown option ${parsed.option}`);
        }
    }

    if (parsed.positionals.length > 0) {
        return consensusArgumentError(`Error: unexpected argument ${parsed.positionals[0]}`);
    }

    const models = normalizeConsensusScalar("models", parsed.scalars.models);
    if (!models.ok) {
        return models;
    }
    const prompt = normalizeConsensusScalar("prompt", parsed.scalars.prompt);
    if (!prompt.ok) {
        return prompt;
    }
    const temperature = normalizeConsensusScalar("temperature", parsed.scalars.temperature);
    if (!temperature.ok) {
        return temperature;
    }
    const synthesisModel = normalizeConsensusScalar("synthesis-model", parsed.scalars["synthesis-model"]);
    if (!synthesisModel.ok) {
        return synthesisModel;
    }
    const files = normalizeConsensusScalar("files", parsed.scalars.files);
    if (!files.ok) {
        return files;
    }

    if (parsed.booleans.help) {
        return { ok: true, value: { mode: "help" } };
    }

    if (parsed.booleans.schema) {
        return { ok: true, value: { mode: "schema" } };
    }

    if (parsed.booleans["stdin-json"]) {
        const conflictingOption = parsed.valueOptionOrder[0];
        if (conflictingOption !== undefined) {
            return consensusArgumentError(`Error: --${conflictingOption} cannot be combined with --stdin-json`);
        }
        return {
            ok: true,
            value: {
                mode: "stdin-json",
                sequential: parsed.booleans.sequential,
            },
        };
    }

    return {
        ok: true,
        value: {
            mode: "flags",
            models: models.value,
            prompt: prompt.value,
            temperature: temperature.value,
            synthesisModel: synthesisModel.value,
            files: files.value,
            stance: parsed.repeatables.stance,
            thinkingMode: parsed.repeatables["thinking-mode"],
            temperatureModel: parsed.repeatables["temperature-model"],
            sequential: parsed.booleans.sequential,
        },
    };
};

const parseModelKeyValueFlags = <T>(
    option: string,
    flags: string[],
    validate: (raw: string) => T | undefined,
    expected: string,
): Result<Record<string, T>, ToolError> => {
    const assignments = new Map<string, T>();
    for (const flag of flags) {
        const equalsIndex = flag.indexOf("=");
        if (equalsIndex <= 0) {
            return consensusArgumentError(`Error: --${option} must use ${expected}`);
        }

        const model = flag.slice(0, equalsIndex);
        const value = flag.slice(equalsIndex + 1);
        const validated = validate(value);
        if (validated === undefined) {
            return consensusArgumentError(`Error: --${option} must use ${expected}`);
        }
        if (assignments.has(model) && !Object.is(assignments.get(model), validated)) {
            return consensusArgumentError(`Error: conflicting --${option} values for selector '${model}'`);
        }
        assignments.set(model, validated);
    }
    return { ok: true, value: Object.fromEntries(assignments) };
};

const normalizeModelOptionMap = <T>(
    field: string,
    values: Record<string, T>,
    selectorRoutes: ReadonlyMap<string, string>,
): Result<Record<string, T>, ToolError> => {
    const normalized: Record<string, T> = {};
    for (const [selector, value] of Object.entries(values)) {
        const routeId = selectorRoutes.get(selector);
        if (routeId === undefined) {
            return consensusArgumentError(`Error: unresolved ${field} selector '${selector}'`);
        }
        if (Object.hasOwn(normalized, routeId) && !Object.is(normalized[routeId], value)) {
            return consensusArgumentError(`Error: conflicting ${field} values for model '${routeId}'`);
        }
        normalized[routeId] = value;
    }
    return { ok: true, value: normalized };
};

const printError = (payload: CliConsensusError) => {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
};

const brokerError = (
    code: CliConsensusErrorCode,
    message: string,
    extra?: Pick<CliConsensusError["error"], "input" | "candidates">,
) => {
    printError({
        ok: false,
        schema: "cli.consensus.error/1",
        error: { code, message: redactSecrets(message), ...(extra ?? {}) },
    });
};

export interface ConsensusCommandDeps {
    loadConfig?: typeof loadConfig;
    configureLogging?: typeof configureLogging;
    getConfigPaths?: typeof getConfigPaths;
    loadCatalog?: typeof loadCatalog;
    isProviderConfigured?: typeof isProviderConfigured;
    createProviderRegistry?: typeof createProviderRegistry;
    classifyInput?: typeof classifyInput;
    resolveRoute?: typeof resolveRoute;
    runConsensus?: typeof runConsensus;
    fetchFn?: typeof globalThis.fetch;
    stdin?: ReadableStdin;
}

const resolveOne = (
    input: string,
    options: ResolveRouteOptions,
    classifyInputFn: typeof classifyInput = classifyInput,
    resolveRouteFn: typeof resolveRoute = resolveRoute,
): { ok: true; value: BrokerModelInfo } | { ok: false; handled: boolean } => {
    const classified = classifyInputFn(input);
    const result = resolveRouteFn(classified, options);
    if (result.ok) {
        return { ok: true, value: result.value };
    }
    if (result.error.code === "ambiguous_model") {
        brokerError("ambiguous_model", result.error.message, {
            input: result.error.input,
            candidates: result.error.candidates,
        });
        return { ok: false, handled: true };
    }
    brokerError("unknown_model", result.error.message, {
        input: result.error.input,
    });
    return { ok: false, handled: true };
};

export const runConsensusCommand = async (args: string[], deps: ConsensusCommandDeps = {}) => {
    const loadConfigFn = deps.loadConfig ?? loadConfig;
    const configureLoggingFn = deps.configureLogging ?? configureLogging;
    const getConfigPathsFn = deps.getConfigPaths ?? getConfigPaths;
    const loadCatalogFn = deps.loadCatalog ?? loadCatalog;
    const isProviderConfiguredFn = deps.isProviderConfigured ?? isProviderConfigured;
    const createProviderRegistryFn = deps.createProviderRegistry ?? createProviderRegistry;
    const classifyInputFn = deps.classifyInput ?? classifyInput;
    const resolveRouteFn = deps.resolveRoute ?? resolveRoute;
    const runConsensusFn = deps.runConsensus ?? runConsensus;
    const fetchFn = deps.fetchFn ?? globalThis.fetch;
    const stdinStream = deps.stdin ?? process.stdin;
    const parsed = parseConsensusArgs(args);
    if (!parsed.ok) {
        process.stderr.write(`${parsed.error.message}\n`);
        return 2;
    }

    const parsedArgs = parsed.value;
    if (parsedArgs.mode === "help") {
        printHelp();
        return 0;
    }

    if (parsedArgs.mode === "schema") {
        process.stdout.write(`${JSON.stringify(z.toJSONSchema(CliConsensusOutputSchema), null, 2)}\n`);
        return 0;
    }

    const { sequential } = parsedArgs;
    let modelInputs: string[];
    let promptText: string;
    let findings: string;
    let step: string;
    let modelStances: Record<string, Stance> = {};
    let modelThinkingModes: Record<string, ThinkingMode> = {};
    let modelTemperatures: Record<string, number> = {};
    let globalTemperature: number | undefined;
    let relevantFiles: string[] = [];
    let synthesisModel: string | undefined;

    if (parsedArgs.mode === "stdin-json") {
        let stdinText: string;
        try {
            stdinText = await readStdinBounded(stdinStream);
        } catch (e) {
            const message = redactSecrets(getErrorMessage(e));
            if (message.startsWith("stdin exceeds maximum size") || message.startsWith("timed out reading stdin")) {
                process.stderr.write(`Error: ${message}\n`);
            } else {
                process.stderr.write(`Error: Failed to read --stdin-json input: ${message}\n`);
            }
            return 1;
        }

        let parsedStdin: z.infer<typeof StdinConsensusSchema>;
        try {
            parsedStdin = StdinConsensusSchema.parse(JSON.parse(stdinText));
        } catch (e) {
            process.stderr.write(`Error: Invalid --stdin-json input: ${redactSecrets(getErrorMessage(e))}\n`);
            return 2;
        }
        modelInputs = parsedStdin.models;
        promptText = parsedStdin.prompt;
        findings = parsedStdin.findings ?? promptText;
        step = parsedStdin.step ?? promptText;
        if (parsedStdin.stances) modelStances = parsedStdin.stances;
        if (parsedStdin.thinking_modes) modelThinkingModes = parsedStdin.thinking_modes;
        if (parsedStdin.temperatures) modelTemperatures = parsedStdin.temperatures;
        globalTemperature = parsedStdin.temperature;
        relevantFiles = parsedStdin.files ?? [];
        synthesisModel = parsedStdin.synthesis_model;
    } else {
        const {
            files: filesStr,
            models: modelsStr,
            prompt,
            stance: stanceFlags,
            synthesisModel: synthesisModelFlag,
            temperature: temperatureStr,
            temperatureModel: tempModelFlags,
            thinkingMode: thinkingModeFlags,
        } = parsedArgs;
        synthesisModel = synthesisModelFlag;
        if (!modelsStr) {
            process.stderr.write("Error: --models is required (comma-separated route_ids or provider-native IDs)\n");
            return 2;
        }
        modelInputs = modelsStr
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        if (prompt === undefined) {
            process.stderr.write("Error: --prompt is required (or use --stdin-json)\n");
            return 2;
        }
        if (prompt.trim().length === 0) {
            process.stderr.write("Error: --prompt must be non-empty\n");
            return 2;
        }
        promptText = prompt;
        findings = prompt;
        step = prompt;

        if (temperatureStr) {
            const temperature = parseUnitIntervalTemperature(temperatureStr);
            if (temperature === undefined) {
                process.stderr.write("Error: --temperature must be a number between 0 and 1\n");
                return 2;
            }
            globalTemperature = temperature;
        }

        if (filesStr) {
            relevantFiles = filesStr
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        }

        const parsedStances = parseModelKeyValueFlags(
            "stance",
            stanceFlags,
            (value): Stance | undefined => {
                const validated = StanceSchema.safeParse(value);
                return validated.success ? validated.data : undefined;
            },
            `model=${stanceValues.join("|")}`,
        );
        if (!parsedStances.ok) {
            process.stderr.write(`${parsedStances.error.message}\n`);
            return 2;
        }
        modelStances = parsedStances.value;

        const parsedThinkingModes = parseModelKeyValueFlags(
            "thinking-mode",
            thinkingModeFlags,
            (value): ThinkingMode | undefined => {
                const validated = ThinkingModeSchema.safeParse(value);
                return validated.success ? validated.data : undefined;
            },
            `model=${thinkingModeValues.join("|")}`,
        );
        if (!parsedThinkingModes.ok) {
            process.stderr.write(`${parsedThinkingModes.error.message}\n`);
            return 2;
        }
        modelThinkingModes = parsedThinkingModes.value;

        const parsedTemperatures = parseModelKeyValueFlags(
            "temperature-model",
            tempModelFlags,
            parseUnitIntervalTemperature,
            "model=<number between 0 and 1>",
        );
        if (!parsedTemperatures.ok) {
            process.stderr.write(`${parsedTemperatures.error.message}\n`);
            return 2;
        }
        modelTemperatures = parsedTemperatures.value;
    }

    if (modelInputs.length < 2) {
        process.stderr.write("Error: at least two models are required\n");
        return 2;
    }

    let config: Awaited<ReturnType<typeof loadConfig>>;
    try {
        config = await loadConfigFn();
        await configureLoggingFn(config.log_level);
    } catch (e) {
        process.stderr.write(`Error: Failed to load config: ${redactSecrets(getErrorMessage(e))}\n`);
        return 1;
    }

    const configDir = getConfigPathsFn().baseDir;
    const catalog = await loadCatalogFn({
        configDir,
        fetchFn,
        reader: makeLocalFileReader(configDir),
        writer: makeLocalFileWriter(configDir),
    });

    if (!catalog.ok) {
        brokerError("catalog_unavailable", catalog.error.message);
        return 1;
    }

    const configuredProviders = new Set(providerIdValues.filter((id) => isProviderConfiguredFn(id, config)));

    const routeOptions = {
        catalog,
        configuredProviders,
    };

    const resolved: BrokerModelInfo[] = [];
    for (const input of modelInputs) {
        const r = resolveOne(input, routeOptions, classifyInputFn, resolveRouteFn);
        if (!r.ok) {
            return 3;
        }
        resolved.push(r.value);
    }

    const selectedRouteIds = new Set<string>();
    const duplicateRouteIds: string[] = [];
    for (const info of resolved) {
        if (selectedRouteIds.has(info.route_id)) {
            if (!duplicateRouteIds.includes(info.route_id)) {
                duplicateRouteIds.push(info.route_id);
            }
        } else {
            selectedRouteIds.add(info.route_id);
        }
    }
    if (selectedRouteIds.size !== resolved.length) {
        process.stderr.write(`Error: duplicate participant model(s): ${duplicateRouteIds.join(", ")}\n`);
        return 2;
    }

    const activeSelectors = new Set([
        ...Object.keys(modelStances),
        ...Object.keys(modelThinkingModes),
        ...Object.keys(modelTemperatures),
    ]);
    const selectorRoutes = new Map<string, string>();
    for (const selector of activeSelectors) {
        const resolution = resolveOne(selector, routeOptions, classifyInputFn, resolveRouteFn);
        if (!resolution.ok) {
            return 3;
        }
        selectorRoutes.set(selector, resolution.value.route_id);
    }

    for (const [selector, routeId] of selectorRoutes) {
        if (!selectedRouteIds.has(routeId)) {
            process.stderr.write(
                `Error: per-model selector '${selector}' resolves to '${routeId}', which is not a selected participant\n`,
            );
            return 2;
        }
    }

    const normalizedStances = normalizeModelOptionMap("stance", modelStances, selectorRoutes);
    if (!normalizedStances.ok) {
        process.stderr.write(`${normalizedStances.error.message}\n`);
        return 2;
    }
    modelStances = normalizedStances.value;

    const normalizedThinkingModes = normalizeModelOptionMap("thinking mode", modelThinkingModes, selectorRoutes);
    if (!normalizedThinkingModes.ok) {
        process.stderr.write(`${normalizedThinkingModes.error.message}\n`);
        return 2;
    }
    modelThinkingModes = normalizedThinkingModes.value;

    for (const info of resolved) {
        if (
            modelThinkingModes[info.route_id] !== undefined &&
            info.provider !== "anthropic" &&
            info.provider !== "openrouter"
        ) {
            process.stderr.write(
                `Warning: --thinking-mode is ignored for provider '${info.provider}' (${info.route_id}); only 'anthropic' and 'openrouter' support thinking modes.\n`,
            );
        }
    }

    const normalizedTemperatures = normalizeModelOptionMap("temperature", modelTemperatures, selectorRoutes);
    if (!normalizedTemperatures.ok) {
        process.stderr.write(`${normalizedTemperatures.error.message}\n`);
        return 2;
    }
    modelTemperatures = normalizedTemperatures.value;

    let resolvedSynthesisRouteId: string | undefined;
    let unresolvedSynthesisError: ParticipantError | null = null;
    if (synthesisModel) {
        const classifiedSynth = classifyInputFn(synthesisModel);
        const synthResult = resolveRouteFn(classifiedSynth, routeOptions);
        if (synthResult.ok) {
            resolvedSynthesisRouteId = synthResult.value.route_id;
        } else {
            unresolvedSynthesisError = {
                code: "synthesis_model_unresolved",
                message: synthResult.error.message,
                retryable: false,
            };
            process.stderr.write(
                `Warning: synthesis model could not be resolved (${synthesisModel}); synthesis will be skipped.\n`,
            );
        }
    }

    if (relevantFiles.length > 0) {
        process.stderr.write(
            "Warning: --files embeds local file contents in prompts sent to configured model providers.\n",
        );
    }

    const participantContextWindows = resolved.map((info) => info.context_window).filter((w) => w !== undefined);
    const modelContextWindow =
        participantContextWindows.length > 0 ? Math.min(...participantContextWindows) : undefined;

    const models = resolved.map((info) => ({
        model_id: info.route_id,
        stance: modelStances[info.route_id],
        temperature: modelTemperatures[info.route_id],
        thinking_mode: modelThinkingModes[info.route_id],
    }));

    let result: Awaited<ReturnType<typeof runConsensus>>;
    const abortController = new AbortController();
    let receivedSignal: "SIGINT" | "SIGTERM" | null = null;
    const onSigint = () => {
        receivedSignal ??= "SIGINT";
        abortController.abort();
    };
    const onSigterm = () => {
        receivedSignal ??= "SIGTERM";
        abortController.abort();
    };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    const cliTimeoutMs = clampTimeoutMs(config.cli_timeout_ms, DEFAULT_CLI_TIMEOUT_MS);
    const cliTimeout = setTimeout(() => abortController.abort(), cliTimeoutMs);
    try {
        result = await runConsensusFn({
            providerRegistry: createProviderRegistryFn(config),
            catalog,
            configuredProviders,
            models,
            findings,
            step,
            parallel: !sequential,
            abortSignal: abortController.signal,
            maxConcurrency: config.max_concurrent_processes,
            temperature: globalTemperature,
            synthesisModel: resolvedSynthesisRouteId,
            relevantFiles,
            modelContextWindow,
        });
    } catch (e) {
        if (receivedSignal !== null) {
            return receivedSignal === "SIGINT" ? 130 : 143;
        }
        brokerError("broker_error", getErrorMessage(e));
        return 1;
    } finally {
        clearTimeout(cliTimeout);
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
    }

    if (receivedSignal !== null) {
        return receivedSignal === "SIGINT" ? 130 : 143;
    }

    if (!result.ok) {
        brokerError("broker_error", result.errors.join("; "));
        return 1;
    }

    const output: CliConsensusResponse = unresolvedSynthesisError
        ? {
              ...result,
              synthesis: null,
              synthesis_error: unresolvedSynthesisError,
          }
        : result;

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
};

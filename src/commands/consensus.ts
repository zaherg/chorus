import minimist from "minimist";
import { z } from "zod/v4";

import { getConfigPaths, loadConfig } from "@/config";
import { runConsensus } from "@/consensus";
import { makeLocalFileReader, makeLocalFileWriter } from "@/providers/cache-fs";
import { loadCatalog } from "@/providers/model-catalog";
import { createProviderRegistry, isProviderConfigured } from "@/providers/registry";
import { classifyInput, type ResolveRouteOptions, resolveRoute } from "@/providers/resolve-route";
import type { ParticipantError, Stance } from "@/types/consensus";
import { type BrokerModelInfo, providerIdValues } from "@/types/providers";
import type { Result, ToolError } from "@/types/tools";
import { getErrorMessage } from "@/utils/helpers";
import { configureLogging } from "@/utils/logger";
import { validateKnownBooleanTokens } from "./boolean-options";

const THINKING_MODE_VALUES = ["minimal", "low", "medium", "high", "max"] as const;
type ThinkingMode = (typeof THINKING_MODE_VALUES)[number];

const SCHEMA_JSON = {
    schema: "cli.consensus/2",
    ok: "boolean",
    models: [
        {
            route_id: "string (e.g. openrouter/openai/gpt-5.2)",
            provider: "string (e.g. openrouter)",
            provider_model_id: "string",
            response: "string | null",
            stance: "for | against | neutral | null",
            error: "{ code: 'provider_request_failed', message: string, retryable: boolean } | null",
        },
    ],
    synthesis: "string | null",
    synthesis_error:
        "{ code: 'provider_request_failed' | 'synthesis_model_unresolved', message: string, retryable: boolean } | null",
    embeddedFiles: {
        embedded_files: "string[]",
        embedded_text: "string",
        skipped_files: "string[]",
        total_tokens: "number",
    },
};

const StdinConsensusSchema = z.object({
    models: z.array(z.string().min(1)).min(1),
    prompt: z.string().min(1),
    findings: z.string().optional(),
    step: z.string().optional(),
    stances: z.record(z.string(), z.enum(["for", "against", "neutral"])).optional(),
    thinking_modes: z.record(z.string(), z.enum(THINKING_MODE_VALUES)).optional(),
    temperatures: z.record(z.string(), z.number().min(0).max(1)).optional(),
    temperature: z.number().min(0).max(1).optional(),
    files: z.array(z.string()).optional(),
    synthesis_model: z.string().optional(),
});

const CONSENSUS_BOOLEAN_OPTIONS = ["sequential", "stdin-json", "schema"] as const;

const ConsensusMinimistSchema = z
    .object({
        _: z.array(z.string()),
        "--": z.array(z.string()),
        models: z.union([z.string(), z.array(z.string())]).optional(),
        prompt: z.union([z.string(), z.array(z.string())]).optional(),
        temperature: z.union([z.string(), z.array(z.string())]).optional(),
        "synthesis-model": z.union([z.string(), z.array(z.string())]).optional(),
        files: z.union([z.string(), z.array(z.string())]).optional(),
        stance: z.union([z.string(), z.array(z.string())]).optional(),
        "thinking-mode": z.union([z.string(), z.array(z.string())]).optional(),
        "temperature-model": z.union([z.string(), z.array(z.string())]).optional(),
        sequential: z.boolean(),
        "stdin-json": z.boolean(),
        schema: z.boolean(),
    })
    .strict();

type ConsensusScalarValue = string | string[] | undefined;

export type ParsedConsensusArgs = {
    models: string | undefined;
    prompt: string | undefined;
    temperature: string | undefined;
    synthesisModel: string | undefined;
    files: string | undefined;
    stance: string[];
    thinkingMode: string[];
    temperatureModel: string[];
    sequential: boolean;
    stdinJson: boolean;
    schema: boolean;
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

const normalizeConsensusScalar = (
    option: string,
    value: ConsensusScalarValue,
): Result<string | undefined, ToolError> => {
    if (Array.isArray(value)) {
        return consensusArgumentError(`Error: --${option} may only be specified once`);
    }
    if (value === "") {
        return consensusArgumentError(`Error: --${option} requires a value`);
    }
    return { ok: true, value };
};

const normalizeRepeatableOption = (value: string | string[] | undefined): string[] => {
    if (value === undefined) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
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
    const booleanSyntax = validateKnownBooleanTokens(args, CONSENSUS_BOOLEAN_OPTIONS);
    if (!booleanSyntax.ok) {
        const message = booleanSyntax.option.startsWith("--no-")
            ? `Error: ${booleanSyntax.option} does not accept an assigned value`
            : `Error: ${booleanSyntax.option} must be true or false`;
        return consensusArgumentError(message, { token: booleanSyntax.token });
    }

    const unknownOptions: string[] = [];
    const raw: unknown = minimist(args, {
        string: [
            "_",
            "models",
            "prompt",
            "temperature",
            "synthesis-model",
            "files",
            "stance",
            "thinking-mode",
            "temperature-model",
        ],
        boolean: [...CONSENSUS_BOOLEAN_OPTIONS],
        "--": true,
        unknown: (token: string) => {
            if (token.startsWith("-")) {
                unknownOptions.push(token);
                return false;
            }
            return true;
        },
    });
    const rawValidation = ConsensusMinimistSchema.safeParse(raw);
    if (!rawValidation.success) {
        return consensusArgumentError("Error: invalid arguments", rawValidation.error.issues);
    }
    if (unknownOptions.length > 0) {
        return consensusArgumentError(`Error: unknown option ${unknownOptions[0]}`);
    }

    const parsed = rawValidation.data;
    if (parsed._.length > 0) {
        return consensusArgumentError(`Error: unexpected argument ${parsed._[0]}`);
    }
    if (booleanSyntax.separatorPresent || parsed["--"].length > 0) {
        return consensusArgumentError("Error: arguments after -- are not supported");
    }

    const models = normalizeConsensusScalar("models", parsed.models);
    if (!models.ok) {
        return models;
    }
    const prompt = normalizeConsensusScalar("prompt", parsed.prompt);
    if (!prompt.ok) {
        return prompt;
    }
    const temperature = normalizeConsensusScalar("temperature", parsed.temperature);
    if (!temperature.ok) {
        return temperature;
    }
    const synthesisModel = normalizeConsensusScalar("synthesis-model", parsed["synthesis-model"]);
    if (!synthesisModel.ok) {
        return synthesisModel;
    }
    const files = normalizeConsensusScalar("files", parsed.files);
    if (!files.ok) {
        return files;
    }

    return {
        ok: true,
        value: {
            models: models.value,
            prompt: prompt.value,
            temperature: temperature.value,
            synthesisModel: synthesisModel.value,
            files: files.value,
            stance: normalizeRepeatableOption(parsed.stance),
            thinkingMode: normalizeRepeatableOption(parsed["thinking-mode"]),
            temperatureModel: normalizeRepeatableOption(parsed["temperature-model"]),
            sequential: parsed.sequential,
            stdinJson: parsed["stdin-json"],
            schema: parsed.schema,
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

const printError = (payload: object) => {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
};

const brokerError = (code: string, message: string, extra?: object) => {
    printError({
        ok: false,
        schema: "cli.consensus.error/1",
        error: { code, message, ...(extra ?? {}) },
    });
};

const resolveOne = async (
    input: string,
    options: ResolveRouteOptions,
): Promise<{ ok: true; value: BrokerModelInfo } | { ok: false; handled: boolean }> => {
    const classified = classifyInput(input);
    const result = await resolveRoute(classified, options);
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

export const runConsensusCommand = async (args: string[]) => {
    const parsed = parseConsensusArgs(args);
    if (!parsed.ok) {
        process.stderr.write(`${parsed.error.message}\n`);
        return 2;
    }

    const {
        files: filesStr,
        models: modelsStr,
        prompt,
        schema,
        sequential,
        stance: stanceFlags,
        stdinJson,
        synthesisModel: synthesisModelFlag,
        temperature: temperatureStr,
        temperatureModel: tempModelFlags,
        thinkingMode: thinkingModeFlags,
    } = parsed.value;

    if (schema) {
        process.stdout.write(`${JSON.stringify(SCHEMA_JSON, null, 2)}\n`);
        return 0;
    }

    let modelInputs: string[];
    let promptText: string;
    let findings: string;
    let step: string;
    let modelStances: Record<string, Stance> = {};
    let modelThinkingModes: Record<string, ThinkingMode> = {};
    let modelTemperatures: Record<string, number> = {};
    let globalTemperature: number | undefined;
    let relevantFiles: string[] = [];
    let synthesisModel = synthesisModelFlag;

    if (stdinJson) {
        let stdinText: string;
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of process.stdin) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            stdinText = Buffer.concat(chunks).toString("utf8");
        } catch (e) {
            process.stderr.write(`Error: Failed to read --stdin-json input: ${getErrorMessage(e)}\n`);
            return 1;
        }

        let parsed: z.infer<typeof StdinConsensusSchema>;
        try {
            parsed = StdinConsensusSchema.parse(JSON.parse(stdinText));
        } catch (e) {
            process.stderr.write(`Error: Invalid --stdin-json input: ${getErrorMessage(e)}\n`);
            return 2;
        }
        modelInputs = parsed.models;
        promptText = parsed.prompt;
        findings = parsed.findings ?? promptText;
        step = parsed.step ?? promptText;
        if (parsed.stances) modelStances = parsed.stances;
        if (parsed.thinking_modes) modelThinkingModes = parsed.thinking_modes;
        if (parsed.temperatures) modelTemperatures = parsed.temperatures;
        globalTemperature = parsed.temperature;
        relevantFiles = parsed.files ?? [];
        synthesisModel = parsed.synthesis_model ?? synthesisModel;
    } else {
        if (!modelsStr) {
            process.stderr.write("Error: --models is required (comma-separated route_ids or provider-native IDs)\n");
            return 2;
        }
        modelInputs = modelsStr
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        if (!prompt) {
            process.stderr.write("Error: --prompt is required (or use --stdin-json)\n");
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
            (value): Stance | undefined =>
                ["for", "against", "neutral"].includes(value) ? (value as Stance) : undefined,
            "model=for|against|neutral",
        );
        if (!parsedStances.ok) {
            process.stderr.write(`${parsedStances.error.message}\n`);
            return 2;
        }
        modelStances = parsedStances.value;

        const parsedThinkingModes = parseModelKeyValueFlags(
            "thinking-mode",
            thinkingModeFlags,
            (value): ThinkingMode | undefined =>
                THINKING_MODE_VALUES.includes(value as ThinkingMode) ? (value as ThinkingMode) : undefined,
            "model=minimal|low|medium|high|max",
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
        config = await loadConfig();
        await configureLogging(config.log_level);
    } catch (e) {
        process.stderr.write(`Error: Failed to load config: ${getErrorMessage(e)}\n`);
        return 1;
    }

    const configDir = getConfigPaths().baseDir;
    const catalog = await loadCatalog({
        configDir,
        fetchFn: globalThis.fetch,
        reader: makeLocalFileReader(configDir),
        writer: makeLocalFileWriter(configDir),
    });

    if (!catalog.ok) {
        brokerError("catalog_unavailable", catalog.error.message);
        return 1;
    }

    const configuredProviders = new Set(providerIdValues.filter((id) => isProviderConfigured(id, config)));

    const routeOptions = {
        catalog,
        configuredProviders,
    };

    const resolved: BrokerModelInfo[] = [];
    for (const input of modelInputs) {
        const r = await resolveOne(input, routeOptions);
        if (!r.ok) {
            return 3;
        }
        resolved.push(r.value);
    }

    const selectedRouteIds = new Set(resolved.map((info) => info.route_id));
    const activeSelectors = new Set([
        ...Object.keys(modelStances),
        ...Object.keys(modelThinkingModes),
        ...Object.keys(modelTemperatures),
    ]);
    const selectorRoutes = new Map<string, string>();
    for (const selector of activeSelectors) {
        const resolution = await resolveOne(selector, routeOptions);
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

    const normalizedTemperatures = normalizeModelOptionMap("temperature", modelTemperatures, selectorRoutes);
    if (!normalizedTemperatures.ok) {
        process.stderr.write(`${normalizedTemperatures.error.message}\n`);
        return 2;
    }
    modelTemperatures = normalizedTemperatures.value;

    let resolvedSynthesisRouteId: string | undefined;
    let unresolvedSynthesisError: ParticipantError | null = null;
    if (synthesisModel) {
        const classifiedSynth = classifyInput(synthesisModel);
        const synthResult = await resolveRoute(classifiedSynth, routeOptions);
        if (synthResult.ok) {
            resolvedSynthesisRouteId = synthResult.value.route_id;
        } else {
            unresolvedSynthesisError = {
                code: "synthesis_model_unresolved",
                message: synthResult.error.message,
                retryable: false,
            };
            process.stderr.write(
                `Warning: --synthesis-model could not be resolved (${synthesisModel}); synthesis will be skipped.\n`,
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
    const onSignal = () => {
        abortController.abort();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    const cliTimeout = setTimeout(() => abortController.abort(), config.cli_timeout_ms);
    try {
        result = await runConsensus({
            providerRegistry: createProviderRegistry(config),
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
        brokerError("broker_error", getErrorMessage(e));
        return 1;
    } finally {
        clearTimeout(cliTimeout);
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
    }

    if (!result.ok) {
        brokerError("broker_error", result.errors.join("; "));
        return 1;
    }

    const output = unresolvedSynthesisError
        ? {
              ...result,
              synthesis: null,
              synthesis_error: unresolvedSynthesisError,
          }
        : result;

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
};

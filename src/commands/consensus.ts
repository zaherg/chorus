import { z } from "zod/v4";

import { getConfigPaths, loadConfig } from "@/config";
import { runConsensus } from "@/consensus";
import { makeLocalFileReader, makeLocalFileWriter } from "@/providers/cache-fs";
import { loadCatalog } from "@/providers/model-catalog";
import {
    createProviderRegistry,
    isProviderConfigured,
} from "@/providers/registry";
import {
    classifyInput,
    type ResolveRouteOptions,
    resolveRoute,
} from "@/providers/resolve-route";
import type {
    ConsensusModelConfig,
    ParticipantError,
    Stance,
} from "@/types/consensus";
import {
    type BrokerModelInfo,
    type ProviderId,
    providerIdValues,
} from "@/types/providers";
import { getErrorMessage } from "@/utils";
import { configureLogging } from "@/utils/logger";

const THINKING_MODE_VALUES = [
    "minimal",
    "low",
    "medium",
    "high",
    "max",
] as const;
type ThinkingMode = (typeof THINKING_MODE_VALUES)[number];

const SCHEMA_JSON = {
    schema: "cli.consensus/2",
    ok: "boolean",
    models: [
        {
            route_id: "string (e.g. openai/gpt-5.2)",
            provider: "string (e.g. openai)",
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
    stances: z
        .record(z.string(), z.enum(["for", "against", "neutral"]))
        .optional(),
    thinking_modes: z
        .record(z.string(), z.enum(THINKING_MODE_VALUES))
        .optional(),
    temperatures: z.record(z.string(), z.number().min(0).max(1)).optional(),
    temperature: z.number().min(0).max(1).optional(),
    files: z.array(z.string()).optional(),
    synthesis_model: z.string().optional(),
});

const parseModelKeyValueFlags = <T>(
    flags: string[],
    validate: (raw: string) => T | undefined,
): Record<string, T> => {
    const result: Record<string, T> = {};
    for (const f of flags) {
        const eqIdx = f.indexOf("=");
        if (eqIdx > 0) {
            const model = f.slice(0, eqIdx);
            const value = f.slice(eqIdx + 1);
            const validated = validate(value);
            if (validated !== undefined) result[model] = validated;
        }
    }
    return result;
};

const parseRepeatableFlag = (args: string[], flagName: string): string[] => {
    const results: string[] = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === flagName && i + 1 < args.length) {
            results.push(args[i + 1]);
            i++;
        }
    }
    return results;
};

const parseSingleFlag = (
    args: string[],
    flagName: string,
): string | undefined => {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === flagName && i + 1 < args.length) {
            return args[i + 1];
        }
    }
    return undefined;
};

const parseBooleanFlag = (args: string[], flagName: string): boolean => {
    return args.includes(flagName);
};

const printError = (payload: object): void => {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
};

const brokerError = (code: string, message: string, extra?: object): void => {
    printError({
        ok: false,
        schema: "cli.consensus.error/1",
        error: { code, message, ...(extra ?? {}) },
    });
};

const resolveOne = async (
    input: string,
    options: ResolveRouteOptions,
): Promise<
    { ok: true; value: BrokerModelInfo } | { ok: false; handled: boolean }
> => {
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

export const runConsensusCommand = async (args: string[]): Promise<number> => {
    if (parseBooleanFlag(args, "--schema")) {
        process.stdout.write(`${JSON.stringify(SCHEMA_JSON, null, 2)}\n`);
        return 0;
    }

    const modelsStr = parseSingleFlag(args, "--models");
    const prompt = parseSingleFlag(args, "--prompt");
    const stdinJson = parseBooleanFlag(args, "--stdin-json");
    const temperatureStr = parseSingleFlag(args, "--temperature");
    const synthesisModelFlag = parseSingleFlag(args, "--synthesis-model");
    const sequential = parseBooleanFlag(args, "--sequential");
    const filesStr = parseSingleFlag(args, "--files");
    const stanceFlags = parseRepeatableFlag(args, "--stance");
    const thinkingModeFlags = parseRepeatableFlag(args, "--thinking-mode");
    const tempModelFlags = parseRepeatableFlag(args, "--temperature-model");

    let modelInputs: string[];
    let promptText: string;
    let findings: string;
    let step: string;
    let modelStances: Record<string, Stance> = {};
    let modelThinkingModes: Record<string, ThinkingMode> = {};
    let modelTemperatures: Record<string, number> = {};
    let globalTemperature: number | undefined;
    let relevantFiles: string[] = [];
    let synthesisModel: string | undefined = synthesisModelFlag;

    if (stdinJson) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
            chunks.push(chunk as Buffer);
        }
        const stdinText = Buffer.concat(chunks).toString("utf8");
        let parsed: z.infer<typeof StdinConsensusSchema>;
        try {
            parsed = StdinConsensusSchema.parse(JSON.parse(stdinText));
        } catch (e) {
            process.stderr.write(
                `Error: Invalid --stdin-json input: ${getErrorMessage(e)}\n`,
            );
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
            process.stderr.write(
                "Error: --models is required (comma-separated route_ids or provider-native IDs)\n",
            );
            return 2;
        }
        modelInputs = modelsStr
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        if (!prompt) {
            process.stderr.write(
                "Error: --prompt is required (or use --stdin-json)\n",
            );
            return 2;
        }
        promptText = prompt;
        findings = prompt;
        step = prompt;

        if (temperatureStr) {
            const t = parseFloat(temperatureStr);
            if (Number.isNaN(t) || t < 0 || t > 1) {
                process.stderr.write(
                    "Error: --temperature must be a number between 0 and 1\n",
                );
                return 2;
            }
            globalTemperature = t;
        }

        if (filesStr) {
            relevantFiles = filesStr
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        }

        modelStances = parseModelKeyValueFlags(stanceFlags, (v) =>
            ["for", "against", "neutral"].includes(v)
                ? (v as Stance)
                : undefined,
        );

        modelThinkingModes = parseModelKeyValueFlags(thinkingModeFlags, (v) =>
            THINKING_MODE_VALUES.includes(v as ThinkingMode)
                ? (v as ThinkingMode)
                : undefined,
        );

        modelTemperatures = parseModelKeyValueFlags(tempModelFlags, (v) => {
            const t = parseFloat(v);
            return !Number.isNaN(t) && t >= 0 && t <= 1 ? t : undefined;
        });
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
        process.stderr.write(
            `Error: Failed to load config: ${getErrorMessage(e)}\n`,
        );
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

    const configuredProviders = new Set<ProviderId>(
        providerIdValues.filter((id) => isProviderConfigured(id, config)),
    );

    const routeOptions: ResolveRouteOptions = {
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

    const models: ConsensusModelConfig[] = resolved.map((info) => ({
        model: info.route_id,
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
    const cliTimeout = setTimeout(
        () => abortController.abort(),
        config.cli_timeout_ms,
    );
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

import { CONSENSUS_SYSTEM_PROMPT } from "@/prompts/consensus";
import type {
    ConsensusError,
    ConsensusModelConfig,
    ConsensusRequest,
    ConsensusResult,
    ParticipantResponse,
} from "@/types/consensus";
import type { EmbeddedFileResult } from "@/utils/files";
import { embedFiles } from "@/utils/files";
import { getErrorMessage } from "@/utils/helpers";
import { logger } from "@/utils/logger";
import { buildConsensusPrompt, buildSynthesisPrompt } from "@/utils/prompts";

const EMPTY_EMBEDDED: EmbeddedFileResult = {
    embedded_files: [],
    embedded_text: "",
    skipped_files: [],
    total_tokens: 0,
};

const queryModel = async ({
    modelConfig,
    request,
    fileText,
    priorResponses,
}: {
    modelConfig: ConsensusModelConfig;
    request: ConsensusRequest;
    fileText: string;
    priorResponses?: ParticipantResponse[];
}): Promise<ParticipantResponse> => {
    const modelId = modelConfig.model;
    const stance = modelConfig.stance ?? "neutral";
    const modelInfo = await request.providerRegistry.getModelInfo(modelId, {
        catalog: request.catalog,
        configuredProviders: request.configuredProviders,
    });
    if (!modelInfo) {
        return {
            route_id: modelId,
            provider: "unknown",
            provider_model_id: modelId,
            response: null,
            stance: null,
            error: {
                code: "provider_request_failed",
                message: `Unknown model: ${modelId}`,
                retryable: false,
            },
        };
    }

    const prompt = buildConsensusPrompt({
        step: request.step,
        findings: request.findings,
        stance,
        fileText,
        priorResponses,
    });
    const temperature = modelConfig.temperature ?? request.temperature;
    const result = await request.providerRegistry.generateText(modelInfo.route_id, prompt, CONSENSUS_SYSTEM_PROMPT, {
        abortSignal: request.abortSignal,
        catalog: request.catalog,
        configuredProviders: request.configuredProviders,
        temperature,
        thinkingMode: modelConfig.thinking_mode,
    });

    if (!result.ok) {
        return {
            route_id: modelId,
            provider: modelInfo.provider,
            provider_model_id: modelInfo.provider_model_id,
            response: null,
            stance: null,
            error: {
                code: "provider_request_failed",
                message: result.error.message,
                retryable: result.error.retryable,
            },
        };
    }

    return {
        route_id: modelId,
        provider: result.value.provider,
        provider_model_id: modelInfo.provider_model_id,
        response: result.value.text,
        stance,
        error: null,
    };
};

const runSettledWithConcurrency = async <T, R>(
    items: T[],
    maxConcurrency: number,
    worker: (item: T, index: number) => Promise<R>,
) => {
    const limit = Math.max(1, Math.min(items.length, maxConcurrency ?? 1));
    const results = new Array<PromiseSettledResult<R>>(items.length);
    let nextIndex = 0;

    const runner = async () => {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex++;
            try {
                results[index] = {
                    status: "fulfilled",
                    value: await worker(items[index], index),
                };
            } catch (reason) {
                results[index] = { status: "rejected", reason };
            }
        }
    };

    await Promise.all(Array.from({ length: limit }, () => runner()));
    return results;
};

const failedParticipant = (modelId: string, reason: unknown): ParticipantResponse => {
    // Inspect the error to decide retryability.
    // Abort/timeout errors are retryable (transient).
    // Structured errors with an explicit retryable field are honoured.
    // Everything else defaults to retryable since most runtime
    // exceptions (network, rate-limit) are also transient.
    let retryable = true;
    if (reason === "Aborted") {
        retryable = false;
    } else if (reason instanceof Error) {
        const name = reason.name;
        if (name === "AbortError" || name === "TimeoutError") {
            retryable = true;
        } else if ("retryable" in reason && typeof (reason as Record<string, unknown>).retryable === "boolean") {
            retryable = (reason as Record<string, unknown>).retryable as boolean;
        }
    } else if (reason !== null && typeof reason === "object" && "retryable" in reason) {
        const val = (reason as Record<string, unknown>).retryable;
        if (typeof val === "boolean") {
            retryable = val;
        }
    }

    return {
        route_id: modelId,
        provider: "unknown",
        provider_model_id: modelId,
        response: null,
        stance: null,
        error: {
            code: "provider_request_failed",
            message: getErrorMessage(reason),
            retryable,
        },
    };
};

export const runConsensus = async (request: ConsensusRequest): Promise<ConsensusResult | ConsensusError> => {
    if (request.models.length === 0) {
        return {
            ok: false,
            errors: ["At least one model is required for consensus"],
        };
    }

    const embeddedFiles = request.relevantFiles?.length
        ? await embedFiles(request.relevantFiles, request.modelContextWindow)
        : EMPTY_EMBEDDED;

    const useParallel = request.parallel !== false;
    const participantResponses: ParticipantResponse[] = [];

    if (useParallel) {
        const results = await runSettledWithConcurrency(
            request.models,
            request.maxConcurrency ?? request.models.length,
            (modelConfig) =>
                queryModel({
                    modelConfig,
                    request,
                    fileText: embeddedFiles.embedded_text,
                }),
        );
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === "fulfilled") {
                participantResponses.push(r.value);
            } else {
                participantResponses.push(failedParticipant(request.models[i].model, r.reason));
            }
        }
    } else {
        for (const modelConfig of request.models) {
            // Check abort signal between sequential iterations so a
            // cancelled consensus run does not fire every remaining
            // model call.
            if (request.abortSignal?.aborted) {
                participantResponses.push(failedParticipant(modelConfig.model, "Aborted"));
                continue;
            }

            const priorResponses = participantResponses.length > 0 ? participantResponses : undefined;
            try {
                const response = await queryModel({
                    modelConfig,
                    request,
                    fileText: embeddedFiles.embedded_text,
                    priorResponses,
                });
                if (response.error) {
                    logger?.warn(`Model ${modelConfig.model} failed: ${response.error.message}`);
                }
                participantResponses.push(response);
            } catch (e) {
                participantResponses.push(failedParticipant(modelConfig.model, e));
            }
        }
    }

    // All paths always populate participantResponses: runSettledWithConcurrency
    // produces exactly items.length results, and the sequential loop always pushes.
    // The earlier models.length === 0 guard prevents empty request.models.
    const successCount = participantResponses.filter((r) => r.response !== null).length;
    if (successCount === 0) {
        const details = participantResponses.map((r) =>
            r.error ? `${r.route_id}: ${r.error.message}` : `${r.route_id}: unknown failure`,
        );
        return {
            ok: false,
            errors: [`All participant model calls failed: ${participantResponses.length} attempted`, ...details],
        };
    }

    let synthesis: string | null = null;
    let synthesisError: ParticipantResponse["error"] = null;

    if (request.synthesisModel) {
        const synthesisRouteId = request.synthesisModel;
        const synthesisInfo = await request.providerRegistry.getModelInfo(synthesisRouteId, {
            catalog: request.catalog,
            configuredProviders: request.configuredProviders,
        });
        if (!synthesisInfo) {
            synthesisError = {
                code: "provider_request_failed",
                message: `Unknown synthesis model: ${synthesisRouteId}`,
                retryable: false,
            };
        } else {
            const successfulResponses = participantResponses.filter((r) => r.response !== null);
            const synthesisPrompt = buildSynthesisPrompt({
                step: request.step,
                findings: request.findings,
                successfulResponses,
                fileText: embeddedFiles.embedded_text,
            });
            const synthesisResult = await request.providerRegistry.generateText(
                synthesisInfo.route_id,
                synthesisPrompt,
                CONSENSUS_SYSTEM_PROMPT,
                {
                    abortSignal: request.abortSignal,
                    catalog: request.catalog,
                    configuredProviders: request.configuredProviders,
                    temperature: request.temperature,
                },
            );
            if (!synthesisResult.ok) {
                synthesisError = {
                    code: "provider_request_failed",
                    message: synthesisResult.error.message,
                    retryable: synthesisResult.error.retryable ?? true,
                };
            } else {
                synthesis = synthesisResult.value.text;
            }
        }
    }

    return {
        ok: true,
        schema: "cli.consensus/2",
        models: participantResponses,
        synthesis,
        synthesis_error: synthesisError,
        embeddedFiles,
    };
};

import { CONSENSUS_SYSTEM_PROMPT } from "@/prompts/consensus";
import type {
    ConsensusError,
    ConsensusModelConfig,
    ConsensusRequest,
    ConsensusResult,
    ParticipantResponse,
} from "@/types/consensus";
import type { EmbeddedFileResult } from "@/types/files";
import { clampPositiveInt, isAbortLikeError } from "@/utils/async";
import { embedFiles } from "@/utils/files";
import { getErrorMessage } from "@/utils/helpers";
import { logger } from "@/utils/logger";
import { buildConsensusPrompt, buildSynthesisPrompt } from "@/utils/prompts";
import { redactSecrets } from "@/utils/redact";

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
    const modelId = modelConfig.model_id;
    const stance = modelConfig.stance;
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
    const result = await request.providerRegistry.generateText(modelInfo.route_id, prompt, CONSENSUS_SYSTEM_PROMPT, {
        abortSignal: request.abortSignal,
        catalog: request.catalog,
        configuredProviders: request.configuredProviders,
        temperature: modelConfig.temperature ?? request.temperature,
        thinkingMode: modelConfig.thinking_mode,
    });

    if (!result.ok) {
        return {
            route_id: modelInfo.route_id,
            provider: modelInfo.provider,
            provider_model_id: modelInfo.provider_model_id,
            response: null,
            stance: null,
            error: {
                code: "provider_request_failed",
                message: redactSecrets(result.error.message),
                retryable: result.error.retryable,
            },
        };
    }

    return {
        route_id: modelInfo.route_id,
        provider: result.value.provider,
        provider_model_id: modelInfo.provider_model_id,
        response: result.value.text,
        stance: stance ?? null,
        error: null,
    };
};

/**
 * Executes `worker` for each item with bounded concurrency and returns all outcomes.
 *
 * The function runs up to `maxConcurrency` workers in parallel while preserving
 * the input ordering in the returned results array. The concurrency is clamped to
 * at least 1 and at most `items.length`.
 *
 * @param items - Input items to process.
 * @param maxConcurrency - Maximum number of concurrent worker executions.
 * @param worker - Async function invoked with `(item, index)`.
 * @returns An array of `PromiseSettledResult<R>` entries in the same order as `items`,
 * with each entry either fulfilled with the worker result or rejected with the thrown reason.
 */
const runSettledWithConcurrency = async <T, R>(
    items: T[],
    maxConcurrency: number,
    worker: (item: T, index: number) => Promise<R>,
) => {
    if (items.length === 0) {
        return [];
    }
    const safeConcurrency = clampPositiveInt(maxConcurrency, 1);
    const limit = Math.min(items.length, safeConcurrency);
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

const isRetryableError = (reason: unknown): boolean => {
    // Inspect the error to decide retryability.
    // Abort/timeout errors are retryable (transient).
    // Structured errors with an explicit retryable field are honoured.
    // Everything else defaults to retryable since most runtime
    // exceptions (network, rate-limit) are also transient.
    if (reason === "Aborted") {
        return false;
    }
    if (isAbortLikeError(reason)) {
        return true;
    }
    if (reason !== null && typeof reason === "object" && "retryable" in reason) {
        const val = (reason as Record<string, unknown>).retryable;
        if (typeof val === "boolean") {
            return val;
        }
    }
    return true;
};

const failedParticipant = (modelId: string, reason: unknown): ParticipantResponse => ({
    route_id: modelId,
    provider: "unknown",
    provider_model_id: modelId,
    response: null,
    stance: null,
    error: {
        code: "provider_request_failed",
        message: redactSecrets(getErrorMessage(reason)),
        retryable: isRetryableError(reason),
    },
});

/**
 * Runs consensus across configured models and optionally synthesizes the combined result.
 *
 * - Returns an early validation failure if no models are provided.
 * - Optionally embeds relevant files once and reuses the embedded text for every model query.
 * - In parallel mode, dispatches model queries with bounded concurrency and records each
 *   success or failure as a `ParticipantResponse`.
 * - In sequential mode, queries models one by one, checks abort state between iterations,
 *   and forwards prior successful responses into each subsequent request.
 * - Fails with `ok: false` when all participant calls fail.
 * - If a synthesis model is configured, it resolves that route and requests a synthesis
 *   response from successful participant outputs.
 *
 * @param request Consensus request parameters, including model list, execution mode, provider access, and optional synthesis settings.
 * @returns A `ConsensusResult` on successful orchestration or a `ConsensusError` for terminal failure conditions.
 */
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
                participantResponses.push(failedParticipant(request.models[i].model_id, r.reason));
            }
        }
    } else {
        for (const modelConfig of request.models) {
            // Check abort signal between sequential iterations so a
            // cancelled consensus run does not fire every remaining
            // model call.
            if (request.abortSignal?.aborted) {
                participantResponses.push(failedParticipant(modelConfig.model_id, "Aborted"));
                continue;
            }

            const successfulPrior = participantResponses.filter((r) => r.response !== null);
            const priorResponses = successfulPrior.length > 0 ? successfulPrior : undefined;
            try {
                const response = await queryModel({
                    modelConfig,
                    request,
                    fileText: embeddedFiles.embedded_text,
                    priorResponses,
                });
                participantResponses.push(response);
            } catch (e) {
                participantResponses.push(failedParticipant(modelConfig.model_id, e));
            }
        }
    }

    for (const participant of participantResponses) {
        if (participant.error) {
            logger?.warn("Consensus participant failed", {
                route_id: participant.route_id,
                code: participant.error.code,
                message: participant.error.message,
                retryable: participant.error.retryable,
            });
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
        if (request.abortSignal?.aborted) {
            synthesisError = {
                code: "provider_request_failed",
                message: "Consensus request aborted before synthesis",
                retryable: false,
            };
        } else {
            try {
                const synthesisInfo = await request.providerRegistry.getModelInfo(synthesisRouteId, {
                    catalog: request.catalog,
                    configuredProviders: request.configuredProviders,
                });
                if (!synthesisInfo) {
                    synthesisError = {
                        code: "synthesis_model_unresolved",
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
                            message: redactSecrets(synthesisResult.error.message),
                            retryable: synthesisResult.error.retryable ?? true,
                        };
                    } else {
                        synthesis = synthesisResult.value.text;
                    }
                }
            } catch (e) {
                synthesisError = {
                    code: "provider_request_failed",
                    message: redactSecrets(getErrorMessage(e)),
                    retryable: isRetryableError(e),
                };
            }
        }
        if (synthesisError) {
            logger?.warn("Consensus synthesis failed", {
                route_id: synthesisRouteId,
                code: synthesisError.code,
                message: synthesisError.message,
                retryable: synthesisError.retryable,
            });
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

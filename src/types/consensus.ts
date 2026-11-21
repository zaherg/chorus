import { z } from "zod";

import type { ProviderRegistry, ThinkingMode } from "@/providers/registry";
import type { EmbeddedFileResult } from "@/types/files";
import { type ModelsListResponse, type ProviderId, ProviderIdSchema } from "@/types/providers";

// === Consensus primitives ===

export const stanceValues = ["for", "against", "neutral"] as const;

export const StanceSchema = z.enum(stanceValues);

/**
 * The position a model takes toward a proposed action in a consensus round.
 * - `"for"`     -- approve / agree
 * - `"against"` -- reject / disagree
 * - `"neutral"` -- abstain or present alternatives without taking a side
 */
export type Stance = z.infer<typeof StanceSchema>;

// === Per-model config & response ===

/** Configuration for a single model participating in a consensus round. */
export interface ConsensusModelConfig {
    /**
     * Executable route ID for the model (e.g. `"openrouter/openai/gpt-5.2"`,
     * `"anthropic/claude-sonnet-4-5"`). Resolved by the broker to a
     * `BrokerModelInfo`; the registry then uses the provider-native model ID.
     */
    model_id: string;
    /**
     * Optional forced stance. When set the model is instructed to argue from
     * this position. When absent the model chooses its stance freely.
     */
    stance?: Stance;
    /** Per-model temperature override. Takes precedence over `ConsensusRequest.temperature`. */
    temperature?: number;
    /** Per-model thinking-mode override. Controls whether extended reasoning is enabled. */
    thinking_mode?: ThinkingMode;
}

/**
 * Structured error from a participant model call.
 *
 * - `code` is a stable machine-readable identifier. `provider_request_failed`
 *   is the only code the broker emits today; future broker-internal codes
 *   (e.g. `participant_timeout`) may be added.
 * - `message` is a human-readable explanation (already secret-redacted).
 * - `retryable` is a hint for the agent; the broker does not retry itself.
 */
export const participantErrorCodeValues = ["provider_request_failed", "synthesis_model_unresolved"] as const;

export const ParticipantErrorSchema = z.object({
    code: z.enum(participantErrorCodeValues),
    message: z.string(),
    retryable: z.boolean(),
});

export interface ParticipantError {
    code: "provider_request_failed" | "synthesis_model_unresolved";
    message: string;
    retryable: boolean;
}

export const SynthesisErrorSchema = ParticipantErrorSchema;

export type SynthesisError = ParticipantError;

export const ParticipantProviderSchema = z.union([ProviderIdSchema, z.literal("unknown")]);

export const ParticipantResponseSchema = z.object({
    route_id: z.string(),
    provider: ParticipantProviderSchema,
    provider_model_id: z.string(),
    response: z.string().nullable(),
    stance: StanceSchema.nullable(),
    error: ParticipantErrorSchema.nullable(),
});

/**
 * A single participant record in the `cli.consensus/2` response.
 *
 * - `response` is the raw text returned by the provider, or `null` when the
 *   participant call failed before producing text.
 * - `error` is `null` for successful calls; otherwise it carries the structured
 *   failure (and `response` is `null`).
 */
export interface ParticipantResponse {
    /** Executable route ID (e.g. `"openrouter/openai/gpt-5.2"`). */
    route_id: string;
    /** Internal provider ID (e.g. `"openrouter"`), or `"unknown"` when unresolved. */
    provider: ProviderId | "unknown";
    /** Provider-native model ID passed to the AI SDK provider. */
    provider_model_id: string;
    /** Raw text response from the model, or `null` when the call failed. */
    response: string | null;
    /** Assigned stance for the participant, or `null` when no stance was assigned or the call failed. */
    stance: Stance | null;
    /** Structured error from the participant call, or `null` on success. */
    error: ParticipantError | null;
}

// === Consensus request (input) ===

/** The input to a consensus round, dispatched to the consensus engine. */
export interface ConsensusRequest {
    /** Runtime provider registry used to resolve model IDs and execute calls. */
    providerRegistry: ProviderRegistry;
    /**
     * Pre-loaded models.dev catalog. The registry uses this to resolve
     * `route_id` and unqualified model inputs via the broker. Required for
     * participant and synthesis calls to reach the AI SDK.
     */
    catalog?: ModelsListResponse;
    /**
     * Set of providers that are configured for the current run. Used by the
     * broker to filter catalog rows and to accept passthrough providers.
     */
    configuredProviders?: ReadonlySet<ProviderId>;
    /** Array of model configurations. One entry per participant. At least one required. */
    models: ConsensusModelConfig[];
    /** Background context / evidence presented to each model (typically a summary of preceding steps). */
    findings: string;
    /** The specific question being put to the models (e.g. "Should we block this API call?"). */
    step: string;
    /** When `true`, query all models concurrently. Default parallel. */
    parallel?: boolean;
    /** Maximum simultaneous model calls when `parallel` is true. Limits resource consumption. */
    maxConcurrency?: number;
    /** Optional abort signal to cancel in-flight model calls. */
    abortSignal?: AbortSignal;
    /** Global temperature applied to all models. Per-model overrides take precedence. */
    temperature?: number;
    /**
     * Executable route ID for the synthesis model. When absent, synthesis is
     * skipped and the broker returns raw participant responses. The broker
     * never auto-picks a synthesis model.
     */
    synthesisModel?: string;
    /** Optional file paths relevant to the consensus context; embedded into each prompt. */
    relevantFiles?: string[];
    /**
     * Context window (tokens) used to size the embedded-file budget, typically
     * the smallest context window among participant models. Defaults to 128k.
     */
    modelContextWindow?: number;
}

// === Consensus result (output) ===

/**
 * Successful broker response. The broker returns this when at least one
 * participant call completed. Failed participant calls are still included in
 * `models` with `response: null` and a structured `error`. `synthesis` is
 * populated only when `ConsensusRequest.synthesisModel` is set and the
 * synthesis call succeeded; `synthesis_error` explains failures.
 */
export interface ConsensusResult {
    /** Discriminant -- always `true` for a successful broker response. */
    ok: true;
    /** JSON Schema identifier for this payload (`"cli.consensus/2"`). */
    schema: "cli.consensus/2";
    /**
     * One entry per requested model. Failed participants keep their
     * `route_id`/`provider`/`provider_model_id` and carry `response: null`
     * plus a structured `error`.
     */
    models: ParticipantResponse[];
    /** Synthesized text, or `null` when synthesis was not requested or failed. */
    synthesis: string | null;
    /** Structured synthesis error, or `null` when synthesis succeeded or was not requested. */
    synthesis_error: ParticipantError | null;
    /** Result of embedding referenced files into prompts. */
    embeddedFiles: EmbeddedFileResult;
}

/**
 * Failed broker response. The broker returns this only when no participant
 * call completed; partial-success runs return a `ConsensusResult` with the
 * successful rows and structured per-row errors.
 */
export interface ConsensusError {
    /** Discriminant -- always `false` for a failure result. */
    ok: false;
    /** Array of error message strings. Non-empty; one entry per failure. */
    errors: string[];
}

// === CLI wire output schemas ===

export const EmbeddedFilesResultSchema = z.object({
    embedded_files: z.array(z.string()),
    embedded_text: z.string(),
    skipped_files: z.array(z.string()),
    total_tokens: z.number(),
});

export type EmbeddedFilesResult = EmbeddedFileResult;

export const CliConsensusResponseSchema = z.object({
    ok: z.literal(true),
    schema: z.literal("cli.consensus/2"),
    models: z.array(ParticipantResponseSchema),
    synthesis: z.string().nullable(),
    synthesis_error: SynthesisErrorSchema.nullable(),
    embeddedFiles: EmbeddedFilesResultSchema,
});

export type CliConsensusResponse = ConsensusResult;

export const cliConsensusErrorCodeValues = [
    "ambiguous_model",
    "unknown_model",
    "catalog_unavailable",
    "broker_error",
] as const;

export const CliConsensusErrorCodeSchema = z.enum(cliConsensusErrorCodeValues);

export type CliConsensusErrorCode = z.infer<typeof CliConsensusErrorCodeSchema>;

export const CliConsensusErrorDetailSchema = z.object({
    code: CliConsensusErrorCodeSchema,
    message: z.string(),
    input: z.string().optional(),
    candidates: z.array(z.string()).optional(),
});

export const CliConsensusErrorSchema = z.object({
    ok: z.literal(false),
    schema: z.literal("cli.consensus.error/1"),
    error: CliConsensusErrorDetailSchema,
});

export interface CliConsensusError {
    ok: false;
    schema: "cli.consensus.error/1";
    error: {
        code: CliConsensusErrorCode;
        message: string;
        input?: string;
        candidates?: string[];
    };
}

export const CliConsensusOutputSchema = z.union([CliConsensusResponseSchema, CliConsensusErrorSchema]);

export type CliConsensusOutput = z.infer<typeof CliConsensusOutputSchema>;

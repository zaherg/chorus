import { z } from "zod/v4";

// === Tool error taxonomy ===

/**
 * Exhaustive list of every tool-execution failure category.
 * Used as a const tuple for discriminated unions and exhaustiveness checks.
 */
const toolErrorTypeValues = [
    "validation", // Input validation failure (type mismatch, missing param, out-of-range)
    "configuration", // Tool misconfiguration (missing API key, wrong endpoint, disabled flag)
    "not_found", // Referenced resource not found (file missing, tool not registered)
    "execution", // Runtime error during tool execution (unhandled exception, external error)
    "timeout", // Tool exceeded its allowed execution duration
    "cancelled", // Execution aborted by an external signal (e.g. AbortController)
    "unknown", // Catch-all for unclassified errors
] as const;

/**
 * Zod schema for a structured tool error.
 * Callers inspect `type` and `retryable` to decide recovery strategy.
 */
export const ToolErrorSchema = z.object({
    /** Error classification; must be one of the 7 known types. */
    type: z.enum(toolErrorTypeValues),
    /** Human-readable error message. Required, non-empty. */
    message: z.string().min(1, "message must not be empty"),
    /**
     * Optional structured error payload.
     * `z.unknown()` accepts any value without validation -- useful for
     * provider-specific shapes, stack traces, or raw response bodies.
     */
    details: z.unknown().optional(),
    /** Whether the operation can be retried. Defaults to `false`. */
    retryable: z.boolean().default(false),
});

// === Inferred TypeScript types ===

/** Shape extracted from `ToolErrorSchema`: `{ type, message, details?, retryable }`. */
export type ToolError = z.infer<typeof ToolErrorSchema>;

/**
 * Generic discriminated union for fallible operations (Rust `Result` pattern).
 * `T` = success payload type, `E` = error type (typically `ToolError`).
 * Consumers narrow on `ok`: `true` -> `.value`, `false` -> `.error`.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

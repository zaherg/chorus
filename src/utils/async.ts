/** Maximum delay accepted by 32-bit signed timers (`setTimeout`, `AbortSignal.timeout`). */
export const MAX_TIMEOUT_MS = 2_147_483_647;

const MAX_ERROR_CAUSE_DEPTH = 8;

/**
 * Normalizes a numeric limit to a positive integer in `[1, max]`.
 * Non-finite, missing, or values whose integer part is less than 1 fall back to `fallback`
 * (itself clamped to `[1, max]`).
 */
export const clampPositiveInt = (value: number | undefined, fallback: number, max = MAX_TIMEOUT_MS): number => {
    const upperBound = Number.isFinite(max) && Math.trunc(max) >= 1 ? Math.trunc(max) : MAX_TIMEOUT_MS;
    const safeFallback =
        Number.isFinite(fallback) && Math.trunc(fallback) >= 1 ? Math.min(Math.trunc(fallback), upperBound) : 1;

    if (value === undefined || !Number.isFinite(value)) {
        return safeFallback;
    }

    const truncated = Math.trunc(value);
    if (truncated < 1) {
        return safeFallback;
    }

    return Math.min(truncated, upperBound);
};

/**
 * Clamps a timer duration in milliseconds to `[1, maxMs]` with a safe positive integer fallback.
 */
export const clampTimeoutMs = (value: number | undefined, fallbackMs: number, maxMs = MAX_TIMEOUT_MS): number =>
    clampPositiveInt(value, fallbackMs, maxMs);

/**
 * Classifies direct or cause-wrapped `AbortError` and `TimeoutError` values,
 * handling cross-realm `DOMException` objects and cyclic `cause` chains safely.
 */
export const isAbortLikeError = (error: unknown): boolean => {
    const visited = new Set<unknown>();
    let current: unknown = error;

    for (let depth = 0; depth <= MAX_ERROR_CAUSE_DEPTH && current !== null && typeof current === "object"; depth++) {
        if (visited.has(current)) {
            return false;
        }
        visited.add(current);

        const name = (current as { name?: unknown }).name;
        if (name === "AbortError" || name === "TimeoutError") {
            return true;
        }

        current = (current as { cause?: unknown }).cause;
    }

    return false;
};

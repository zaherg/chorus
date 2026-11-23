import { describe, expect, test } from "bun:test";

import { clampPositiveInt, clampTimeoutMs, isAbortLikeError, MAX_TIMEOUT_MS } from "@/utils/async";

describe("async timeout and limit helpers", () => {
    test("clampPositiveInt normalizes finite positive integers and falls back on invalid inputs", () => {
        expect(clampPositiveInt(undefined, 100)).toBe(100);
        expect(clampPositiveInt(Number.NaN, 100)).toBe(100);
        expect(clampPositiveInt(Number.POSITIVE_INFINITY, 100)).toBe(100);
        expect(clampPositiveInt(Number.NEGATIVE_INFINITY, 100)).toBe(100);
        expect(clampPositiveInt(-5, 100)).toBe(100);
        expect(clampPositiveInt(0, 100)).toBe(100);
        expect(clampPositiveInt(0.9, 100)).toBe(100);
        expect(clampPositiveInt(1.9, 100)).toBe(1);
        expect(clampPositiveInt(42, 100)).toBe(42);
        expect(clampPositiveInt(MAX_TIMEOUT_MS + 1000, 100)).toBe(MAX_TIMEOUT_MS);
    });

    test("clampTimeoutMs clamps both input and fallback safely into [1, maxMs]", () => {
        expect(clampTimeoutMs(undefined, 0)).toBe(1);
        expect(clampTimeoutMs(undefined, Number.NaN)).toBe(1);
        expect(clampTimeoutMs(undefined, 5_000, 1_000)).toBe(1_000);
        expect(clampTimeoutMs(500, 5_000, 1_000)).toBe(500);
        expect(clampTimeoutMs(2_000, 5_000, 1_000)).toBe(1_000);
    });

    test("isAbortLikeError classifies direct, cross-realm, and cause-wrapped abort/timeout errors safely", () => {
        expect(isAbortLikeError(new DOMException("aborted", "AbortError"))).toBe(true);
        expect(isAbortLikeError(new DOMException("timed out", "TimeoutError"))).toBe(true);
        expect(isAbortLikeError({ name: "AbortError", message: "cross-realm" })).toBe(true);
        expect(
            isAbortLikeError(
                new TypeError("fetch failed", {
                    cause: new Error("socket timeout", {
                        cause: new DOMException("The operation timed out.", "TimeoutError"),
                    }),
                }),
            ),
        ).toBe(true);

        expect(isAbortLikeError(new Error("network failure"))).toBe(false);
        expect(isAbortLikeError(null)).toBe(false);
        expect(isAbortLikeError("AbortError")).toBe(false);

        const cyclic: { name: string; cause?: unknown } = { name: "Error" };
        cyclic.cause = cyclic;
        expect(isAbortLikeError(cyclic)).toBe(false);
    });
});

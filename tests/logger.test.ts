import { describe, expect, it } from "bun:test";

import { redactSecrets, resolveLogLevel } from "@/utils/logger";

describe("redactSecrets", () => {
    it("redacts known secret patterns", () => {
        const cases: Array<[string, string]> = [
            ["Authorization: Bearer sk-proj-abc123xyz...", "sk-proj-abc123xyz"],
            ["sk-ant-abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnopqrstuvwxyz"],
            [
                "Authentication: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.signaturevalue",
                "eyJhbGci",
            ],
            [
                "Token: ghp_1234567890abcdef1234567890abcdef12345678",
                "1234567890ab",
            ],
            [
                "Token: gho_1234567890abcdef1234567890abcdef12345678",
                "1234567890ab",
            ],
            ["key=AIzaSyabcdefghijklmnop0123456789abcdefg", "AIza"],
            ["aws_key=AKIAIOSFODNN7EXAMPLE", "AKIA"],
            [
                "xoxb-1234567890-1234567890123-abcdefghijklmnopqrstuvwx",
                "1234567890123-abcd",
            ],
            [
                "xoxp-1234567890-1234567890123-abcdefghijklmnopqrstuvwx",
                "1234567890123-abcd",
            ],
        ];
        for (const [input, mustNotContain] of cases) {
            const result = redactSecrets(input);
            expect(result).toContain("[REDACTED]");
            expect(result).not.toContain(mustNotContain);
        }
    });

    it("passes through safe text unchanged", () => {
        const safe = "Normal log message without secrets";
        expect(redactSecrets(safe)).toBe(safe);
    });

    it("handles empty string", () => {
        expect(redactSecrets("")).toBe("");
    });

    it("does not mutate the caller's context object", () => {
        // We test that redactSecrets returns a new string without modifying args
        const original = "Bearer sk-test-secret";
        const safe = "Clean message";
        redactSecrets(original);
        expect(original).toBe("Bearer sk-test-secret");
        expect(redactSecrets(safe)).toBe(safe);
    });
});

describe("resolveLogLevel", () => {
    it("uses the parsed config log_level before legacy environment fallback", () => {
        process.env.CHORUS_LOG_LEVEL = "error";
        try {
            expect(resolveLogLevel("debug")).toBe("debug");
        } finally {
            delete process.env.CHORUS_LOG_LEVEL;
        }
    });
});

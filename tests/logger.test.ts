import { describe, expect, it } from "bun:test";

import { redactSecrets, resolveLogLevel } from "@/utils/logger";

describe("redactSecrets", () => {
    it("redacts known secret patterns and preserves safe text", () => {
        const cases: Array<[string, string | undefined]> = [
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
            ["Normal log message without secrets", undefined],
        ];
        for (const [input, mustNotContain] of cases) {
            const result = redactSecrets(input);
            if (mustNotContain === undefined) {
                expect(result).toBe(input);
            } else {
                expect(result).toContain("[REDACTED]");
                expect(result).not.toContain(mustNotContain);
            }
        }
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

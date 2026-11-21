import { describe, expect, it, mock } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getJsonLinesFormatter, reset } from "@logtape/logtape";

import {
    configureLogging,
    createRotatingFileSink,
    logger,
    redactContextValue,
    redactSecrets,
    resolveLogLevel,
} from "@/utils/logger";

describe("redactSecrets", () => {
    it("redacts known secret patterns and preserves safe text", () => {
        const cases: Array<[string, string | undefined]> = [
            ["Authorization: Bearer sk-proj-abc123xyz...", "sk-proj-abc123xyz"],
            ["sk-ant-abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnopqrstuvwxyz"],
            ["Authentication: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.signaturevalue", "eyJhbGci"],
            ["Token: ghp_1234567890abcdef1234567890abcdef12345678", "1234567890ab"],
            ["Token: gho_1234567890abcdef1234567890abcdef12345678", "1234567890ab"],
            ["key=AIzaSyabcdefghijklmnop0123456789abcdefg", "AIza"],
            ["aws_key=AKIAIOSFODNN7EXAMPLE", "AKIA"],
            ["xoxb-1234567890-1234567890123-abcdefghijklmnopqrstuvwx", "1234567890123-abcd"],
            ["xoxp-1234567890-1234567890123-abcdefghijklmnopqrstuvwx", "1234567890123-abcd"],
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

    it("redacts bare provider keys, STS/Bedrock keys, headers, and URL query params", () => {
        const cases: Array<[string, string]> = [
            ["sk-proj-abc1234567890_xyz-98765", "abc1234567890"],
            ["sk-svcacct-abc1234567890_xyz-98765", "abc1234567890"],
            ["sk-ant-api03-abcdefghijklmnopqrstuvwx-1234", "api03-abcdef"],
            ["sk-or-v1-1234567890abcdef1234567890abcdef", "1234567890abcdef"],
            ["upstream error leaked sk-test-secret-value", "sk-test-secret-value"],
            ["sts_key=ASIAIOSFODNN7EXAMPLE", "ASIAIOSFODNN7EXAMPLE"],
            ["bedrock=ABSKQmVkcm9ja0FwaUtleV8xMjM0NTY3ODkw", "QmVkcm9ja0FwaUtleV8xMjM0NTY3ODkw"],
            ["x-api-key: my-super-secret-header-value", "my-super-secret-header-value"],
            ["api-key=another-secret-value", "another-secret-value"],
            ["https://api.example.com/v1/models?api_key=query-secret-123&limit=10", "query-secret-123"],
            ["https://api.example.com/v1/models?foo=1&access_token=tok-secret-456#top", "tok-secret-456"],
            ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
        ];

        for (const [input, mustNotContain] of cases) {
            const result = redactSecrets(input);
            expect(result).toContain("[REDACTED]");
            expect(result).not.toContain(mustNotContain);
        }

        expect(redactSecrets("x-api-key: sk-ant-api03-abcdefghijklmnopqrstuvwx")).toBe("x-api-key: [REDACTED]");
        expect(redactSecrets("Basic configuration error occurred")).toBe("Basic configuration error occurred");
    });
});

describe("redactContextValue", () => {
    it("redacts credential keys while preserving token counts and author metadata", () => {
        const redacted = redactContextValue({
            anthropic_api_key: "plain-anthropic-secret",
            openrouter_api_key: "plain-openrouter-secret",
            custom_api_key: "plain-custom-secret",
            "x-api-key": "plain-header-secret",
            authorization: "plain-auth-value",
            password: "plain-password",
            secret: "plain-secret",
            private_key: "plain-private-key",
            access_token: "plain-access-token",
            auth_token: "plain-auth-token",
            refresh_token: "plain-refresh-token",
            token: "plain-token",
            total_tokens: 1500,
            max_tokens: 4096,
            prompt_tokens: 1000,
            completion_tokens: 500,
            tokenCount: 1500,
            author: "chorus-bot",
            model: "claude-sonnet-4",
        }) as Record<string, unknown>;

        expect(redacted.anthropic_api_key).toBe("[REDACTED]");
        expect(redacted.openrouter_api_key).toBe("[REDACTED]");
        expect(redacted.custom_api_key).toBe("[REDACTED]");
        expect(redacted["x-api-key"]).toBe("[REDACTED]");
        expect(redacted.authorization).toBe("[REDACTED]");
        expect(redacted.password).toBe("[REDACTED]");
        expect(redacted.secret).toBe("[REDACTED]");
        expect(redacted.private_key).toBe("[REDACTED]");
        expect(redacted.access_token).toBe("[REDACTED]");
        expect(redacted.auth_token).toBe("[REDACTED]");
        expect(redacted.refresh_token).toBe("[REDACTED]");
        expect(redacted.token).toBe("[REDACTED]");

        expect(redacted.total_tokens).toBe(1500);
        expect(redacted.max_tokens).toBe(4096);
        expect(redacted.prompt_tokens).toBe(1000);
        expect(redacted.completion_tokens).toBe(500);
        expect(redacted.tokenCount).toBe(1500);
        expect(redacted.author).toBe("chorus-bot");
        expect(redacted.model).toBe("claude-sonnet-4");
    });

    it("serializes and redacts Error instances including cause and custom properties", () => {
        const rootCause = new Error("root failure with sk-proj-abc1234567890_xyz");
        const err = new Error("upstream failed with x-api-key: top-secret-key", {
            cause: rootCause,
        }) as Error & { code?: string; anthropic_api_key?: string };
        err.code = "ECONNRESET";
        err.anthropic_api_key = "should-be-redacted";

        const redacted = redactContextValue(err) as Record<string, unknown>;
        expect(redacted.name).toBe("Error");
        expect(redacted.message).toContain("[REDACTED]");
        expect(redacted.message).not.toContain("top-secret-key");
        expect(typeof redacted.stack).toBe("string");
        expect(redacted.stack).not.toContain("top-secret-key");
        expect(redacted.code).toBe("ECONNRESET");
        expect(redacted.anthropic_api_key).toBe("[REDACTED]");

        const cause = redacted.cause as Record<string, unknown>;
        expect(cause.name).toBe("Error");
        expect(cause.message).toContain("[REDACTED]");
        expect(cause.message).not.toContain("abc1234567890");
    });

    it("handles circular references without crashing and preserves shared DAG objects", () => {
        const circular: Record<string, unknown> = { label: "node" };
        circular.self = circular;

        const redactedCircular = redactContextValue(circular) as Record<string, unknown>;
        expect(redactedCircular.label).toBe("node");
        expect(redactedCircular.self).toBe("[Circular]");

        const shared = { model: "gpt-4o", total_tokens: 42 };
        const dag = { first: shared, second: shared };
        const redactedDag = redactContextValue(dag) as Record<string, unknown>;
        expect(redactedDag.first).toEqual({ model: "gpt-4o", total_tokens: 42 });
        expect(redactedDag.second).toEqual({ model: "gpt-4o", total_tokens: 42 });
    });

    it("returns [MaxDepth] for objects nested beyond the redaction depth limit", () => {
        let deep: Record<string, unknown> = { secret: "sk-proj-abc1234567890_xyz" };
        for (let i = 0; i < 25; i++) {
            deep = { child: deep };
        }

        const redacted = redactContextValue(deep);
        const serialized = JSON.stringify(redacted);
        expect(serialized).toContain("[MaxDepth]");
        expect(serialized).not.toContain("abc1234567890");
    });
});

describe("configureLogging", () => {
    it("is idempotent when called multiple times and enforces 0700/0600 permissions on POSIX", async () => {
        const tempHome = mkdtempSync(join(tmpdir(), "chorus-logger-test-"));
        const logsDir = join(tempHome, ".config", "chorus", "logs");
        const errorLogPath = join(logsDir, "error.log");
        const originalHomedir = nodeOs.homedir;
        const originalUmask = process.platform !== "win32" ? process.umask(0) : undefined;

        mock.module("node:os", () => ({
            ...nodeOs,
            homedir: () => tempHome,
        }));

        try {
            if (process.platform !== "win32") {
                mkdirSync(logsDir, { recursive: true, mode: 0o755 });
                chmodSync(logsDir, 0o755);
            }

            await configureLogging("error");
            await configureLogging("warn");

            logger.error("test failure with sk-proj-abc1234567890_xyz", {
                anthropic_api_key: "secret-key-value",
                total_tokens: 123,
            });

            expect(existsSync(errorLogPath)).toBe(true);
            const content = readFileSync(errorLogPath, "utf8");
            expect(content).toContain("[REDACTED]");
            expect(content).not.toContain("abc1234567890");
            expect(content).not.toContain("secret-key-value");
            expect(content).toContain("123");

            if (process.platform !== "win32") {
                expect(statSync(logsDir).mode & 0o777).toBe(0o700);
                expect(statSync(errorLogPath).mode & 0o777).toBe(0o600);
            }
        } finally {
            await reset();
            mock.module("node:os", () => ({
                ...nodeOs,
                homedir: originalHomedir,
            }));
            mock.restore();
            if (originalUmask !== undefined) {
                process.umask(originalUmask);
            }
            rmSync(tempHome, { recursive: true, force: true });
        }
    });

    it("rotates log files while enforcing 0600 permissions on rotated files", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "chorus-rotate-test-"));
        const logPath = join(tempDir, "error.log");
        try {
            const sink = createRotatingFileSink(logPath, {
                maxSize: 80,
                maxFiles: 2,
                formatter: getJsonLinesFormatter(),
            });

            for (let i = 0; i < 4; i++) {
                sink({
                    category: ["chorus"],
                    level: "error",
                    message: [`rotation entry number ${i} with enough payload bytes`],
                    rawMessage: `rotation entry number ${i} with enough payload bytes`,
                    timestamp: Date.now(),
                    properties: {},
                });
            }

            expect(existsSync(logPath)).toBe(true);
            expect(existsSync(`${logPath}.1`)).toBe(true);
            expect(existsSync(`${logPath}.2`)).toBe(true);
            expect(existsSync(`${logPath}.3`)).toBe(false);

            if (process.platform !== "win32") {
                expect(statSync(logPath).mode & 0o777).toBe(0o600);
                expect(statSync(`${logPath}.1`).mode & 0o777).toBe(0o600);
                expect(statSync(`${logPath}.2`).mode & 0o777).toBe(0o600);
            }
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
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

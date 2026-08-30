import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadConfig } from "@/config";

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), "chorus-config-test-"));
    mock.module("node:os", () => ({
        ...require("node:os"),
        homedir: () => tempDir,
    }));
});

afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    mock.restore();
});

describe("loadConfig", () => {
    const modeOf = (path: string): number => statSync(path).mode & 0o777;
    const supportsPosixModes = process.platform !== "win32";

    it("creates a private default config with retained settings", async () => {
        const config = await (async () => {
            if (!supportsPosixModes) return loadConfig();

            const originalUmask = process.umask(0);
            try {
                return await loadConfig();
            } finally {
                process.umask(originalUmask);
            }
        })();
        const configDir = join(tempDir, ".config", "chorus");
        const configPath = join(configDir, "config.json");
        const writtenConfig = JSON.parse(
            readFileSync(configPath, "utf8"),
        ) as Record<string, unknown>;

        expect(config).toMatchObject({
            cli_timeout_ms: 30_000,
            provider_timeout_ms: 120_000,
            log_level: "info",
            max_concurrent_processes: 3,
        });
        expect(Object.keys(writtenConfig).sort()).toEqual(
            [
                "allow_insecure_custom",
                "amazon_bedrock_api_key",
                "anthropic_api_key",
                "azure_api_key",
                "cli_timeout_ms",
                "custom_api_key",
                "custom_url",
                "google_vertex_api_key",
                "log_level",
                "max_concurrent_processes",
                "openrouter_api_key",
                "provider_timeout_ms",
            ].sort(),
        );
        expect(writtenConfig).toMatchObject({
            openrouter_api_key: "",
            custom_url: "",
            allow_insecure_custom: false,
        });
        if (supportsPosixModes) {
            expect(modeOf(configDir)).toBe(0o700);
            expect(modeOf(configPath)).toBe(0o600);
        }
    });

    it("retains supported settings, strips removed settings, and repairs config permissions", async () => {
        const configDir = join(tempDir, ".config", "chorus");
        const configPath = join(configDir, "config.json");
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            configPath,
            JSON.stringify({
                cli_timeout_ms: 60_000,
                log_level: "debug",
                openrouter_api_key: "sk-openrouter-key",
                openai_api_key: "sk-removed-key",
            }),
        );
        if (supportsPosixModes) {
            chmodSync(configDir, 0o777);
            chmodSync(configPath, 0o666);
        }

        const config = await loadConfig();

        expect(config).toMatchObject({
            cli_timeout_ms: 60_000,
            provider_timeout_ms: 120_000,
            log_level: "debug",
            openrouter_api_key: "sk-openrouter-key",
        });
        expect(config).not.toHaveProperty("openai_api_key");
        if (supportsPosixModes) {
            expect(modeOf(configDir)).toBe(0o700);
            expect(modeOf(configPath)).toBe(0o600);
        }
    });

    it("resolves set environment references and preserves unresolved references", async () => {
        const resolvedName = "CHORUS_TEST_API_KEY";
        const unresolvedName = "CHORUS_TEST_MISSING_API_KEY";
        const originalResolved = process.env[resolvedName];
        const originalUnresolved = process.env[unresolvedName];
        const configDir = join(tempDir, ".config", "chorus");
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            join(configDir, "config.json"),
            JSON.stringify({
                openrouter_api_key: `$${resolvedName}`,
                anthropic_api_key: `$${unresolvedName}`,
            }),
        );
        process.env[resolvedName] = "resolved-value";
        delete process.env[unresolvedName];

        try {
            const config = await loadConfig();
            expect(config.openrouter_api_key).toBe("resolved-value");
            expect(config.anthropic_api_key).toBe(`$${unresolvedName}`);
        } finally {
            if (originalResolved === undefined) {
                delete process.env[resolvedName];
            } else {
                process.env[resolvedName] = originalResolved;
            }
            if (originalUnresolved === undefined) {
                delete process.env[unresolvedName];
            } else {
                process.env[unresolvedName] = originalUnresolved;
            }
        }
    });

    it("fails validation when custom_url is set but custom_api_key is missing", async () => {
        const configDir = join(tempDir, ".config", "chorus");
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            join(configDir, "config.json"),
            JSON.stringify({
                custom_url: "https://example.com/v1",
                custom_api_key: "",
            }),
        );

        await expect(loadConfig()).rejects.toThrow();
    });
});

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

    it("creates default config.json when file is absent", async () => {
        const config = await loadConfig();
        expect(config.cli_timeout_ms).toBe(30_000);
        expect(config.provider_timeout_ms).toBe(120_000);
        expect(config.log_level).toBe("info");
        expect(config.max_concurrent_processes).toBe(3);
    });

    it("writes only retained provider settings to the default config", async () => {
        await loadConfig();

        const configPath = join(tempDir, ".config", "chorus", "config.json");
        const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
            string,
            unknown
        >;

        expect(Object.keys(config).sort()).toEqual(
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
    });

    it("silently strips removed provider keys without warning", async () => {
        const configDir = join(tempDir, ".config", "chorus");
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            join(configDir, "config.json"),
            JSON.stringify({
                openrouter_api_key: "sk-openrouter-key",
                openai_api_key: "sk-removed-key",
            }),
        );

        const { result, stderr } = await (async () => {
            const originalStderrWrite = process.stderr.write.bind(
                process.stderr,
            );
            const lines: string[] = [];
            process.stderr.write = ((chunk: string | Uint8Array): boolean => {
                lines.push(
                    typeof chunk === "string"
                        ? chunk
                        : new TextDecoder().decode(chunk),
                );
                return true;
            }) as typeof process.stderr.write;
            try {
                const config = await loadConfig();
                return { result: config, stderr: lines.join("") };
            } finally {
                process.stderr.write = originalStderrWrite;
            }
        })();

        expect(result.openrouter_api_key).toBe("sk-openrouter-key");
        expect(result).not.toHaveProperty("openai_api_key");
        expect(stderr).not.toContain("openai");
    });

    it("creates default config.json and config directory with private permissions", async () => {
        if (!supportsPosixModes) {
            await loadConfig();
            return;
        }

        const originalUmask = process.umask(0);
        try {
            await loadConfig();
        } finally {
            process.umask(originalUmask);
        }

        const configDir = join(tempDir, ".config", "chorus");
        const configPath = join(configDir, "config.json");
        expect(modeOf(configDir)).toBe(0o700);
        expect(modeOf(configPath)).toBe(0o600);
    });

    it("repairs overly permissive existing config permissions while loading", async () => {
        if (!supportsPosixModes) {
            await loadConfig();
            return;
        }

        const configDir = join(tempDir, ".config", "chorus");
        const configPath = join(configDir, "config.json");
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            configPath,
            JSON.stringify({
                log_level: "debug",
                openrouter_api_key: "sk-test-key",
            }),
        );
        chmodSync(configDir, 0o777);
        chmodSync(configPath, 0o666);

        const config = await loadConfig();

        expect(config.log_level).toBe("debug");
        expect(config.openrouter_api_key).toBe("sk-test-key");
        expect(modeOf(configDir)).toBe(0o700);
        expect(modeOf(configPath)).toBe(0o600);
    });

    it("loads config with literal values from an existing config.json", async () => {
        const configDir = join(tempDir, ".config", "chorus");
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            join(configDir, "config.json"),
            JSON.stringify({
                cli_timeout_ms: 60_000,
                log_level: "debug",
                openrouter_api_key: "sk-test-key",
            }),
        );

        const config = await loadConfig();
        expect(config.cli_timeout_ms).toBe(60_000);
        expect(config.log_level).toBe("debug");
        expect(config.openrouter_api_key).toBe("sk-test-key");
        expect(config.provider_timeout_ms).toBe(120_000);
    });

    it("resolves $ENV_VAR references in string values", async () => {
        process.env.TEST_API_KEY = "resolved-value";
        const configDir = join(tempDir, ".config", "chorus");
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            join(configDir, "config.json"),
            JSON.stringify({
                openrouter_api_key: "$TEST_API_KEY",
            }),
        );

        const config = await loadConfig();
        expect(config.openrouter_api_key).toBe("resolved-value");
        delete process.env.TEST_API_KEY;
    });

    it("resolves unresolved $ENV_VAR references to empty string", async () => {
        const configDir = join(tempDir, ".config", "chorus");
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            join(configDir, "config.json"),
            JSON.stringify({
                openrouter_api_key: "$MISSING_VAR",
            }),
        );

        const config = await loadConfig();
        expect(config.openrouter_api_key).toBe("$MISSING_VAR");
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

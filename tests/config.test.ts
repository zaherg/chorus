import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ZodError } from "zod/v4";

import { loadConfig, wasExpandedFromEnv } from "@/config";
import { isProviderConfigured } from "@/providers/registry";

let tempDir: string;

const expectRejectedError = async (promise: Promise<unknown>): Promise<Error> => {
    try {
        await promise;
    } catch (error: unknown) {
        return error instanceof Error ? error : new Error(String(error));
    }
    throw new Error("Expected promise to reject");
};

const withEnv = async <T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> => {
    const originals = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(overrides)) {
        originals.set(key, process.env[key]);
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    try {
        return await run();
    } finally {
        for (const [key, original] of originals) {
            if (original === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = original;
            }
        }
    }
};

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
        const writtenConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;

        expect(config).toMatchObject({
            cli_timeout_ms: 2_700_000,
            provider_timeout_ms: 1_800_000,
            log_level: "info",
            max_concurrent_processes: 3,
        });
        expect(Object.keys(writtenConfig).sort()).toEqual(
            [
                "allow_insecure_custom",
                "amazon_bedrock_api_key",
                "amazon_bedrock_region",
                "anthropic_api_key",
                "azure_api_key",
                "azure_base_url",
                "azure_resource_name",
                "cli_timeout_ms",
                "custom_api_key",
                "custom_url",
                "google_vertex_api_key",
                "google_vertex_location",
                "google_vertex_project",
                "log_level",
                "max_concurrent_processes",
                "openrouter_api_key",
                "provider_timeout_ms",
            ].sort(),
        );
        expect(writtenConfig).toMatchObject({
            cli_timeout_ms: 2_700_000,
            provider_timeout_ms: 1_800_000,
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
            provider_timeout_ms: 1_800_000,
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
        const bracedName = "CHORUS_TEST_BRACED_KEY";
        const unresolvedName = "CHORUS_TEST_MISSING_API_KEY";
        const configDir = join(tempDir, ".config", "chorus");
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            join(configDir, "config.json"),
            JSON.stringify({
                openrouter_api_key: `$${resolvedName}`,
                azure_resource_name: `\${${bracedName}}`,
                anthropic_api_key: `$${unresolvedName}`,
            }),
        );

        await withEnv(
            {
                [resolvedName]: "resolved-value",
                [bracedName]: "my-azure-resource",
                [unresolvedName]: undefined,
            },
            async () => {
                const config = await loadConfig();
                expect(config.cli_timeout_ms).toBe(2_700_000);
                expect(config.openrouter_api_key).toBe("resolved-value");
                expect(config.azure_resource_name).toBe("my-azure-resource");
                expect(config.anthropic_api_key).toBe(`$${unresolvedName}`);
                expect(wasExpandedFromEnv(config, "openrouter_api_key")).toBeTrue();
                expect(wasExpandedFromEnv(config, "azure_resource_name")).toBeTrue();
                expect(wasExpandedFromEnv(config, "anthropic_api_key")).toBeFalse();
            },
        );
    });

    it("keeps secrets containing $UPPER configured when expanded from environment variables", async () => {
        const secretVar = "CHORUS_TEST_SECRET_WITH_DOLLAR";
        const configDir = join(tempDir, ".config", "chorus");
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            join(configDir, "config.json"),
            JSON.stringify({
                openrouter_api_key: `\${${secretVar}}`,
            }),
        );

        await withEnv({ [secretVar]: "sk-real$SECRET_TOKEN" }, async () => {
            const config = await loadConfig();
            expect(config.openrouter_api_key).toBe("sk-real$SECRET_TOKEN");
            expect(wasExpandedFromEnv(config, "openrouter_api_key")).toBeTrue();
            expect(isProviderConfigured("openrouter", config)).toBeTrue();
        });
    });

    it("keeps other providers working when CUSTOM_API_KEY env var is exported empty", async () => {
        const configDir = join(tempDir, ".config", "chorus");
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            join(configDir, "config.json"),
            JSON.stringify({
                openrouter_api_key: "sk-openrouter-valid",
                custom_url: "https://example.com/v1",
                custom_api_key: "$CHORUS_TEST_EMPTY_CUSTOM_KEY",
            }),
        );

        await withEnv({ CHORUS_TEST_EMPTY_CUSTOM_KEY: "" }, async () => {
            const config = await loadConfig();
            expect(config.custom_api_key).toBe("$CHORUS_TEST_EMPTY_CUSTOM_KEY");
            expect(isProviderConfigured("openrouter", config)).toBeTrue();
            expect(isProviderConfigured("custom", config)).toBeFalse();
        });
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

        const err = await expectRejectedError(loadConfig());
        expect(err).toBeInstanceOf(ZodError);
        if (err instanceof ZodError) {
            expect(err.issues[0]?.path).toEqual(["custom_api_key"]);
        }
    });

    it("rejects non-object JSON payloads", async () => {
        const configDir = join(tempDir, ".config", "chorus");
        const configPath = join(configDir, "config.json");
        mkdirSync(configDir, { recursive: true });

        for (const payload of ["[]", "null", "123", '"text"']) {
            writeFileSync(configPath, payload);
            const err = await expectRejectedError(loadConfig());
            expect(err.message).toContain("expected a JSON object");
        }
    });

    it("ignores prototype pollution keys in config JSON", async () => {
        const configDir = join(tempDir, ".config", "chorus");
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            join(configDir, "config.json"),
            '{"__proto__":{"polluted":true},"constructor":{"bad":1},"prototype":{"bad":2},"log_level":"warn"}',
        );

        const config = await loadConfig();
        expect(config.log_level).toBe("warn");
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.hasOwn(config, "__proto__")).toBeFalse();
        expect(Object.hasOwn(config, "constructor")).toBeFalse();
        expect(Object.hasOwn(config, "prototype")).toBeFalse();
    });

    it("strictly validates integer timeout and concurrency fields", async () => {
        const configDir = join(tempDir, ".config", "chorus");
        const configPath = join(configDir, "config.json");
        mkdirSync(configDir, { recursive: true });

        const invalidValues: unknown[] = [
            "",
            "   ",
            true,
            false,
            null,
            0,
            -1,
            1.5,
            "1.5",
            "NaN",
            "$UNSET_TIMEOUT_MS",
            2_147_483_648,
            [],
            {},
        ];

        for (const field of ["cli_timeout_ms", "provider_timeout_ms", "max_concurrent_processes"] as const) {
            for (const badValue of invalidValues) {
                writeFileSync(configPath, JSON.stringify({ [field]: badValue }));
                const err = await expectRejectedError(loadConfig());
                expect(err).toBeInstanceOf(ZodError);
            }
        }

        await withEnv({ CHORUS_TEST_TIMEOUT_MS: " 45000 " }, async () => {
            writeFileSync(
                configPath,
                JSON.stringify({
                    cli_timeout_ms: "$CHORUS_TEST_TIMEOUT_MS",
                    provider_timeout_ms: " 12000 ",
                    max_concurrent_processes: "4",
                }),
            );
            const config = await loadConfig();
            expect(config.cli_timeout_ms).toBe(45_000);
            expect(config.provider_timeout_ms).toBe(12_000);
            expect(config.max_concurrent_processes).toBe(4);
        });
    });

    it("handles concurrent first-run default config creation safely", async () => {
        const [first, second] = await Promise.all([loadConfig(), loadConfig()]);
        expect(first.cli_timeout_ms).toBe(2_700_000);
        expect(second.cli_timeout_ms).toBe(2_700_000);
    });

    it("skips chmod when config.json is a symlink", async () => {
        if (!supportsPosixModes) return;

        const configDir = join(tempDir, ".config", "chorus");
        const configPath = join(configDir, "config.json");
        const targetPath = join(tempDir, "shared-config.json");
        mkdirSync(configDir, { recursive: true });
        writeFileSync(targetPath, JSON.stringify({ log_level: "error" }), { mode: 0o644 });
        chmodSync(targetPath, 0o644);
        symlinkSync(targetPath, configPath);

        const config = await loadConfig();
        expect(config.log_level).toBe("error");
        expect(modeOf(targetPath)).toBe(0o644);
    });
});

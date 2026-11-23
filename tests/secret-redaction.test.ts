import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runConsensus } from "@/consensus";
import type { ProviderRegistry } from "@/providers/registry";
import type { BrokerModelInfo, ModelsListResponse } from "@/types/providers";
import { clearRedactedSecrets, redactSecrets, registerRedactedSecrets } from "@/utils/redact";

const tempDirs: string[] = [];

const makeTempHome = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "chorus-secret-redaction-"));
    tempDirs.push(dir);
    return dir;
};

afterEach(() => {
    clearRedactedSecrets();
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

const AZURE_HEX_KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const CUSTOM_GATEWAY_KEY = "gateway-token-998877665544332211";
const BEARER_KEY = "sk-ant-api03-secretvalue1234567890abcdef";
const QUERY_TOKEN = "query-secret-token-xyz987654";

const writeTempConfig = (homeDir: string, rawConfig: string): void => {
    const configDir = join(homeDir, ".config", "chorus");
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(configDir, "config.json"), rawConfig, { mode: 0o600 });
};

const runInTempHome = async (homeDir: string, script: string) => {
    const proc = Bun.spawn([process.execPath, "-e", script], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: homeDir },
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { exitCode, stdout, stderr };
};

const minimalCatalog = (): ModelsListResponse => {
    const modelA: BrokerModelInfo = {
        route_id: "anthropic/claude-a",
        provider: "anthropic",
        provider_model_id: "claude-a",
        display_name: "Claude A",
    };
    const modelB: BrokerModelInfo = {
        route_id: "anthropic/claude-b",
        provider: "anthropic",
        provider_model_id: "claude-b",
        display_name: "Claude B",
    };
    return {
        schema: "models.list/1",
        cache: {
            status: "fresh",
            fetched_at: "2026-11-23T00:00:00.000Z",
            expires_at: "2026-11-24T00:00:00.000Z",
        },
        providers: {
            anthropic: {
                status: "catalog",
                models: [modelA, modelB],
            },
        },
    };
};

describe("secret redaction boundary", () => {
    it("redacts prefixless configured API keys after loadConfig", async () => {
        const homeDir = makeTempHome();
        writeTempConfig(
            homeDir,
            JSON.stringify({
                azure_api_key: AZURE_HEX_KEY,
                azure_resource_name: "example-resource",
                custom_url: "https://example.com/v1",
                custom_api_key: CUSTOM_GATEWAY_KEY,
            }),
        );

        const res = await runInTempHome(
            homeDir,
            `
            import { loadConfig } from "./src/config.ts";
            import { redactContextValue, redactSecrets } from "./src/utils/logger.ts";
            await loadConfig();
            const line = redactSecrets("Upstream rejected azure=${AZURE_HEX_KEY} and custom=${CUSTOM_GATEWAY_KEY}");
            const ctx = redactContextValue({ detail: "key ${CUSTOM_GATEWAY_KEY} failed" });
            console.log(JSON.stringify({ line, ctx }));
            `,
        );

        expect(res.exitCode).toBe(0);
        const parsed = JSON.parse(res.stdout) as { line: string; ctx: { detail: string } };
        expect(parsed.line).not.toContain(AZURE_HEX_KEY);
        expect(parsed.line).not.toContain(CUSTOM_GATEWAY_KEY);
        expect(parsed.line).toContain("[REDACTED]");
        expect(parsed.ctx.detail).not.toContain(CUSTOM_GATEWAY_KEY);
    });

    it("redacts secrets from consensus participant, synthesis, and all-failed error messages", async () => {
        const catalog = minimalCatalog();
        const failingRegistry: ProviderRegistry = {
            isProviderConfigured: () => true,
            getModelInfo: async (input) => catalog.providers.anthropic?.models.find((m) => m.route_id === input),
            generateText: async (input) => {
                if (input === "anthropic/claude-a") {
                    return {
                        ok: true,
                        value: {
                            model: input,
                            provider: "anthropic",
                            text: "ok",
                            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                        },
                    };
                }
                throw new Error(
                    `Request failed: Authorization: Bearer ${BEARER_KEY} url=https://api.example.com?api_key=${QUERY_TOKEN}`,
                );
            },
        };

        const partial = await runConsensus({
            providerRegistry: failingRegistry,
            catalog,
            configuredProviders: new Set(["anthropic"]),
            models: [{ model_id: "anthropic/claude-a" }, { model_id: "anthropic/claude-b" }],
            findings: "test",
            step: "test",
            synthesisModel: "anthropic/claude-b",
        });

        expect(partial.ok).toBe(true);
        if (partial.ok) {
            const failed = partial.models.find((m) => m.route_id === "anthropic/claude-b");
            expect(failed?.error?.message).toBeDefined();
            expect(failed?.error?.message).not.toContain(BEARER_KEY);
            expect(failed?.error?.message).not.toContain(QUERY_TOKEN);

            expect(partial.synthesis_error?.message).toBeDefined();
            expect(partial.synthesis_error?.message).not.toContain(BEARER_KEY);
            expect(partial.synthesis_error?.message).not.toContain(QUERY_TOKEN);
        }

        const allFailedRegistry: ProviderRegistry = {
            isProviderConfigured: () => true,
            getModelInfo: async (input) => catalog.providers.anthropic?.models.find((m) => m.route_id === input),
            generateText: async () => ({
                ok: false,
                error: {
                    type: "execution",
                    message: `Provider rejected Authorization: Bearer ${BEARER_KEY}`,
                    retryable: false,
                },
            }),
        };

        const allFailed = await runConsensus({
            providerRegistry: allFailedRegistry,
            catalog,
            configuredProviders: new Set(["anthropic"]),
            models: [{ model_id: "anthropic/claude-a" }, { model_id: "anthropic/claude-b" }],
            findings: "test",
            step: "test",
        });

        expect(allFailed.ok).toBe(false);
        if (!allFailed.ok) {
            expect(allFailed.errors.join("\n")).not.toContain(BEARER_KEY);
        }
    });

    it("redacts secrets in CLI error outputs for consensus and list-models", async () => {
        const homeDir = makeTempHome();
        writeTempConfig(
            homeDir,
            JSON.stringify({
                custom_url: "https://example.com/v1",
                custom_api_key: CUSTOM_GATEWAY_KEY,
            }),
        );

        const consensusOut = await runInTempHome(
            homeDir,
            `
            import { runConsensusCommand } from "./src/commands/consensus.ts";
            globalThis.fetch = async () => {
                throw new Error("catalog fetch failed: Authorization: Bearer ${BEARER_KEY} key=${CUSTOM_GATEWAY_KEY}");
            };
            const code = await runConsensusCommand(["--models", "custom/m1,custom/m2", "--prompt", "hello"]);
            process.exit(code);
            `,
        );
        expect(consensusOut.exitCode).toBe(1);
        expect(consensusOut.stdout).not.toContain(BEARER_KEY);
        expect(consensusOut.stdout).not.toContain(CUSTOM_GATEWAY_KEY);
        expect(consensusOut.stderr).not.toContain(BEARER_KEY);
        expect(consensusOut.stderr).not.toContain(CUSTOM_GATEWAY_KEY);

        const listOut = await runInTempHome(
            homeDir,
            `
            import { runListModelsCommand } from "./src/commands/list-models.ts";
            globalThis.fetch = async () => {
                throw new Error("catalog fetch failed: Authorization: Bearer ${BEARER_KEY} key=${CUSTOM_GATEWAY_KEY}");
            };
            const code = await runListModelsCommand(["--json"]);
            process.exit(code);
            `,
        );
        expect(listOut.exitCode).toBe(1);
        expect(listOut.stdout).not.toContain(BEARER_KEY);
        expect(listOut.stdout).not.toContain(CUSTOM_GATEWAY_KEY);
        expect(listOut.stderr).not.toContain(BEARER_KEY);
        expect(listOut.stderr).not.toContain(CUSTOM_GATEWAY_KEY);
    });

    it("ignores short tokens, prefers longest registered secret first, and skips unresolved env placeholders", async () => {
        registerRedactedSecrets(["short", "prefix-secret", "prefix-secret-extended"]);
        expect(redactSecrets("short word stays visible")).toBe("short word stays visible");
        expect(redactSecrets("leaked prefix-secret-extended and prefix-secret")).toBe(
            "leaked [REDACTED] and [REDACTED]",
        );

        const homeDir = makeTempHome();
        writeTempConfig(
            homeDir,
            JSON.stringify({
                anthropic_api_key: "$UNSET_ANTHROPIC_PLACEHOLDER",
            }),
        );
        const res = await runInTempHome(
            homeDir,
            `
            import { loadConfig } from "./src/config.ts";
            import { redactSecrets } from "./src/utils/logger.ts";
            await loadConfig();
            console.log(redactSecrets("Missing $UNSET_ANTHROPIC_PLACEHOLDER in env"));
            `,
        );
        expect(res.exitCode).toBe(0);
        expect(res.stdout.trim()).toBe("Missing $UNSET_ANTHROPIC_PLACEHOLDER in env");
    });
});

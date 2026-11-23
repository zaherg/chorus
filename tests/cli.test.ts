import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "@/cli";
import { CACHE_DIR_NAME, CATALOG_FILE_NAME, METADATA_FILE_NAME } from "@/providers/model-catalog";
import { CliConsensusOutputSchema } from "@/types/consensus";
import { ModelsListResponseSchema } from "@/types/providers";
import { captureOutput, captureStdout } from "./helpers";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliDistPath = join(repoRoot, "dist", "cli.js");
const packageVersion = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string })
    .version;

const tempDirs: string[] = [];
const activeServers: Server[] = [];

afterEach(async () => {
    for (const server of activeServers.splice(0)) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const createTempDir = async (prefix: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
};

const setupTempHome = async (customUrl: string): Promise<string> => {
    const homeDir = await createTempDir("chorus-e2e-home-");
    const configDir = join(homeDir, ".config", "chorus");
    const cacheDir = join(configDir, CACHE_DIR_NAME);
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await chmod(configDir, 0o700);

    const configPath = join(configDir, "config.json");
    await writeFile(
        configPath,
        JSON.stringify(
            {
                custom_url: customUrl,
                custom_api_key: "$TEST_CUSTOM_API_KEY",
            },
            null,
            2,
        ),
        { mode: 0o600 },
    );
    await chmod(configPath, 0o600);

    const now = new Date();
    const expires = new Date(now.getTime() + 60 * 60 * 1000);
    await writeFile(join(cacheDir, CATALOG_FILE_NAME), JSON.stringify({ models: {}, providers: {} }));
    await writeFile(
        join(cacheDir, METADATA_FILE_NAME),
        JSON.stringify({
            schema: "models-cache/1",
            fetched_at: now.toISOString(),
            expires_at: expires.toISOString(),
            source: "https://models.dev/api.json",
        }),
    );

    return homeDir;
};

const spawnCli = async (
    args: string[],
    options: {
        cwd?: string;
        homeDir?: string;
        stdin?: string;
        extraEnv?: Record<string, string>;
    } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        ...(options.homeDir ? { HOME: options.homeDir } : { HOME: process.env.HOME ?? tmpdir() }),
        ...(options.extraEnv ?? {}),
    };

    const proc = Bun.spawn([process.execPath, cliDistPath, ...args], {
        cwd: options.cwd ?? repoRoot,
        env,
        stdin: options.stdin !== undefined ? new Response(options.stdin) : "ignore",
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

interface MockCompletionRequest {
    model: string;
    promptText: string;
}

const startMockOpenAiServer = async (): Promise<{
    baseUrl: string;
    requests: MockCompletionRequest[];
}> => {
    const requests: MockCompletionRequest[] = [];

    const server = createServer((req, res) => {
        if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: `unexpected route: ${req.method} ${req.url}` } }));
            return;
        }

        let rawBody = "";
        req.on("data", (chunk: Buffer) => {
            rawBody += chunk.toString("utf8");
        });
        req.on("end", () => {
            const body = JSON.parse(rawBody) as {
                model?: string;
                messages?: Array<{ role?: string; content?: unknown }>;
            };
            const model = body.model ?? "unknown-model";
            const promptText = JSON.stringify(body.messages ?? []);
            requests.push({ model, promptText });

            res.writeHead(200, { "content-type": "application/json" });
            res.end(
                JSON.stringify({
                    id: `chatcmpl-${model}`,
                    object: "chat.completion",
                    created: 1700000000,
                    model,
                    choices: [
                        {
                            index: 0,
                            message: {
                                role: "assistant",
                                content: `Mock evaluation from ${model}`,
                            },
                            finish_reason: "stop",
                        },
                    ],
                    usage: {
                        prompt_tokens: 12,
                        completion_tokens: 6,
                        total_tokens: 18,
                    },
                }),
            );
        });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    activeServers.push(server);
    const address = server.address() as AddressInfo;
    return {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        requests,
    };
};

describe("runCli", () => {
    it("exits 0 and prints package.json version with --version and -v", async () => {
        for (const flag of ["--version", "-v"]) {
            const { output, result: code } = await captureStdout(() => runCli([flag]));
            expect(code).toBe(0);
            expect(output.trim()).toBe(`consensus ${packageVersion}`);
        }
    });

    it("rejects trailing arguments for --version, -v, --help, -h, and help with exit code 2", async () => {
        const cases = [
            ["--version", "--bogus"],
            ["-v", "extra"],
            ["--help", "--bogus"],
            ["-h", "--bogus"],
            ["help", "extra"],
        ];

        for (const args of cases) {
            const { result: code, stdout, stderr } = await captureOutput(() => runCli(args));
            expect(code).toBe(2);
            expect(stdout).toBe("");
            expect(stderr).toContain("Error:");
            expect(stderr).toContain(args[1]);
        }
    });

    it("prints help and exits 0 for --help, -h, help, and consensus --models ... --help", async () => {
        for (const args of [
            ["--help"],
            ["-h"],
            ["help"],
            ["--models", "m1,m2", "--help"],
            ["--models", "m1,m2", "-h"],
        ]) {
            const { result: code, stdout, stderr } = await captureOutput(() => runCli(args));
            expect(code).toBe(0);
            expect(stderr).toBe("");
            expect(stdout).toContain("USAGE:");
            expect(stdout).toContain("CONFIG:");
            expect(stdout).toContain("~/.config/chorus/config.json");
            expect(stdout).toContain("$ENV_VAR");
            expect(stdout).toContain("130  Interrupted by SIGINT");
            expect(stdout).toContain("143  Terminated by SIGTERM");
        }
    });

    it("rejects unknown flags alongside --help when routed to consensus", async () => {
        const {
            result: code,
            stdout,
            stderr,
        } = await captureOutput(() => runCli(["--models", "m1,m2", "--help", "--bogus"]));
        expect(code).toBe(2);
        expect(stdout).toBe("");
        expect(stderr).toContain("Error: unknown option --bogus");
    });

    it("exits 2 when invoked with no arguments", async () => {
        const { result: code, stdout, stderr } = await captureOutput(() => runCli([]));
        expect(code).toBe(2);
        expect(stdout).toBe("");
        expect(stderr).toContain("Error:");
    });

    it("dispatches list-models --help with exit 0 without touching config", async () => {
        const freshHome = await createTempDir("chorus-unit-home-");
        const previousHome = process.env.HOME;
        process.env.HOME = freshHome;
        try {
            const { result: code, stdout, stderr } = await captureOutput(() => runCli(["list-models", "--help"]));
            expect(code).toBe(0);
            expect(stderr).toBe("");
            expect(stdout).toContain("list-models");

            let configExists = true;
            try {
                await stat(join(freshHome, ".config", "chorus", "config.json"));
            } catch {
                configExists = false;
            }
            expect(configExists).toBe(false);
        } finally {
            if (previousHome === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = previousHome;
            }
        }
    });

    it("exits 1 for unknown command", async () => {
        const { result: code, stdout } = await captureOutput(() => runCli(["nonexistent-command"]));

        expect(code).toBe(1);
        expect(stdout).toContain("USAGE:");
    });
});

describe("dist/cli.js subprocess e2e", () => {
    it("exits 0 for --version and --help", async () => {
        const versionRun = await spawnCli(["--version"]);
        expect(versionRun.exitCode).toBe(0);
        expect(versionRun.stderr).toBe("");
        expect(versionRun.stdout.trim()).toBe(`consensus ${packageVersion}`);

        const helpRun = await spawnCli(["--help"]);
        expect(helpRun.exitCode).toBe(0);
        expect(helpRun.stderr).toBe("");
        expect(helpRun.stdout).toContain("USAGE:");
    });

    it("returns models.list/1 for list-models --json with cached catalog and custom provider", async () => {
        const homeDir = await setupTempHome("http://127.0.0.1:1/v1");
        const run = await spawnCli(["list-models", "--json"], {
            homeDir,
            extraEnv: { TEST_CUSTOM_API_KEY: "test-custom-key" },
        });

        expect(run.exitCode).toBe(0);
        expect(run.stderr).toBe("");
        const parsed = ModelsListResponseSchema.parse(JSON.parse(run.stdout));
        expect(parsed.schema).toBe("models.list/1");
        expect(parsed.cache.status).toBe("fresh");
        expect(parsed.providers.custom).toEqual({
            status: "passthrough",
            models: [],
        });
    });

    it("runs full unmocked consensus --stdin-json pipeline with file embedding over local HTTP", async () => {
        const { baseUrl, requests } = await startMockOpenAiServer();
        const homeDir = await setupTempHome(baseUrl);
        const workDir = await createTempDir("chorus-e2e-work-");
        const sampleFileName = "proposal.txt";
        const sampleFileContent = "E2E_EMBEDDED_TOKEN_9481: adopt strict schema validation.";
        await writeFile(join(workDir, sampleFileName), sampleFileContent, "utf8");

        const stdinPayload = JSON.stringify({
            models: ["custom/model-a", "custom/model-b"],
            prompt: "Evaluate the attached proposal.",
            files: [sampleFileName],
        });

        const run = await spawnCli(["--stdin-json"], {
            cwd: workDir,
            homeDir,
            stdin: stdinPayload,
            extraEnv: { TEST_CUSTOM_API_KEY: "test-custom-key" },
        });

        expect(run.exitCode).toBe(0);
        const output = CliConsensusOutputSchema.parse(JSON.parse(run.stdout));
        expect(output.ok).toBe(true);
        if (!output.ok) {
            throw new Error("Expected ok consensus response");
        }

        expect(output.schema).toBe("cli.consensus/2");
        expect(output.models).toHaveLength(2);

        const byRoute = new Map(output.models.map((entry) => [entry.route_id, entry]));
        expect(byRoute.get("custom/model-a")?.response).toBe("Mock evaluation from model-a");
        expect(byRoute.get("custom/model-b")?.response).toBe("Mock evaluation from model-b");

        const expectedSamplePath = await realpath(join(workDir, sampleFileName));
        expect(output.embeddedFiles.embedded_files).toEqual([expectedSamplePath]);
        expect(output.embeddedFiles.skipped_files).toEqual([]);
        expect(output.embeddedFiles.embedded_text).toContain(sampleFileContent);

        expect(requests.map((entry) => entry.model).sort()).toEqual(["model-a", "model-b"]);
        for (const request of requests) {
            expect(request.promptText).toContain(sampleFileContent);
        }
    });
});

import { describe, expect, it } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "@/cli";
import { StdinConsensusSchema } from "@/commands/consensus";
import { CliConsensusErrorSchema, CliConsensusResponseSchema } from "@/types/consensus";
import { ModelsListErrorSchema, ModelsListResponseSchema } from "@/types/providers";
import { captureOutput } from "./helpers";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillPath = join(repoRoot, "skills/consensus/SKILL.md");
const installerPath = join(repoRoot, "skills/consensus/scripts/install.sh");
const skill = readFileSync(skillPath, "utf8");

const parseFrontmatter = (source: string): { lines: string[]; fields: Record<string, string> } => {
    const match = source.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) return { lines: [], fields: {} };
    const lines = match[1].split("\n");
    const fields: Record<string, string> = {};
    for (const line of lines) {
        const idx = line.indexOf(":");
        if (idx > 0) {
            fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
    }
    return { lines, fields };
};

const extractBashBlocks = (source: string): string[] =>
    [...source.matchAll(/```bash\r?\n([\s\S]*?)```/g)].map((match) => match[1]);

describe("consensus skill contract", () => {
    it("has valid single-line YAML frontmatter and no em-dash characters", () => {
        const { lines, fields } = parseFrontmatter(skill);
        expect(lines.length).toBeGreaterThanOrEqual(2);
        for (const line of lines) {
            expect(line).toMatch(/^[a-z0-9-]+:\s+\S/);
        }
        expect(fields.name).toBe("consensus");
        expect(fields.description).toBeDefined();
        expect(fields.description.length).toBeGreaterThan(20);
        expect(fields.description).not.toMatch(/^[>|][-+]?$/);
        expect(skill).not.toContain("\u2014");
    });

    it("references an existing executable skill-local installer script", () => {
        expect(skill).toContain("scripts/install.sh");
        const stats = statSync(installerPath);
        expect(stats.isFile()).toBe(true);
        expect(stats.mode & 0o111).toBeGreaterThan(0);
    });

    it("provides a stdin-json example valid against StdinConsensusSchema", () => {
        const stdinBlocks = extractBashBlocks(skill).filter((block) => block.includes("consensus --stdin-json"));
        expect(stdinBlocks.length).toBeGreaterThanOrEqual(1);

        const payloads: unknown[] = [];
        for (const block of stdinBlocks) {
            const match = block.match(/printf\s+'%s\\n'\s+'(\{[^']+\})'/);
            if (match) {
                payloads.push(JSON.parse(match[1]));
            }
        }

        expect(payloads.length).toBeGreaterThanOrEqual(1);
        for (const payload of payloads) {
            const parsed = StdinConsensusSchema.safeParse(payload);
            expect(parsed.success).toBe(true);
            if (parsed.success) {
                expect(new Set(parsed.data.models).size).toBeGreaterThanOrEqual(2);
            }
        }
    });

    it("documents wire schema IDs matching src/types schemas", () => {
        const expectedSchemas = [
            CliConsensusResponseSchema.shape.schema.value,
            CliConsensusErrorSchema.shape.schema.value,
            ModelsListResponseSchema.shape.schema.value,
            ModelsListErrorSchema.shape.schema.value,
        ];

        expect(expectedSchemas).toContain("cli.consensus/2");
        expect(expectedSchemas).toContain("models.list/1");
        for (const schemaId of expectedSchemas) {
            expect(skill).toContain(`\`${schemaId}\``);
        }
    });

    it("documents CLI flags present in real consensus --help output", async () => {
        const { result: code, stdout, stderr } = await captureOutput(() => runCli(["--help"]));
        expect(code).toBe(0);
        expect(stderr).toBe("");

        const documentedFlags = [
            "--models",
            "--prompt",
            "--stdin-json",
            "--sequential",
            "--files",
            "--temperature",
            "--stance",
            "--thinking-mode",
            "--temperature-model",
            "--synthesis-model",
            "--schema",
            "--help",
        ];

        for (const flag of documentedFlags) {
            expect(skill).toContain(flag);
            expect(stdout).toContain(flag);
        }
    });
});

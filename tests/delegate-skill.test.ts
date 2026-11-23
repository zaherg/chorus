import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillPath = join(repoRoot, "skills/delegate/SKILL.md");
const skill = readFileSync(skillPath, "utf8");

const parseFrontmatter = (source: string): Record<string, string> => {
    const match = source.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) return {};
    const fields: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
        const idx = line.indexOf(":");
        if (idx > 0) {
            fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
    }
    return fields;
};

const extractFencedBlocks = (source: string): string[] =>
    [...source.matchAll(/```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)```/g)].map((match) => match[1]);

const extractPiSection = (source: string): string => {
    const heading = "### Pi Coding Agent";
    const start = source.indexOf(heading);
    if (start === -1) return "";
    const rest = source.slice(start + heading.length);
    const next = rest.search(/\n### /);
    return next === -1 ? rest : rest.slice(0, next);
};

const piSection = extractPiSection(skill);
const allCodeBlocks = extractFencedBlocks(skill);
const piCodeBlocks = extractFencedBlocks(piSection);

describe("delegate skill contract", () => {
    it("has valid YAML frontmatter with name, manual-only invocation, and no em-dash characters", () => {
        const meta = parseFrontmatter(skill);
        expect(meta.name).toBe("delegate");
        expect(meta["disable-model-invocation"]).toBe("true");
        expect(meta.description).toBeDefined();
        expect(meta.description.length).toBeGreaterThan(20);
        expect(meta.description).not.toMatch(/^[>|][-+]?$/);
        expect(skill).not.toContain("\u2014");
    });

    it("never runs credential-emitting flags or commands in fenced code blocks", () => {
        expect(allCodeBlocks.length).toBeGreaterThan(0);
        const forbidden = [/\bprint-api-key\b/, /\bprint-bearer-token\b/, /(?:^|\s)--credentials(?:=|\s|$)/];
        for (const block of allCodeBlocks) {
            for (const pattern of forbidden) {
                expect(block).not.toMatch(pattern);
            }
        }
    });

    it("omits disallowed Pi approval and context flags in Pi code blocks", () => {
        expect(piCodeBlocks.length).toBeGreaterThan(0);
        const disallowed = [
            /(?:^|\s)--approve(?:=|\s|$)/,
            /(?:^|\s)--no-approve(?:=|\s|$)/,
            /(?:^|\s)--no-context-files(?:=|\s|$)/,
        ];
        for (const block of piCodeBlocks) {
            for (const pattern of disallowed) {
                expect(block).not.toMatch(pattern);
            }
        }
    });

    it("avoids hardcoded concrete provider model IDs in Pi code blocks", () => {
        for (const block of piCodeBlocks) {
            const joined = block.replace(/\\\r?\n/g, " ");
            expect(joined).not.toMatch(/(?:^|\s)--provider(?:=|\s|$)/);

            for (const match of joined.matchAll(/--model(?:=|\s+)(\S+)/g)) {
                expect(match[1]).toMatch(/^"?\$\{?PI_MODEL\}?"?$/);
            }

            for (const match of joined.matchAll(/\bPI_MODEL=([^\s;]+)/g)) {
                expect(match[1]).toContain("$");
            }
        }
    });

    it("keeps read-only tool restriction and --no-extensions in the Pi review example", () => {
        const reviewBlocks = piCodeBlocks.filter(
            (block) => block.includes("pi --print") && block.includes("--tools read,grep,find,ls"),
        );
        expect(reviewBlocks.length).toBeGreaterThanOrEqual(1);
        for (const block of reviewBlocks) {
            expect(block).toContain("--no-extensions");
            expect(block).toContain("--tools read,grep,find,ls");
        }
    });
});

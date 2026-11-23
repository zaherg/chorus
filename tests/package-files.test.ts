import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const collectTsFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...collectTsFiles(full));
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
            out.push(full);
        }
    }
    return out;
};

const packageImportName = (specifier: string): string | undefined => {
    if (
        specifier.startsWith(".") ||
        specifier.startsWith("@/") ||
        specifier.startsWith("node:") ||
        specifier.startsWith("bun:") ||
        specifier === "bun"
    ) {
        return undefined;
    }
    if (specifier.startsWith("@")) {
        const [scope, pkg] = specifier.split("/");
        return scope && pkg ? `${scope}/${pkg}` : undefined;
    }
    return specifier.split("/")[0];
};

describe("package files", () => {
    it("packs the CLI, skill installer, and no downloaded skill-local binaries", async () => {
        const destination = await mkdtemp(join(tmpdir(), "chorus-package-files-test-"));
        try {
            const archivePath = (
                await Bun.$`bun pm pack --destination ${destination} --ignore-scripts --quiet`.text()
            ).trim();
            const entries = (await Bun.$`tar -tzf ${archivePath}`.text()).split("\n");

            const packedPackage = JSON.parse(await Bun.$`tar -xOf ${archivePath} package/package.json`.text()) as {
                bin: unknown;
                scripts?: { prepack?: unknown };
            };

            expect(packedPackage.scripts?.prepack).toBe("bun run build");
            expect(packedPackage.bin).toEqual({ consensus: "dist/cli.js" });
            expect(entries).toContain("package/dist/cli.js");
            expect(entries).toContain("package/skills/consensus/SKILL.md");
            expect(entries).toContain("package/skills/consensus/scripts/install.sh");
            expect(entries).toContain("package/skills/delegate/SKILL.md");
            expect(entries.some((entry) => entry.includes("/bin/"))).toBe(false);
            expect(entries.some((entry) => entry.startsWith("package/dist/consensus-"))).toBe(false);
            expect(entries.some((entry) => entry.startsWith("package/skills/system/"))).toBe(false);
        } finally {
            await rm(destination, { recursive: true, force: true });
        }
    });

    it("declares no unused runtime dependencies in package.json", () => {
        const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
            dependencies?: Record<string, string>;
        };
        const declared = Object.keys(pkg.dependencies ?? {});
        const imported = new Set<string>();
        const importRe = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;

        for (const file of collectTsFiles(join(repoRoot, "src"))) {
            const source = readFileSync(file, "utf8");
            for (const match of source.matchAll(importRe)) {
                const pkgName = packageImportName(match[1] ?? "");
                if (pkgName) imported.add(pkgName);
            }
        }

        const unused = declared.filter((dep) => !imported.has(dep));
        expect(unused).toEqual([]);
    });

    it("verifies dist/cli.js via the shared release smoke-test script referenced by release.yml", async () => {
        const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
        const releaseWorkflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
        expect(releaseWorkflow).toContain("scripts/smoke-test-cli.ts");

        const smokeScript = join(repoRoot, "scripts/smoke-test-cli.ts");
        const cliDist = join(repoRoot, "dist/cli.js");
        const proc = Bun.spawn([process.execPath, smokeScript, cliDist, pkg.version], {
            cwd: repoRoot,
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);

        expect(exitCode, stderr).toBe(0);
        expect(stdout).toContain(`consensus ${pkg.version}`);
    });

    it("avoids process-global mock.module patching in test files", () => {
        const offenders: string[] = [];
        for (const file of collectTsFiles(join(repoRoot, "tests"))) {
            if (!file.endsWith(".test.ts")) continue;
            const source = readFileSync(file, "utf8");
            if (/\bmock\.module\s*\(/.test(source)) {
                offenders.push(relative(repoRoot, file));
            }
        }
        expect(offenders).toEqual([]);
    });
});

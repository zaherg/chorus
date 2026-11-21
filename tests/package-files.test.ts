import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("package files", () => {
    it("packs the CLI, skill installer, and no downloaded skill-local binaries", async () => {
        const destination = await mkdtemp(
            join(tmpdir(), "chorus-package-files-test-"),
        );
        try {
            const archivePath = (
                await Bun.$`bun pm pack --destination ${destination} --ignore-scripts --quiet`.text()
            ).trim();
            const entries = (await Bun.$`tar -tzf ${archivePath}`.text()).split(
                "\n",
            );

            const packedPackage = JSON.parse(
                await Bun.$`tar -xOf ${archivePath} package/package.json`.text(),
            ) as { bin: unknown };

            expect(entries).toContain("package/dist/cli.js");
            expect(packedPackage.bin).toEqual({ consensus: "dist/cli.js" });
            expect(entries).toContain(
                "package/skills/consensus/scripts/install.sh",
            );
            expect(entries.some((entry) => entry.includes("/bin/"))).toBe(
                false,
            );
        } finally {
            await rm(destination, { recursive: true, force: true });
        }
    });
});

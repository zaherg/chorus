import { describe, expect, it } from "bun:test";

import { runCli } from "@/cli";
import { captureOutput, captureStdout } from "./helpers";

describe("runCli", () => {
    it("exits 0 and prints version with --version", async () => {
        const { output, result: code } = await captureStdout(() =>
            runCli(["--version"]),
        );

        expect(code).toBe(0);
        expect(output.trim()).toMatch(/^consensus\s+\S+/);
    });

    it("exits 1 for unknown command", async () => {
        const { result: code, stdout } = await captureOutput(() =>
            runCli(["nonexistent-command"]),
        );

        expect(code).toBe(1);
        expect(stdout).toContain("USAGE:");
    });
});

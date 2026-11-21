import { describe, expect, it } from "bun:test";

import { runCli } from "@/cli";
import { captureOutput, captureStdout } from "./helpers";

describe("runCli", () => {
    it("exits 0 and prints version with --version and -v", async () => {
        for (const flag of ["--version", "-v"]) {
            const { output, result: code } = await captureStdout(() => runCli([flag]));
            expect(code).toBe(0);
            expect(output.trim()).toMatch(/^consensus\s+\S+/);
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
            expect(stdout).not.toContain("It make itself");
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

    it("exits 1 for unknown command", async () => {
        const { result: code, stdout } = await captureOutput(() => runCli(["nonexistent-command"]));

        expect(code).toBe(1);
        expect(stdout).toContain("USAGE:");
    });
});

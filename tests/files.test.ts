import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { embedFiles } from "@/utils/files";

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), "chorus-test-"));
});

afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

describe("embedFiles", () => {
    it("embeds a deduplicated file within an allowed path (tmpdir)", async () => {
        const filePath = resolve(tempDir, "test.txt");
        writeFileSync(filePath, "hello world");
        const result = await embedFiles([filePath, filePath]);
        expect(result.embedded_files).toEqual([realpathSync(filePath)]);
        expect(result.embedded_text).toContain("hello world");
        expect(result.embedded_text).toContain(`--- File: ${basename(filePath)} ---`);
        expect(result.skipped_files).toEqual([]);
        expect(result.total_tokens).toBeGreaterThan(0);
    });

    it("deduplicates symlink and path aliases pointing to the same real file", async () => {
        const targetPath = resolve(tempDir, "target.txt");
        const linkPath = resolve(tempDir, "alias.txt");
        writeFileSync(targetPath, "canonical content");
        symlinkSync(targetPath, linkPath);

        const result = await embedFiles([targetPath, linkPath]);
        expect(result.embedded_files).toEqual([realpathSync(targetPath)]);
        expect(result.skipped_files).toEqual([]);
        expect(result.embedded_text.match(/canonical content/g)?.length).toBe(1);
    });

    it("returns the empty result shape for empty input", async () => {
        expect(await embedFiles([])).toEqual({
            embedded_files: [],
            embedded_text: "",
            skipped_files: [],
            total_tokens: 0,
        });
    });

    it("skips non-existent files without duplicating resolved missing paths", async () => {
        const missingPath = resolve(tempDir, "nope.txt");
        const missingAlias = join(tempDir, ".", "nope.txt");
        const result = await embedFiles([missingPath, missingAlias]);
        expect(result.embedded_files).toEqual([]);
        expect(result.skipped_files).toEqual([missingPath]);
    });

    it("skips files outside allowed paths", async () => {
        const result = await embedFiles(["/etc/passwd"]);
        expect(result.embedded_files).toEqual([]);
        expect(result.skipped_files.length).toBeGreaterThan(0);
    });

    it("skips sensitive files while allowing safe env templates", async () => {
        const gitDir = resolve(tempDir, ".git");
        const sshDir = resolve(tempDir, ".ssh");
        const chorusConfigDir = resolve(tempDir, ".config", "chorus");
        mkdirSync(gitDir, { recursive: true });
        mkdirSync(sshDir, { recursive: true });
        mkdirSync(chorusConfigDir, { recursive: true });

        const sensitiveFiles = [
            resolve(tempDir, ".env"),
            resolve(tempDir, ".env.local"),
            resolve(gitDir, "config"),
            resolve(tempDir, ".git-credentials"),
            resolve(tempDir, "secret.pem"),
            resolve(tempDir, "private.key"),
            resolve(tempDir, "auth.json"),
            resolve(tempDir, ".credentials.json"),
            resolve(sshDir, "id_ed25519"),
            resolve(chorusConfigDir, "config.json"),
        ];

        for (const file of sensitiveFiles) {
            writeFileSync(file, "TOP_SECRET=12345");
        }

        const safeExample = resolve(tempDir, ".env.example");
        const safeSample = resolve(tempDir, ".env.sample");
        const safeTemplate = resolve(tempDir, ".env.template");
        writeFileSync(safeExample, "API_KEY=your-key-here");
        writeFileSync(safeSample, "API_KEY=sample-key");
        writeFileSync(safeTemplate, "API_KEY=template-key");

        const result = await embedFiles([...sensitiveFiles, safeExample, safeSample, safeTemplate]);
        expect(result.embedded_files).toEqual([
            realpathSync(safeExample),
            realpathSync(safeSample),
            realpathSync(safeTemplate),
        ]);
        expect(result.skipped_files).toEqual(sensitiveFiles.map((file) => realpathSync(file)));
        expect(result.embedded_text).not.toContain("TOP_SECRET=12345");
        expect(result.embedded_text).toContain("API_KEY=your-key-here");
    });

    it("skips a benign symlink pointing to a sensitive file", async () => {
        const envPath = resolve(tempDir, ".env");
        const benignLink = resolve(tempDir, "notes.txt");
        writeFileSync(envPath, "SECRET_TOKEN=abc");
        symlinkSync(envPath, benignLink);

        const result = await embedFiles([benignLink]);
        expect(result.embedded_files).toEqual([]);
        expect(result.skipped_files).toEqual([realpathSync(envPath)]);
        expect(result.embedded_text).toBe("");
    });

    it("skips binary files containing NUL bytes", async () => {
        const binaryPath = resolve(tempDir, "image.dat");
        writeFileSync(binaryPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a]));

        const result = await embedFiles([binaryPath]);
        expect(result.embedded_files).toEqual([]);
        expect(result.skipped_files).toEqual([realpathSync(binaryPath)]);
        expect(result.embedded_text).toBe("");
    });

    it("skips oversized files over 1 MiB without embedding", async () => {
        const oversizedPath = resolve(tempDir, "oversized.txt");
        writeFileSync(oversizedPath, "a".repeat(1024 * 1024 + 1));

        const result = await embedFiles([oversizedPath], 512_000);
        expect(result.embedded_files).toEqual([]);
        expect(result.skipped_files).toEqual([realpathSync(oversizedPath)]);
        expect(result.embedded_text).toBe("");
    });

    it("skips non-regular files such as directories", async () => {
        const subDir = resolve(tempDir, "subdir");
        mkdirSync(subDir);

        const result = await embedFiles([subDir]);
        expect(result.embedded_files).toEqual([]);
        expect(result.skipped_files).toEqual([realpathSync(subDir)]);
    });

    it("uses a project-relative header path when the file is under cwd", async () => {
        const nestedDir = resolve(tempDir, "src");
        const nestedFile = resolve(nestedDir, "app.ts");
        mkdirSync(nestedDir, { recursive: true });
        writeFileSync(nestedFile, "export const value = 42;\n");

        const originalCwd = process.cwd();
        try {
            process.chdir(tempDir);
            const result = await embedFiles(["src/app.ts"]);
            expect(result.embedded_files).toEqual([realpathSync(nestedFile)]);
            expect(result.skipped_files).toEqual([]);
            expect(result.embedded_text).toContain("--- File: src/app.ts ---\nexport const value = 42;");
        } finally {
            process.chdir(originalCwd);
        }
    });

    it("rejects filesystem root as an implicit cwd allowlist root", async () => {
        const tmpFile = resolve(tempDir, "allowed.txt");
        writeFileSync(tmpFile, "still allowed via tmpdir");

        const originalCwd = process.cwd();
        try {
            process.chdir("/");
            const result = await embedFiles(["/etc/passwd", tmpFile]);
            expect(result.embedded_files).toEqual([realpathSync(tmpFile)]);
            expect(result.skipped_files).toEqual([realpathSync("/etc/passwd")]);
        } finally {
            process.chdir(originalCwd);
        }
    });

    it("supports explicit allowedRoots option override", async () => {
        const allowedSubDir = resolve(tempDir, "allowed");
        const otherSubDir = resolve(tempDir, "other");
        mkdirSync(allowedSubDir, { recursive: true });
        mkdirSync(otherSubDir, { recursive: true });

        const allowedFile = resolve(allowedSubDir, "ok.txt");
        const blockedFile = resolve(otherSubDir, "blocked.txt");
        writeFileSync(allowedFile, "allowed content");
        writeFileSync(blockedFile, "blocked content");

        const result = await embedFiles([allowedFile, blockedFile], undefined, {
            allowedRoots: [allowedSubDir],
        });
        expect(result.embedded_files).toEqual([realpathSync(allowedFile)]);
        expect(result.skipped_files).toEqual([realpathSync(blockedFile)]);
    });

    it("scales the token budget with the provided model context window", async () => {
        const filePath = resolve(tempDir, "big.txt");
        // ~20k tokens: exceeds the 4k minimum budget for an 8k window,
        // but fits the 50k ceiling used for large windows.
        writeFileSync(filePath, "token ".repeat(20_000));

        const smallWindow = await embedFiles([filePath], 8_000);
        expect(smallWindow.embedded_files).toEqual([]);
        expect(smallWindow.skipped_files).toEqual([realpathSync(filePath)]);

        const largeWindow = await embedFiles([filePath], 512_000);
        expect(largeWindow.embedded_files).toEqual([realpathSync(filePath)]);
        expect(largeWindow.skipped_files).toEqual([]);
    });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { embedFiles } from "@/utils/files";

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), "chorus-test-"));
});

afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

describe("embedFiles", () => {
    it("embeds a file within an allowed path (tmpdir)", async () => {
        const filePath = resolve(tempDir, "test.txt");
        writeFileSync(filePath, "hello world");
        const result = await embedFiles([filePath]);
        expect(result.embedded_files).toEqual([realpathSync(filePath)]);
        expect(result.embedded_text).toContain("hello world");
        expect(result.skipped_files).toEqual([]);
        expect(result.total_tokens).toBeGreaterThan(0);
    });

    it("skips non-existent files", async () => {
        const result = await embedFiles([resolve(tempDir, "nope.txt")]);
        expect(result.embedded_files).toEqual([]);
        expect(result.skipped_files).toEqual([resolve(tempDir, "nope.txt")]);
    });

    it("skips files outside allowed paths", async () => {
        const result = await embedFiles(["/etc/passwd"]);
        expect(result.embedded_files).toEqual([]);
        expect(result.skipped_files.length).toBeGreaterThan(0);
    });

    it("deduplicates paths", async () => {
        const filePath = resolve(tempDir, "dup.txt");
        writeFileSync(filePath, "dup content");
        const result = await embedFiles([filePath, filePath]);
        expect(result.embedded_files).toEqual([realpathSync(filePath)]);
    });

    it("returns empty result for empty input", async () => {
        const result = await embedFiles([]);
        expect(result.embedded_files).toEqual([]);
        expect(result.embedded_text).toBe("");
        expect(result.total_tokens).toBe(0);
    });
});

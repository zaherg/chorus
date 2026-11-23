import { afterEach, describe, expect, test } from "bun:test";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    appendPrivateFileNoFollow,
    assertNoSymlinkSegments,
    ensurePrivateMode,
    isErrnoException,
    openPrivateAppendNoFollow,
    PRIVATE_DIR_MODE,
    PRIVATE_FILE_MODE,
    readPrivateFileNoFollow,
    writePrivateFileAtomic,
    writePrivateFileExclusive,
} from "@/utils/private-fs";

const isPosix = process.platform !== "win32";

const tempDirs: string[] = [];

const makeTempDir = (prefix = "chorus-private-fs-"): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
};

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            rmSync(dir, { force: true, recursive: true });
        }
    }
});

describe("private-fs", () => {
    describe("readPrivateFileNoFollow and openPrivateAppendNoFollow", () => {
        test("reject a directory as a non-regular file", () => {
            const rootDir = makeTempDir();
            const subDir = join(rootDir, "subdir");
            mkdirSync(subDir);

            expect(() => readPrivateFileNoFollow(subDir, { rootDir })).toThrow("Refusing to read non-regular file");
            expect(() => openPrivateAppendNoFollow(subDir)).toThrow();

            if (isPosix) {
                expect(() => openPrivateAppendNoFollow("/dev/null")).toThrow("Refusing to append to non-regular file");
            }
        });
    });

    describe("appendPrivateFileNoFollow", () => {
        test("appends both string and Uint8Array payloads and enforces 0600 mode on POSIX", () => {
            const rootDir = makeTempDir();
            const filePath = join(rootDir, "events.log");

            writeFileSync(filePath, "", { mode: 0o644 });
            if (isPosix) {
                chmodSync(filePath, 0o644);
            }

            appendPrivateFileNoFollow(filePath, "first-line\n");
            appendPrivateFileNoFollow(filePath, new TextEncoder().encode("second-line\n"));

            expect(readFileSync(filePath, "utf-8")).toBe("first-line\nsecond-line\n");
            if (isPosix) {
                expect(statSync(filePath).mode & 0o777).toBe(PRIVATE_FILE_MODE);
            }
        });
    });

    describe("writePrivateFileAtomic", () => {
        test("repairs multi-level intermediate directory permissions to 0700", () => {
            const rootDir = makeTempDir();
            const level1 = join(rootDir, "nested");
            const level2 = join(level1, "deeper");
            mkdirSync(level2, { recursive: true });
            if (isPosix) {
                chmodSync(level1, 0o755);
                chmodSync(level2, 0o755);
            }

            const filePath = join(level2, "state.json");
            writePrivateFileAtomic(filePath, '{"ok":true}', { rootDir });

            expect(readFileSync(filePath, "utf-8")).toBe('{"ok":true}');
            if (isPosix) {
                expect(statSync(level1).mode & 0o777).toBe(PRIVATE_DIR_MODE);
                expect(statSync(level2).mode & 0o777).toBe(PRIVATE_DIR_MODE);
                expect(statSync(filePath).mode & 0o777).toBe(PRIVATE_FILE_MODE);
            }
        });

        test("cleans up temp file when rename fails because target is an existing directory", () => {
            const rootDir = makeTempDir();
            const targetDir = join(rootDir, "existing-dir");
            mkdirSync(targetDir);
            writeFileSync(join(targetDir, "keep.txt"), "keep");

            expect(() =>
                writePrivateFileAtomic(targetDir, "replacement", { rootDir, tempSuffix: ".atomic" }),
            ).toThrow();
            expect(readdirSync(rootDir)).toEqual(["existing-dir"]);
        });
    });

    describe("writePrivateFileExclusive", () => {
        test("returns false on EEXIST, repairs mode, and rethrows non-EEXIST errors", () => {
            const rootDir = makeTempDir();
            const filePath = join(rootDir, "exclusive.txt");

            expect(writePrivateFileExclusive(filePath, "initial")).toBeTrue();
            expect(readFileSync(filePath, "utf-8")).toBe("initial");

            if (isPosix) {
                chmodSync(filePath, 0o644);
            }

            expect(writePrivateFileExclusive(filePath, "overwrite")).toBeFalse();
            expect(readFileSync(filePath, "utf-8")).toBe("initial");
            if (isPosix) {
                expect(statSync(filePath).mode & 0o777).toBe(PRIVATE_FILE_MODE);
            }

            let thrown: unknown;
            try {
                writePrivateFileExclusive(join(rootDir, "missing-parent", "exclusive.txt"), "data");
            } catch (err) {
                thrown = err;
            }
            expect(isErrnoException(thrown)).toBeTrue();
            if (isErrnoException(thrown)) {
                expect(thrown.code).toBe("ENOENT");
            }
        });
    });

    describe("ensurePrivateMode", () => {
        test("invokes onError when path permissions cannot be inspected or updated", () => {
            if (!isPosix) {
                return;
            }

            const rootDir = makeTempDir();
            const missingPath = join(rootDir, "does-not-exist");
            let capturedError: unknown;

            ensurePrivateMode(missingPath, PRIVATE_FILE_MODE, (err) => {
                capturedError = err;
            });

            expect(isErrnoException(capturedError)).toBeTrue();
            if (isErrnoException(capturedError)) {
                expect(capturedError.code).toBe("ENOENT");
            }
        });
    });

    describe("assertNoSymlinkSegments", () => {
        test("rejects targetPath equal to rootDir and symlink intermediate segments", () => {
            const rootDir = makeTempDir();
            const outsideDir = makeTempDir("chorus-private-fs-outside-");

            expect(() => assertNoSymlinkSegments(rootDir, rootDir)).toThrow("Path escapes private storage root");

            const symlinkDir = join(rootDir, "linked-dir");
            symlinkSync(outsideDir, symlinkDir);

            expect(() => assertNoSymlinkSegments(rootDir, join(symlinkDir, "secret.json"))).toThrow(
                "Refusing to follow symlink inside private storage",
            );

            const validDir = join(rootDir, "safe");
            mkdirSync(validDir);
            expect(() => assertNoSymlinkSegments(rootDir, join(validDir, "new-file.json"))).not.toThrow();
        });
    });
});

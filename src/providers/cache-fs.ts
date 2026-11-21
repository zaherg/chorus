import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { getErrorMessage } from "@/utils/helpers";
import type { FileReader, FileWriter } from "./model-catalog";

/**
 * Resolves a relative cache path confined within `configDir`. Rejects absolute
 * paths, null bytes, and any traversal that escapes `configDir`.
 */
export const resolveCachePath = (configDir: string, relativePath: string): string => {
    if (relativePath.includes("\0")) {
        throw new Error(`Invalid cache path: ${relativePath}`);
    }
    if (isAbsolute(relativePath)) {
        throw new Error(`Cache path must be relative to configDir: ${relativePath}`);
    }
    const root = resolve(configDir);
    const resolved = resolve(root, relativePath);
    const rel = relative(root, resolved);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`Cache path escapes configDir: ${relativePath}`);
    }
    return resolved;
};

/**
 * Builds a production `FileReader` that reads from the local filesystem
 * under `configDir`. Missing files return `{ ok: false, code: "missing" }`;
 * any other I/O error returns `{ ok: false, code: "io_error" }`.
 *
 * Assumes the system clock is reasonably accurate (file timestamps and
 * stored `fetched_at`/`expires_at` values are compared against it).
 * Clock drift in containerized environments can skew stale-while-revalidate
 * behavior (treating fresh data as stale or vice versa).
 */
export const makeLocalFileReader = (configDir: string): FileReader => {
    return (path) => {
        const absolute = resolveCachePath(configDir, path);
        try {
            return { ok: true, text: readFileSync(absolute, "utf-8") };
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ENOENT") {
                return { ok: false, code: "missing" };
            }
            return { ok: false, code: "io_error" };
        }
    };
};

/**
 * Builds a production `FileWriter` that writes to the local filesystem
 * under `configDir` using an atomic temp+rename sequence. The default file
 * mode is `0o600`; the default temp suffix is `.tmp`.
 */
export const makeLocalFileWriter = (configDir: string): FileWriter => {
    return (path, content, options) => {
        const absolute = resolveCachePath(configDir, path);
        let tempPath: string | undefined;
        try {
            mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
            const tempSuffix = options?.tempSuffix ?? ".tmp";
            tempPath = `${absolute}${tempSuffix}.${process.pid}.${randomBytes(6).toString("hex")}`;
            writeFileSync(tempPath, content, {
                flag: "wx",
                mode: options?.mode ?? 0o600,
            });
            renameSync(tempPath, absolute);
            return { ok: true };
        } catch (err) {
            const errCode = (err as NodeJS.ErrnoException).code;
            if (tempPath !== undefined && errCode !== "EEXIST") {
                try {
                    unlinkSync(tempPath);
                } catch (unlinkErr) {
                    const unlinkCode = (unlinkErr as NodeJS.ErrnoException).code;
                    if (unlinkCode !== "ENOENT") {
                        // Ignore secondary cleanup failure so the primary I/O error is returned.
                    }
                }
            }
            return {
                ok: false,
                code: "io_error",
                message: getErrorMessage(err),
            };
        }
    };
};

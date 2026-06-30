import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { getErrorMessage } from "@/utils";
import type { FileReader, FileWriter } from "./model-catalog";

/**
 * Resolves a cache path against a config directory. Absolute paths are
 * returned unchanged; relative paths are joined onto `configDir`.
 */
const resolveCachePath = (configDir: string, path: string): string => {
    if (isAbsolute(path)) {
        return path;
    }
    return resolve(configDir, path);
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
        try {
            mkdirSync(dirname(absolute), { recursive: true });
            const tempSuffix = options?.tempSuffix ?? ".tmp";
            const tempPath = `${absolute}${tempSuffix}`;
            writeFileSync(tempPath, content, {
                mode: options?.mode ?? 0o600,
            });
            renameSync(tempPath, absolute);
            return { ok: true };
        } catch (err) {
            return {
                ok: false,
                code: "io_error",
                message: getErrorMessage(err),
            };
        }
    };
};

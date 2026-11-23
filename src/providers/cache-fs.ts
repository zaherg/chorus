import { getErrorMessage } from "@/utils/helpers";
import {
    isErrnoException,
    readPrivateFileNoFollow,
    resolveConfinedPath,
    writePrivateFileAtomic,
} from "@/utils/private-fs";
import type { FileReader, FileWriter } from "./model-catalog";

/**
 * Resolves a relative cache path confined within `configDir`. Rejects absolute
 * paths, null bytes, and any traversal that escapes `configDir`.
 */
export const resolveCachePath = (configDir: string, relativePath: string): string => {
    return resolveConfinedPath(configDir, relativePath, "Cache path");
};

/**
 * Builds a `FileReader` bound to `configDir` that refuses to follow symlinks.
 *
 * Returns `{ ok: true, text }` on success, `{ ok: false, code: "missing" }` on
 * `ENOENT`, and `{ ok: false, code: "io_error" }` on symlink escapes or other
 * I/O failures.
 */
export const makeLocalFileReader = (configDir: string): FileReader => {
    return (path) => {
        const absolute = resolveCachePath(configDir, path);
        try {
            return { ok: true, text: readPrivateFileNoFollow(absolute, { rootDir: configDir }) };
        } catch (err) {
            if (isErrnoException(err) && err.code === "ENOENT") {
                return { ok: false, code: "missing" };
            }
            return { ok: false, code: "io_error" };
        }
    };
};

/**
 * Builds an atomic `FileWriter` bound to `configDir`. Ensures `0700` cache
 * directories, rejects symlink escapes, stages via a unique `wx` temp file,
 * and renames into place.
 */
export const makeLocalFileWriter = (configDir: string): FileWriter => {
    return (path, content, options) => {
        const absolute = resolveCachePath(configDir, path);
        try {
            writePrivateFileAtomic(absolute, content, {
                mode: options?.mode,
                tempSuffix: options?.tempSuffix,
                rootDir: configDir,
            });
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

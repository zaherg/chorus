import { randomBytes } from "node:crypto";
import {
    chmodSync,
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    realpathSync,
    renameSync,
    unlinkSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const supportsPosixModes = process.platform !== "win32";
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export const isErrnoException = (err: unknown): err is NodeJS.ErrnoException => {
    return err instanceof Error && "code" in err;
};

const isWithinRoot = (root: string, target: string): boolean => {
    const rel = relative(root, target);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Resolves a relative path confined within `rootDir`. Rejects null bytes,
 * absolute paths, and lexical traversal that escapes `rootDir`.
 */
export const resolveConfinedPath = (rootDir: string, relativePath: string, label = "Path"): string => {
    if (relativePath.includes("\0")) {
        throw new Error(`Invalid ${label.toLowerCase()}: ${relativePath}`);
    }
    if (isAbsolute(relativePath)) {
        throw new Error(`${label} must be relative to configDir: ${relativePath}`);
    }
    const root = resolve(rootDir);
    const resolved = resolve(root, relativePath);
    const rel = relative(root, resolved);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`${label} escapes configDir: ${relativePath}`);
    }
    return resolved;
};

/**
 * Verifies that no existing path segment below `rootDir` up to `targetPath` is
 * a symlink, and that existing ancestors remain inside `realpath(rootDir)`.
 */
export const assertNoSymlinkSegments = (rootDir: string, targetPath: string): void => {
    const root = resolve(rootDir);
    const target = resolve(targetPath);
    const rel = relative(root, target);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`Path escapes private storage root: ${targetPath}`);
    }

    let rootReal: string | undefined;
    try {
        rootReal = realpathSync(root);
    } catch (err) {
        if (isErrnoException(err) && err.code === "ENOENT") {
            return;
        }
        throw err;
    }

    let current = root;
    let deepestExisting = root;
    for (const segment of rel.split(sep).filter(Boolean)) {
        current = resolve(current, segment);
        try {
            const st = lstatSync(current);
            if (st.isSymbolicLink()) {
                throw new Error(`Refusing to follow symlink inside private storage: ${current}`);
            }
            deepestExisting = current;
        } catch (err) {
            if (isErrnoException(err) && err.code === "ENOENT") {
                break;
            }
            throw err;
        }
    }

    const deepestReal = realpathSync(deepestExisting);
    if (!isWithinRoot(rootReal, deepestReal)) {
        throw new Error(`Resolved path escapes private storage root: ${targetPath}`);
    }
};

export interface PrivateModeOptions {
    mode?: number;
    onError?: (err: unknown) => void;
}

/**
 * Ensures a non-symlink path has exact POSIX permissions. Symlinks are left
 * untouched so caller-managed dotfile symlinks do not mutate target modes.
 */
export const ensurePrivateMode = (path: string, mode: number, onError?: (err: unknown) => void): void => {
    if (!supportsPosixModes) return;

    try {
        const st = lstatSync(path);
        if (st.isSymbolicLink()) return;
        if ((st.mode & 0o777) !== mode) {
            chmodSync(path, mode);
        }
    } catch (err) {
        onError?.(err);
    }
};

/**
 * Creates `dirPath` recursively with `0700` and repairs pre-existing directory
 * permissions when too permissive.
 */
export const ensurePrivateDir = (dirPath: string, options: PrivateModeOptions = {}): void => {
    const mode = options.mode ?? PRIVATE_DIR_MODE;
    mkdirSync(dirPath, { recursive: true, mode });
    ensurePrivateMode(dirPath, mode, options.onError);
};

/**
 * Repairs an existing non-symlink file to `0600` (or the requested mode).
 */
export const ensurePrivateFile = (filePath: string, options: PrivateModeOptions = {}): void => {
    const mode = options.mode ?? PRIVATE_FILE_MODE;
    ensurePrivateMode(filePath, mode, options.onError);
};

/**
 * Atomically creates a private file only if it does not already exist (`wx`).
 * Repairs permissions whether newly created or pre-existing (skipping symlinks).
 * Returns `true` if the file was created, or `false` if it already existed.
 */
export const writePrivateFileExclusive = (
    filePath: string,
    content: string | Uint8Array,
    options: PrivateModeOptions = {},
): boolean => {
    const mode = options.mode ?? PRIVATE_FILE_MODE;
    try {
        writeFileSync(filePath, content, { flag: "wx", mode });
    } catch (err) {
        if (isErrnoException(err) && err.code === "EEXIST") {
            ensurePrivateFile(filePath, { mode, onError: options.onError });
            return false;
        }
        throw err;
    }

    ensurePrivateFile(filePath, { mode, onError: options.onError });
    return true;
};

const rejectSymlinkWhenNoFollowUnavailable = (filePath: string): void => {
    if (O_NOFOLLOW !== 0) return;
    try {
        if (lstatSync(filePath).isSymbolicLink()) {
            throw new Error(`Refusing to follow symlink: ${filePath}`);
        }
    } catch (err) {
        if (isErrnoException(err) && err.code === "ENOENT") {
            return;
        }
        throw err;
    }
};

/**
 * Reads a UTF-8 regular file without following symlinks (`O_NOFOLLOW`).
 * When `rootDir` is provided, also checks all ancestor segments inside `rootDir`.
 */
export const readPrivateFileNoFollow = (filePath: string, options: { rootDir?: string } = {}): string => {
    if (options.rootDir !== undefined) {
        assertNoSymlinkSegments(options.rootDir, filePath);
    }
    rejectSymlinkWhenNoFollowUnavailable(filePath);

    const fd = openSync(filePath, constants.O_RDONLY | O_NOFOLLOW);
    try {
        if (!fstatSync(fd).isFile()) {
            throw new Error(`Refusing to read non-regular file: ${filePath}`);
        }
        return readFileSync(fd, "utf-8");
    } finally {
        closeSync(fd);
    }
};

export interface AtomicWriteOptions {
    mode?: number;
    tempSuffix?: string;
    rootDir?: string;
}

/**
 * Atomically writes a private file via a unique `wx` temp file and `renameSync`,
 * ensuring `0700` parent directories, `0600` file mode, and no symlink escapes.
 */
export const writePrivateFileAtomic = (
    filePath: string,
    content: string | Uint8Array,
    options: AtomicWriteOptions = {},
): void => {
    const mode = options.mode ?? PRIVATE_FILE_MODE;
    const tempSuffix = options.tempSuffix ?? ".tmp";

    if (options.rootDir !== undefined) {
        assertNoSymlinkSegments(options.rootDir, filePath);
    }

    const parentDir = dirname(filePath);
    ensurePrivateDir(parentDir);

    if (options.rootDir !== undefined) {
        // Also repair any intermediate directories inside rootDir.
        const root = resolve(options.rootDir);
        const relParent = relative(root, resolve(parentDir));
        if (relParent && relParent !== "." && !relParent.startsWith(`..${sep}`) && !isAbsolute(relParent)) {
            let current = root;
            for (const segment of relParent.split(sep).filter(Boolean)) {
                current = resolve(current, segment);
                ensurePrivateMode(current, PRIVATE_DIR_MODE);
            }
        }
        assertNoSymlinkSegments(options.rootDir, filePath);
    }

    try {
        if (lstatSync(filePath).isSymbolicLink()) {
            throw new Error(`Refusing to overwrite symlink: ${filePath}`);
        }
    } catch (err) {
        if (!(isErrnoException(err) && err.code === "ENOENT")) {
            throw err;
        }
    }

    const tempPath = `${filePath}${tempSuffix}.${process.pid}.${randomBytes(6).toString("hex")}`;
    try {
        writeFileSync(tempPath, content, { flag: "wx", mode });
        ensurePrivateFile(tempPath, { mode });
        renameSync(tempPath, filePath);
    } catch (err) {
        const errCode = isErrnoException(err) ? err.code : undefined;
        if (errCode !== "EEXIST") {
            try {
                unlinkSync(tempPath);
            } catch (unlinkErr) {
                if (!(isErrnoException(unlinkErr) && unlinkErr.code === "ENOENT")) {
                    // Ignore secondary cleanup failure so the primary I/O error is rethrown.
                }
            }
        }
        throw err;
    }
};

/**
 * Opens a private regular file for append without following symlinks (`O_NOFOLLOW`).
 */
export const openPrivateAppendNoFollow = (filePath: string, mode = PRIVATE_FILE_MODE): number => {
    rejectSymlinkWhenNoFollowUnavailable(filePath);

    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | O_NOFOLLOW;
    const fd = openSync(filePath, flags, mode);
    try {
        if (!fstatSync(fd).isFile()) {
            throw new Error(`Refusing to append to non-regular file: ${filePath}`);
        }
        return fd;
    } catch (err) {
        closeSync(fd);
        throw err;
    }
};

/**
 * Ensures a private file exists (without following symlinks) and has `0600` mode.
 */
export const touchPrivateFileNoFollow = (filePath: string, mode = PRIVATE_FILE_MODE): void => {
    const fd = openPrivateAppendNoFollow(filePath, mode);
    closeSync(fd);
    ensurePrivateFile(filePath, { mode });
};

/**
 * Appends data to a private regular file without following symlinks and ensures `0600` mode.
 */
export const appendPrivateFileNoFollow = (
    filePath: string,
    content: string | Uint8Array,
    mode = PRIVATE_FILE_MODE,
): void => {
    const fd = openPrivateAppendNoFollow(filePath, mode);
    try {
        if (typeof content === "string") {
            writeSync(fd, content);
        } else {
            writeSync(fd, content);
        }
    } finally {
        closeSync(fd);
    }
    ensurePrivateFile(filePath, { mode });
};

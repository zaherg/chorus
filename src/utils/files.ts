import { constants, realpathSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { EmbeddedFileResult } from "@/types/files";
import { estimateTokenCount } from "@/utils/helpers";
import { logger } from "./logger";

const MAX_EMBEDDED_FILE_TOKENS = 50_000;
const MAX_EMBEDDED_FILE_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8_192;
const READ_CHUNK_BYTES = 64 * 1024;

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const SENSITIVE_DIR_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", ".kube"]);
const SENSITIVE_GIT_ENTRIES = new Set(["config", "credentials", "git-credentials", "netrc"]);
const SENSITIVE_BASENAMES = new Set([
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    "auth.json",
    ".credentials.json",
    "credentials.json",
    "id_rsa",
    "id_ed25519",
]);
const SENSITIVE_BASENAME_PREFIXES = ["id_rsa.", "id_ed25519.", "id_ecdsa", "id_dsa"];
const SENSITIVE_EXTENSIONS = [".pem", ".key", ".p12", ".pfx"];
const SAFE_ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);

export interface EmbedFilesOptions {
    allowedRoots?: string[];
}

const resolveRealDir = (dir: string): string | undefined => {
    try {
        return realpathSync(dir);
    } catch {
        return undefined;
    }
};

const isSafeImplicitCwd = (root: string, homeReal?: string): boolean => dirname(root) !== root && root !== homeReal;

const resolveAllowedRoots = (options?: EmbedFilesOptions): { allowedRoots: string[]; safeCwdReal?: string } => {
    const cwdReal = resolveRealDir(process.cwd());
    const homeReal = resolveRealDir(homedir());
    const safeCwdReal = cwdReal && isSafeImplicitCwd(cwdReal, homeReal) ? cwdReal : undefined;

    if (options?.allowedRoots !== undefined) {
        const roots = new Set<string>();
        for (const root of options.allowedRoots) {
            const realRoot = resolveRealDir(root);
            if (realRoot) {
                roots.add(realRoot);
            }
        }
        return { allowedRoots: [...roots], safeCwdReal };
    }

    const roots = new Set<string>();
    if (safeCwdReal) {
        roots.add(safeCwdReal);
    } else if (cwdReal) {
        logger?.warn(`Skipping unsafe implicit working directory root: ${cwdReal}`);
    }

    const tmpReal = resolveRealDir(tmpdir());
    if (tmpReal) {
        roots.add(tmpReal);
    }

    return { allowedRoots: [...roots], safeCwdReal };
};

const isPathWithinRoot = (root: string, target: string): boolean => {
    // Use path.relative instead of string-prefix matching for cross-platform
    // safety (Bun on Windows emits `\\` from realpath).
    const rel = relative(root, target);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const isAllowedPath = (realPath: string, allowedRoots: string[]): boolean => {
    for (const root of allowedRoots) {
        if (isPathWithinRoot(root, realPath)) {
            return true;
        }
    }
    return false;
};

const isSensitivePath = (filePath: string): boolean => {
    const normalized = filePath.replace(/\\/g, "/").toLowerCase();
    const segments = normalized.split("/").filter(Boolean);
    const base = segments.at(-1) ?? "";

    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        if (!segment) continue;
        if (SENSITIVE_DIR_SEGMENTS.has(segment)) {
            return true;
        }
        if (segment === ".config" && segments[i + 1] === "chorus") {
            return true;
        }
        if (
            segment === ".git" &&
            (SENSITIVE_GIT_ENTRIES.has(segments[i + 1] ?? "") || SENSITIVE_GIT_ENTRIES.has(base))
        ) {
            return true;
        }
    }

    if (SENSITIVE_BASENAMES.has(base)) {
        return true;
    }

    if (SENSITIVE_BASENAME_PREFIXES.some((prefix) => base.startsWith(prefix))) {
        return true;
    }

    if (SENSITIVE_EXTENSIONS.some((ext) => base.endsWith(ext))) {
        return true;
    }

    if (base === ".env" || (base.startsWith(".env.") && !SAFE_ENV_TEMPLATES.has(base))) {
        return true;
    }

    return false;
};

const formatDisplayPath = (realPath: string, safeCwdReal?: string): string => {
    if (safeCwdReal && isPathWithinRoot(safeCwdReal, realPath)) {
        const rel = relative(safeCwdReal, realPath);
        if (rel !== "") {
            return rel;
        }
    }
    return basename(realPath);
};

type BoundedReadResult = { ok: true; content: string } | { ok: false; reason: "too_large" | "binary" };

const readBoundedTextFile = async (
    fh: FileHandle,
    expectedSize: number,
    maxBytes: number,
): Promise<BoundedReadResult> => {
    const chunks: Buffer[] = [];
    let totalRead = 0;

    while (totalRead <= maxBytes) {
        const remaining = maxBytes + 1 - totalRead;
        const toRead =
            totalRead === 0 && expectedSize > 0
                ? Math.min(expectedSize + 1, READ_CHUNK_BYTES, remaining)
                : Math.min(READ_CHUNK_BYTES, remaining);
        const chunk = Buffer.allocUnsafe(toRead);
        const { bytesRead } = await fh.read(chunk, 0, toRead, totalRead);
        if (bytesRead === 0) {
            break;
        }

        const slice = bytesRead === toRead ? chunk : chunk.subarray(0, bytesRead);
        if (totalRead < BINARY_SNIFF_BYTES) {
            const sniffLength = Math.min(slice.length, BINARY_SNIFF_BYTES - totalRead);
            if (slice.subarray(0, sniffLength).includes(0)) {
                return { ok: false, reason: "binary" };
            }
        }

        totalRead += bytesRead;
        if (totalRead > maxBytes) {
            return { ok: false, reason: "too_large" };
        }

        chunks.push(slice);
    }

    const buffer = chunks.length === 1 && chunks[0] ? chunks[0] : Buffer.concat(chunks, totalRead);
    return { ok: true, content: buffer.subarray(0, totalRead).toString("utf8") };
};

export const embedFiles = async (
    paths: string[],
    modelContextWindow?: number,
    options?: EmbedFilesOptions,
): Promise<EmbeddedFileResult> => {
    const { allowedRoots, safeCwdReal } = resolveAllowedRoots(options);
    const seenAbsPaths = new Set<string>();
    const seenRealPaths = new Set<string>();
    const embeddedFiles: string[] = [];
    const skippedFiles: string[] = [];
    const embeddedChunks: string[] = [];
    let totalTokens = 0;

    const maxTokens = Math.min(
        MAX_EMBEDDED_FILE_TOKENS,
        Math.max(4_000, Math.floor((modelContextWindow ?? 128_000) * 0.4)),
    );

    for (const rawPath of paths) {
        const absPath = resolve(process.cwd(), rawPath);
        if (seenAbsPaths.has(absPath)) {
            continue;
        }
        seenAbsPaths.add(absPath);

        let realPath: string;
        try {
            realPath = await realpath(absPath);
        } catch {
            skippedFiles.push(absPath);
            logger?.warn(`File not found: ${absPath}`);
            continue;
        }

        if (seenRealPaths.has(realPath)) {
            continue;
        }
        seenRealPaths.add(realPath);

        if (!isAllowedPath(realPath, allowedRoots)) {
            skippedFiles.push(realPath);
            logger?.warn(`File outside allowed paths: ${realPath}`);
            continue;
        }

        if (isSensitivePath(absPath) || isSensitivePath(realPath)) {
            skippedFiles.push(realPath);
            logger?.warn(`Sensitive file skipped: ${realPath}`);
            continue;
        }

        let fh: FileHandle;
        try {
            fh = await open(realPath, OPEN_FLAGS);
        } catch {
            skippedFiles.push(realPath);
            logger?.warn(`Cannot open file: ${realPath}`);
            continue;
        }

        let content: string;
        try {
            const stats = await fh.stat();
            if (!stats.isFile()) {
                skippedFiles.push(realPath);
                logger?.warn(`Not a regular file: ${realPath}`);
                continue;
            }

            const maxBytes = Math.min(MAX_EMBEDDED_FILE_BYTES, Math.max(0, (maxTokens - totalTokens) * 12 + 16));
            if (stats.size > maxBytes) {
                skippedFiles.push(realPath);
                logger?.warn(`File skipped (too large): ${realPath} (${stats.size} bytes, max ${maxBytes})`);
                continue;
            }

            const readResult = await readBoundedTextFile(fh, stats.size, maxBytes);
            if (!readResult.ok) {
                skippedFiles.push(realPath);
                if (readResult.reason === "binary") {
                    logger?.warn(`Binary file skipped: ${realPath}`);
                } else {
                    logger?.warn(`File skipped (too large): ${realPath} (exceeded ${maxBytes} bytes while reading)`);
                }
                continue;
            }
            content = readResult.content;
        } catch {
            skippedFiles.push(realPath);
            logger?.warn(`Cannot read file: ${realPath}`);
            continue;
        } finally {
            await fh.close().catch(() => {});
        }

        const tokenCount = estimateTokenCount(content);

        if (totalTokens + tokenCount > maxTokens) {
            skippedFiles.push(realPath);
            logger?.warn(`File skipped (token budget): ${realPath} (${tokenCount} tokens, budget ${maxTokens})`);
            continue;
        }

        const displayPath = formatDisplayPath(realPath, safeCwdReal);
        embeddedFiles.push(realPath);
        embeddedChunks.push(`--- File: ${displayPath} ---\n${content}`);
        totalTokens += tokenCount;
    }

    return {
        embedded_files: embeddedFiles,
        embedded_text: embeddedChunks.join("\n\n"),
        skipped_files: skippedFiles,
        total_tokens: totalTokens,
    };
};

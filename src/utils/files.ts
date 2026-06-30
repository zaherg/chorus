import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import { estimateTokenCount } from "@/utils";
import { logger } from "./logger";

const MAX_EMBEDDED_FILE_TOKENS = 50_000;
const MAX_EMBEDDED_FILE_BYTES = 50 * 1024 * 1024;

export interface EmbeddedFileResult {
    embedded_files: string[];
    embedded_text: string;
    skipped_files: string[];
    total_tokens: number;
}

let _allowedRoots: string[] | undefined;

const getAllowedRoots = (): string[] => {
    if (_allowedRoots) return _allowedRoots;
    const cwd = realpathSync(process.cwd());
    const tmp = tmpdir();
    const home = homedir();
    const candidateRoots = [
        cwd,
        tmp,
        resolve(home, ".claude"),
        resolve(home, ".codex"),
        resolve(home, ".copilot"),
        resolve(home, ".opencode"),
    ];
    _allowedRoots = [];
    for (const root of candidateRoots) {
        try {
            _allowedRoots.push(realpathSync(root));
        } catch {
            // Root may not exist; skip
        }
    }
    return _allowedRoots;
};

const isAllowedPath = (realPath: string): boolean => {
    for (const root of getAllowedRoots()) {
        // Use path.relative instead of string-prefix matching for cross-platform
        // safety (Bun on Windows emits `\\` from realpath).
        const rel = relative(root, realPath);
        if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
            return true;
        }
    }
    return false;
};

export const embedFiles = async (
    paths: string[],
    _modelContextWindow?: number,
): Promise<EmbeddedFileResult> => {
    const uniquePaths = [...new Set(paths)];
    const embeddedFiles: string[] = [];
    const skippedFiles: string[] = [];
    const embeddedChunks: string[] = [];
    let totalTokens = 0;

    const maxTokens = Math.min(
        MAX_EMBEDDED_FILE_TOKENS,
        Math.max(4_000, Math.floor((_modelContextWindow ?? 128_000) * 0.4)),
    );

    for (const rawPath of uniquePaths) {
        const absPath = resolve(process.cwd(), rawPath);

        let realPath: string;
        try {
            realPath = await realpath(absPath);
        } catch {
            skippedFiles.push(absPath);
            logger?.warn(`File not found: ${absPath}`);
            continue;
        }

        if (!isAllowedPath(realPath)) {
            skippedFiles.push(absPath);
            logger?.warn(`File outside allowed paths: ${absPath}`);
            continue;
        }

        let stats: Awaited<ReturnType<typeof stat>>;
        try {
            stats = await stat(realPath);
        } catch {
            skippedFiles.push(absPath);
            logger?.warn(`Cannot stat file: ${absPath}`);
            continue;
        }

        if (!stats.isFile()) {
            skippedFiles.push(absPath);
            logger?.warn(`Not a regular file: ${absPath}`);
            continue;
        }

        if (stats.size > MAX_EMBEDDED_FILE_BYTES) {
            skippedFiles.push(absPath);
            logger?.warn(
                `File skipped (too large): ${absPath} (${stats.size} bytes, max ${MAX_EMBEDDED_FILE_BYTES})`,
            );
            continue;
        }

        const content = await Bun.file(realPath).text();
        const tokenCount = estimateTokenCount(content);

        if (totalTokens + tokenCount > maxTokens) {
            skippedFiles.push(absPath);
            logger?.warn(
                `File skipped (token budget): ${absPath} (${tokenCount} tokens, budget ${maxTokens})`,
            );
            continue;
        }

        embeddedFiles.push(realPath);
        embeddedChunks.push(`--- File: ${realPath} ---\n${content}`);
        totalTokens += tokenCount;
    }

    return {
        embedded_files: embeddedFiles,
        embedded_text: embeddedChunks.join("\n\n"),
        skipped_files: skippedFiles,
        total_tokens: totalTokens,
    };
};

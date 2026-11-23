import { existsSync, lstatSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
    configure,
    getJsonLinesFormatter,
    getLogger,
    getStreamSink,
    type LogLevel as LogTapeLevel,
    type Sink,
    type TextFormatter,
} from "@logtape/logtape";

import { getConfigPaths } from "@/config";
import {
    appendPrivateFileNoFollow,
    ensurePrivateDir,
    ensurePrivateFile,
    touchPrivateFileNoFollow,
} from "@/utils/private-fs";
import { clearRedactedSecrets, redactSecrets, registerRedactedSecrets } from "@/utils/redact";

export { clearRedactedSecrets, redactSecrets, registerRedactedSecrets };

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
    [key: string]: unknown;
}

interface WrappedLogger {
    debug(message: string, context?: LogContext): void;
    error(message: string, context?: LogContext): void;
    info(message: string, context?: LogContext): void;
    warn(message: string, context?: LogContext): void;
}

const LOGTAPE_LEVELS: Record<LogLevel, LogTapeLevel> = {
    debug: "debug",
    info: "info",
    warn: "warning",
    error: "error",
};

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_FILES = 3;
const MAX_REDACTION_DEPTH = 20;

export const resolveLogLevel = (configuredLevel?: LogLevel) => {
    const raw = (configuredLevel ?? process.env.CHORUS_LOG_LEVEL)?.toLowerCase();
    if (raw && raw in LOGTAPE_LEVELS) {
        return LOGTAPE_LEVELS[raw as LogLevel];
    }
    return "info";
};

const CREDENTIAL_KEY_RE =
    /(?:(?:^|[_-])(?:auth(?:[_-]?(?:token|key|header|secret))?|(?:access|refresh|id|session|bearer|api|csrf)[_-]?token|credentials?|passwd)|^token$|(?:api[_-]?key|api[_-]?secret|access[_-]?key(?:[_-]?id)?|private[_-]?key|secret(?:[_-]?key)?|password|authorization|(?:auth|access|refresh|bearer|api|session|id)Token))$/i;

export function redactContextValue(value: unknown, depth = 0, ancestors: Set<object> = new Set()): unknown {
    if (typeof value === "string") return redactSecrets(value);
    if (value === null || typeof value !== "object") return value;
    if (ancestors.has(value)) return "[Circular]";
    if (depth > MAX_REDACTION_DEPTH) return "[MaxDepth]";
    if (value instanceof Date) return value;

    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((item) => redactContextValue(item, depth + 1, ancestors));
        }

        if (value instanceof Error) {
            const errorObj: Record<string, unknown> = {
                name:
                    typeof value.name === "string"
                        ? redactSecrets(value.name)
                        : redactContextValue(value.name, depth + 1, ancestors),
                message:
                    typeof value.message === "string"
                        ? redactSecrets(value.message)
                        : redactContextValue(value.message, depth + 1, ancestors),
            };
            if (value.stack !== undefined) {
                errorObj.stack = redactSecrets(value.stack);
            }
            const errWithCause = value as Error & { cause?: unknown };
            if (errWithCause.cause !== undefined) {
                errorObj.cause = redactContextValue(errWithCause.cause, depth + 1, ancestors);
            }
            for (const [k, v] of Object.entries(value)) {
                if (typeof v === "string" && CREDENTIAL_KEY_RE.test(k)) {
                    errorObj[k] = "[REDACTED]";
                } else {
                    errorObj[k] = redactContextValue(v, depth + 1, ancestors);
                }
            }
            return errorObj;
        }

        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (typeof v === "string" && CREDENTIAL_KEY_RE.test(k)) {
                result[k] = "[REDACTED]";
            } else {
                result[k] = redactContextValue(v, depth + 1, ancestors);
            }
        }
        return result;
    } finally {
        ancestors.delete(value);
    }
}

function redactContext(ctx: Record<string, unknown>): Record<string, unknown> {
    return redactContextValue(ctx, 0, new Set()) as Record<string, unknown>;
}

const wrapLogger = (category: string[]): WrappedLogger => {
    const lt = getLogger(category);
    return {
        debug: (msg, ctx) => (ctx ? lt.with(redactContext(ctx)) : lt).debug(redactSecrets(msg)),
        error: (msg, ctx) => (ctx ? lt.with(redactContext(ctx)) : lt).error(redactSecrets(msg)),
        info: (msg, ctx) => (ctx ? lt.with(redactContext(ctx)) : lt).info(redactSecrets(msg)),
        warn: (msg, ctx) => (ctx ? lt.with(redactContext(ctx)) : lt).warn(redactSecrets(msg)),
    };
};

const rotateLogFile = (filePath: string, maxFiles: number): void => {
    if (maxFiles <= 0) {
        rmSync(filePath, { force: true });
        return;
    }
    for (let i = maxFiles; i >= 1; i--) {
        const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
        const dst = `${filePath}.${i}`;
        if (!existsSync(src)) continue;
        try {
            if (lstatSync(src).isSymbolicLink()) continue;
        } catch {
            continue;
        }
        if (i === maxFiles && existsSync(dst)) {
            rmSync(dst, { force: true });
        }
        renameSync(src, dst);
        ensurePrivateFile(dst);
    }
};

interface RotatingFileSinkOptions {
    maxSize: number;
    maxFiles: number;
    formatter: TextFormatter;
}

export const createRotatingFileSink = (
    filePath: string,
    { maxSize, maxFiles, formatter }: RotatingFileSinkOptions,
): Sink => {
    touchPrivateFileNoFollow(filePath);

    return (record) => {
        const formatted = formatter(record);
        const chunk = Buffer.from(formatted, "utf8");

        let currentSize = 0;
        let isSymlink = false;
        try {
            const st = lstatSync(filePath);
            isSymlink = st.isSymbolicLink();
            currentSize = isSymlink ? 0 : st.size;
        } catch {
            currentSize = 0;
        }

        if (!isSymlink && currentSize > 0 && currentSize + chunk.byteLength > maxSize) {
            rotateLogFile(filePath, maxFiles);
        }

        appendPrivateFileNoFollow(filePath, chunk);
    };
};

export interface ConfigureLoggingOptions {
    baseDir?: string;
}

export const configureLogging = async (logLevel?: LogLevel, options: ConfigureLoggingOptions = {}) => {
    const logsDir = join(options.baseDir ?? getConfigPaths().baseDir, "logs");
    ensurePrivateDir(logsDir);

    const level = resolveLogLevel(logLevel);
    const formatter = getJsonLinesFormatter();

    const stderrSink = getStreamSink(
        new WritableStream({
            write: (c: string) => void process.stderr.write(c),
        }),
        { formatter },
    );
    const errorBaseFileSink = createRotatingFileSink(join(logsDir, "error.log"), {
        maxSize: MAX_FILE_SIZE,
        maxFiles: MAX_FILES,
        formatter,
    });

    const ERROR_LEVELS = new Set<LogTapeLevel>(["warning", "error", "fatal"]);
    const errorFileSink: Sink = (record) => {
        if (ERROR_LEVELS.has(record.level)) errorBaseFileSink(record);
    };

    await configure({
        reset: true,
        sinks: {
            stderr: stderrSink,
            errorFile: errorFileSink,
        },
        loggers: [
            {
                category: ["chorus"],
                lowestLevel: level,
                sinks: ["stderr", "errorFile"],
            },
            {
                category: ["logtape", "meta"],
                lowestLevel: "warning" as LogTapeLevel,
                sinks: ["stderr"],
            },
        ],
    });
};

export const logger = wrapLogger(["chorus"]);

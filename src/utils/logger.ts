import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigPaths } from "@/config";
import { getRotatingFileSink } from "@logtape/file";
import {
    configure,
    getJsonLinesFormatter,
    getLogger,
    getStreamSink,
    type LogLevel as LogTapeLevel,
    type Sink,
} from "@logtape/logtape";

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

const LOGS_DIR = join(getConfigPaths().baseDir, "logs");
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_FILES = 3;

export const resolveLogLevel = (configuredLevel?: LogLevel): LogTapeLevel => {
    const raw = (
        configuredLevel ?? process.env.CHORUS_LOG_LEVEL
    )?.toLowerCase();
    if (raw && raw in LOGTAPE_LEVELS) {
        return LOGTAPE_LEVELS[raw as LogLevel];
    }
    return "info";
};

const CREDENTIAL_KEY_RE =
    /^(?:api[_-]?key|api[_-]?secret|token|secret|password|auth|access[_-]?key|private[_-]?key|authorization)$/i;

function redactContextValue(value: unknown, depth: number): unknown {
    if (typeof value === "string") return redactSecrets(value);
    if (depth > 200) return value;
    if (Array.isArray(value))
        return value.map((v) => redactContextValue(v, depth + 1));
    if (value !== null && typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (typeof v === "string" && CREDENTIAL_KEY_RE.test(k)) {
                result[k] = "[REDACTED]";
            } else {
                result[k] = redactContextValue(v, depth + 1);
            }
        }
        return result;
    }
    return value;
}

function redactContext(ctx: Record<string, unknown>): Record<string, unknown> {
    return redactContextValue(ctx, 0) as Record<string, unknown>;
}

const wrapLogger = (category: string[]): WrappedLogger => {
    const lt = getLogger(category);
    return {
        debug: (msg, ctx) =>
            (ctx ? lt.with(redactContext(ctx)) : lt).debug(redactSecrets(msg)),
        error: (msg, ctx) =>
            (ctx ? lt.with(redactContext(ctx)) : lt).error(redactSecrets(msg)),
        info: (msg, ctx) =>
            (ctx ? lt.with(redactContext(ctx)) : lt).info(redactSecrets(msg)),
        warn: (msg, ctx) =>
            (ctx ? lt.with(redactContext(ctx)) : lt).warn(redactSecrets(msg)),
    };
};

const SECRET_REDACTION_PATTERNS: Array<{
    pattern: RegExp;
    replacement: string;
}> = [
    { pattern: /\b(sk|pk)-[a-zA-Z0-9]{20,}\b/gi, replacement: "$1-[REDACTED]" },
    {
        pattern: /\bsk-ant-[a-zA-Z0-9]{20,}\b/gi,
        replacement: "sk-ant-[REDACTED]",
    },
    {
        pattern: /\b(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}\b/gi,
        replacement: "$1_[REDACTED]",
    },
    {
        pattern: /\b(xox[abpsr]?)-[a-zA-Z0-9-]{20,}\b/gi,
        replacement: "$1-[REDACTED]",
    },
    {
        pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/gi,
        replacement: "Bearer [REDACTED]",
    },
    { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: "[REDACTED]" },
    { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED]" },
    { pattern: /\bgsk_[a-zA-Z0-9]{20,}\b/g, replacement: "[REDACTED]" },
    { pattern: /\bhf_[a-zA-Z]{20,}\b/g, replacement: "[REDACTED]" },
    { pattern: /\bsk-or-v1-[a-zA-Z0-9]{20,}\b/g, replacement: "[REDACTED]" },
];

export const redactSecrets = (text: string): string => {
    for (const { pattern, replacement } of SECRET_REDACTION_PATTERNS) {
        text = text.replace(pattern, replacement);
    }
    return text;
};

export const configureLogging = async (logLevel?: LogLevel): Promise<void> => {
    mkdirSync(LOGS_DIR, { recursive: true });

    const level = resolveLogLevel(logLevel);
    const formatter = getJsonLinesFormatter();

    const stderrSink = getStreamSink(
        new WritableStream({
            write: (c: string) => void process.stderr.write(c),
        }),
        { formatter },
    );
    const errorBaseFileSink = getRotatingFileSink(join(LOGS_DIR, "error.log"), {
        maxSize: MAX_FILE_SIZE,
        maxFiles: MAX_FILES,
        formatter,
    });

    const ERROR_LEVELS = new Set<LogTapeLevel>(["warning", "error", "fatal"]);
    const errorFileSink: Sink = (record) => {
        if (ERROR_LEVELS.has(record.level)) errorBaseFileSink(record);
    };

    await configure({
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

export const logger: WrappedLogger = wrapLogger(["chorus"]);

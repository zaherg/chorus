import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { z } from "zod/v4";

import { getErrorMessage } from "@/utils/helpers";

const getConfigDir = () => resolve(homedir(), ".config", "chorus");
const getConfigPath = () => resolve(getConfigDir(), "config.json");
const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
const supportsPosixModes = process.platform !== "win32";

export const MAX_TIMEOUT_MS = 2_147_483_647;

const ENV_VAR_PATTERN = /\$(?:\{([A-Z_][A-Z0-9_]*)\}|([A-Z_][A-Z0-9_]*))/g;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const expandedEnvKeysByConfig = new WeakMap<object, ReadonlySet<string>>();

const positiveIntSchema = (defaultValue: number, max = MAX_TIMEOUT_MS) =>
    z.preprocess((val) => {
        if (val === undefined) return undefined;
        if (typeof val === "number") return val;
        if (typeof val === "string") {
            const trimmed = val.trim();
            if (/^\d+$/.test(trimmed)) {
                return Number(trimmed);
            }
        }
        return val;
    }, z.number().int().positive().max(max).default(defaultValue));

const ChorusConfigSchema = z
    .object({
        cli_timeout_ms: positiveIntSchema(2_700_000),
        provider_timeout_ms: positiveIntSchema(1_800_000),
        log_level: z.enum(["debug", "info", "warn", "error"]).default("info"),
        max_concurrent_processes: positiveIntSchema(3),
        anthropic_api_key: z.string().optional(),
        openrouter_api_key: z.string().optional(),
        amazon_bedrock_api_key: z.string().optional(),
        amazon_bedrock_region: z.string().optional(),
        azure_api_key: z.string().optional(),
        azure_resource_name: z.string().optional(),
        azure_base_url: z.string().optional(),
        google_vertex_api_key: z.string().optional(),
        google_vertex_project: z.string().optional(),
        google_vertex_location: z.string().optional(),
        custom_api_key: z.string().optional(),
        custom_url: z.string().optional(),
        allow_insecure_custom: z.boolean().optional().default(false),
    })
    .superRefine((data, ctx) => {
        const hasUrl = Boolean(data.custom_url && data.custom_url.length > 0);
        const hasKey = Boolean(data.custom_api_key && data.custom_api_key.length > 0);

        if (hasUrl && !hasKey) {
            ctx.addIssue({
                code: "custom",
                message: "Both custom_url and custom_api_key must be set.",
                path: ["custom_api_key"],
            });
        } else if (hasKey && !hasUrl) {
            ctx.addIssue({
                code: "custom",
                message: "Both custom_url and custom_api_key must be set.",
                path: ["custom_url"],
            });
        }
    });

export type ChorusConfig = z.infer<typeof ChorusConfigSchema>;

export const wasExpandedFromEnv = (config: ChorusConfig, key: string): boolean => {
    return expandedEnvKeysByConfig.get(config)?.has(key) ?? false;
};

export const getConfigPaths = () => ({ baseDir: getConfigDir(), configPath: getConfigPath() });

const ensurePrivateMode = (path: string, mode: number, label: string) => {
    if (!supportsPosixModes) return;

    try {
        const st = lstatSync(path);
        if (st.isSymbolicLink()) return;
        if ((st.mode & 0o777) !== mode) {
            chmodSync(path, mode);
        }
    } catch (err) {
        process.stderr.write(
            `Warning: could not set private permissions on ${label} ${path}: ${getErrorMessage(err)}\n`,
        );
    }
};

const ensureConfigDirectories = (configDir: string) => {
    mkdirSync(configDir, { mode: CONFIG_DIR_MODE, recursive: true });
    ensurePrivateMode(configDir, CONFIG_DIR_MODE, "config directory");
};

const resolveEnvVars = (raw: Record<string, unknown>) => {
    const resolved = Object.create(null) as Record<string, unknown>;
    const expandedKeys = new Set<string>();

    for (const [key, value] of Object.entries(raw)) {
        if (FORBIDDEN_KEYS.has(key)) {
            continue;
        }

        if (typeof value === "string") {
            let didExpand = false;
            let hasUnresolved = false;
            const nextValue = value.replace(
                ENV_VAR_PATTERN,
                (match, bracedName: string | undefined, bareName: string | undefined) => {
                    const name = bracedName ?? bareName ?? "";
                    const envVal = process.env[name];
                    if (envVal !== undefined && envVal !== "") {
                        didExpand = true;
                        return envVal;
                    }
                    hasUnresolved = true;
                    return match;
                },
            );
            resolved[key] = nextValue;
            if (didExpand && !hasUnresolved) {
                expandedKeys.add(key);
            }
        } else {
            resolved[key] = value;
        }
    }

    return { expandedKeys, resolved };
};

const DEFAULT_CONFIG = {
    cli_timeout_ms: 2_700_000,
    provider_timeout_ms: 1_800_000,
    log_level: "info",
    max_concurrent_processes: 3,
    anthropic_api_key: "",
    openrouter_api_key: "",
    amazon_bedrock_api_key: "",
    amazon_bedrock_region: "",
    azure_api_key: "",
    azure_resource_name: "",
    azure_base_url: "",
    google_vertex_api_key: "",
    google_vertex_project: "",
    google_vertex_location: "",
    custom_api_key: "",
    custom_url: "",
    allow_insecure_custom: false,
};

const isErrnoException = (err: unknown): err is NodeJS.ErrnoException => {
    return err instanceof Error && "code" in err;
};

const writeDefaultConfig = (configPath: string) => {
    try {
        writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), {
            flag: "wx",
            mode: CONFIG_FILE_MODE,
        });
    } catch (err) {
        if (isErrnoException(err) && err.code === "EEXIST") {
            ensurePrivateMode(configPath, CONFIG_FILE_MODE, "config file");
            return;
        }
        throw err;
    }

    ensurePrivateMode(configPath, CONFIG_FILE_MODE, "config file");
    process.stderr.write(`Default config written to ${configPath}. Edit it to set your API keys and preferences.\n`);
};

export const loadConfig = async () => {
    const configPath = getConfigPath();
    ensureConfigDirectories(getConfigDir());
    writeDefaultConfig(configPath);

    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Invalid config at ${configPath}: expected a JSON object.`);
    }

    const { expandedKeys, resolved } = resolveEnvVars(parsed as Record<string, unknown>);
    const config = ChorusConfigSchema.parse(resolved);
    if (expandedKeys.size > 0) {
        expandedEnvKeysByConfig.set(config, expandedKeys);
    }

    return config;
};

import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { z } from "zod/v4";

import { getErrorMessage } from "@/utils";

const getConfigDir = (): string =>
    resolve(homedir(), ".config", "chorus");
const getConfigPath = (): string => resolve(getConfigDir(), "config.json");
const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
const supportsPosixModes = process.platform !== "win32";

const ChorusConfigSchema = z
    .object({
        cli_timeout_ms: z.coerce.number().default(30_000),
        provider_timeout_ms: z.coerce.number().default(120_000),
        log_level: z.enum(["debug", "info", "warn", "error"]).default("info"),
        max_concurrent_processes: z.coerce.number().default(3),
        openai_api_key: z.string().optional(),
        anthropic_api_key: z.string().optional(),
        google_api_key: z.string().optional(),
        openrouter_api_key: z.string().optional(),
        alibaba_api_key: z.string().optional(),
        amazon_bedrock_api_key: z.string().optional(),
        azure_api_key: z.string().optional(),
        baseten_api_key: z.string().optional(),
        cerebras_api_key: z.string().optional(),
        cohere_api_key: z.string().optional(),
        deepinfra_api_key: z.string().optional(),
        deepseek_api_key: z.string().optional(),
        fireworks_api_key: z.string().optional(),
        gateway_api_key: z.string().optional(),
        google_vertex_api_key: z.string().optional(),
        groq_api_key: z.string().optional(),
        huggingface_api_key: z.string().optional(),
        mistral_api_key: z.string().optional(),
        perplexity_api_key: z.string().optional(),
        togetherai_api_key: z.string().optional(),
        vercel_api_key: z.string().optional(),
        xai_api_key: z.string().optional(),
        custom_api_key: z.string().optional(),
        custom_url: z.string().optional(),
        allow_insecure_custom: z.boolean().optional(),
    })
    .refine(
        (data) => {
            if (data.custom_url && data.custom_url.length > 0) {
                return data.custom_api_key && data.custom_api_key.length > 0;
            }

            if (data.custom_api_key && data.custom_api_key.length > 0) {
                return data.custom_url && data.custom_url.length > 0;
            }

            return true;
        },
        { message: "Both custom_url and custom_api_key should be set." },
    );

export type ChorusConfig = z.infer<typeof ChorusConfigSchema>;

export const getConfigPaths = (): { baseDir: string; configPath: string } => {
    return { baseDir: getConfigDir(), configPath: getConfigPath() };
};

const ensurePrivateMode = (path: string, mode: number, label: string): void => {
    if (!supportsPosixModes) return;

    try {
        if ((statSync(path).mode & 0o777) !== mode) {
            chmodSync(path, mode);
        }
    } catch (err) {
        process.stderr.write(
            `Warning: could not set private permissions on ${label} ${path}: ${getErrorMessage(
                err,
            )}\n`,
        );
    }
};

const ensureConfigDirectories = (): void => {
    const configDir = getConfigDir();
    mkdirSync(configDir, { mode: CONFIG_DIR_MODE, recursive: true });
    ensurePrivateMode(configDir, CONFIG_DIR_MODE, "config directory");
};

const resolveEnvVars = (
    raw: Record<string, unknown>,
): Record<string, unknown> => {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
        resolved[key] =
            typeof value === "string"
                ? value.replace(
                      /\$([A-Z_][A-Z0-9_]*)/g,
                      (_, name) => process.env[name] ?? `$${name}`,
                  )
                : value;
    }
    return resolved;
};

const DEFAULT_CONFIG: Record<string, unknown> = {
    cli_timeout_ms: 30_000,
    provider_timeout_ms: 120_000,
    log_level: "info",
    max_concurrent_processes: 3,
    openai_api_key: "",
    anthropic_api_key: "",
    google_api_key: "",
    openrouter_api_key: "",
    alibaba_api_key: "",
    amazon_bedrock_api_key: "",
    azure_api_key: "",
    baseten_api_key: "",
    cerebras_api_key: "",
    cohere_api_key: "",
    deepinfra_api_key: "",
    deepseek_api_key: "",
    fireworks_api_key: "",
    gateway_api_key: "",
    google_vertex_api_key: "",
    groq_api_key: "",
    huggingface_api_key: "",
    mistral_api_key: "",
    perplexity_api_key: "",
    togetherai_api_key: "",
    vercel_api_key: "",
    xai_api_key: "",
    custom_api_key: "",
    custom_url: "",
    allow_insecure_custom: false,
};

const writeDefaultConfig = (): void => {
    ensureConfigDirectories();
    const configPath = getConfigPath();
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", {
        mode: CONFIG_FILE_MODE,
    });
    ensurePrivateMode(configPath, CONFIG_FILE_MODE, "config file");
    process.stderr.write(
        `Default config written to ${configPath}. Edit it to set your API keys and preferences.\n`,
    );
};
export const loadConfig = async (): Promise<ChorusConfig> => {
    const configPath = getConfigPath();
    ensureConfigDirectories();

    if (!existsSync(configPath)) {
        writeDefaultConfig();
    } else {
        ensurePrivateMode(configPath, CONFIG_FILE_MODE, "config file");
    }

    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
        string,
        unknown
    >;
    const resolved = resolveEnvVars(raw);

    return ChorusConfigSchema.parse(resolved);
};

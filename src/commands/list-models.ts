import minimist from "minimist";
import { z } from "zod/v4";

import { getConfigPaths, loadConfig } from "@/config";
import { makeLocalFileReader, makeLocalFileWriter } from "@/providers/cache-fs";
import { loadCatalog } from "@/providers/model-catalog";
import { isProviderConfigured } from "@/providers/registry";
import type { BrokerModelInfo, ModelsListResponse, ProviderId, ProviderListEntry } from "@/types/providers";
import type { Result, ToolError } from "@/types/tools";
import { getErrorMessage } from "@/utils/helpers";
import { configureLogging } from "@/utils/logger";
import { validateKnownBooleanTokens } from "./boolean-options";

const LIST_MODELS_BOOLEAN_OPTIONS = ["json", "refresh", "help", "h"] as const;

const ListModelsMinimistSchema = z
    .object({
        _: z.array(z.string()),
        "--": z.array(z.string()),
        json: z.boolean(),
        refresh: z.boolean(),
        help: z.boolean(),
        h: z.boolean(),
    })
    .strict();

export type ParsedListModelsArgs = {
    refresh: boolean;
    json: boolean;
    help: boolean;
    filter: string | undefined;
};

const listModelsArgumentError = (message: string, details?: unknown): { ok: false; error: ToolError } => ({
    ok: false,
    error: {
        type: "validation",
        message,
        details,
        retryable: false,
    },
});

/** Parses list-models command arguments without performing command execution. */
export const parseListModelsArgs = (args: string[]): Result<ParsedListModelsArgs, ToolError> => {
    const booleanSyntax = validateKnownBooleanTokens(args, LIST_MODELS_BOOLEAN_OPTIONS);
    if (!booleanSyntax.ok) {
        return listModelsArgumentError(`Unknown flag: ${booleanSyntax.token}`, { option: booleanSyntax.option });
    }

    const unknownOptions: string[] = [];
    const raw: unknown = minimist(args, {
        string: ["_"],
        boolean: [...LIST_MODELS_BOOLEAN_OPTIONS],
        alias: { help: "h" },
        "--": true,
        unknown: (token: string) => {
            if (token === "-" || !token.startsWith("-")) {
                return true;
            }
            unknownOptions.push(token);
            return false;
        },
    });
    const rawValidation = ListModelsMinimistSchema.safeParse(raw);
    if (!rawValidation.success) {
        return listModelsArgumentError("Invalid arguments", rawValidation.error.issues);
    }
    if (unknownOptions.length > 0) {
        return listModelsArgumentError(`Unknown flag: ${unknownOptions[0]}`);
    }

    const parsed = rawValidation.data;
    if (booleanSyntax.separatorPresent || parsed["--"].length > 0) {
        return listModelsArgumentError("Unknown flag: --");
    }
    if (parsed._.length > 1) {
        return listModelsArgumentError(`Unknown flag: ${parsed._[1]}`);
    }
    if (parsed._[0] === "-") {
        return listModelsArgumentError("Unknown flag: -");
    }

    return {
        ok: true,
        value: {
            refresh: parsed.refresh,
            json: parsed.json,
            help: parsed.help,
            filter: parsed._[0],
        },
    };
};

const HELP_TEXT = `consensus list-models -- list model IDs available from configured providers

USAGE:
  consensus list-models [filter] [--json] [--refresh] [--help]

ARGUMENTS:
  filter         Optional case-insensitive substring; keep only models whose
                 route_id, display_name, provider_model_id, or canonical_model_id
                 contains it (e.g. "kimi").

FLAGS:
  --json         Emit a "models.list/1" JSON payload to stdout
  --refresh      Force a fresh fetch from models.dev before listing
  --help, -h     Print this help and exit
`;

const formatCapabilityFlags = (model: BrokerModelInfo) => {
    const flags: string[] = [];
    if (model.context_window !== undefined) {
        flags.push(`[ctx: ${model.context_window}]`);
    }
    if (model.supports_reasoning === true) {
        flags.push("[reasoning]");
    }
    if (model.supports_tools === true) {
        flags.push("[tools]");
    }
    if (model.supports_structured_output === true) {
        flags.push("[structured]");
    }
    return flags.length > 0 ? ` ${flags.join(" ")}` : "";
};

const formatHuman = (response: ModelsListResponse, warning: string | undefined) => {
    const lines: string[] = [];
    const providerIds = Object.keys(response.providers) as ProviderId[];
    lines.push(`${providerIds.length} configured providers:`);
    lines.push("");
    for (const providerId of providerIds) {
        const entry = response.providers[providerId];
        lines.push(`  ${providerId} (${entry.status})`);
        if (entry.status === "passthrough") {
            lines.push("    (no catalog; use provider-prefixed IDs)");
        } else {
            for (const model of entry.models) {
                const caps = formatCapabilityFlags(model);
                lines.push(`    - ${model.route_id}  ${model.display_name}${caps}`);
            }
        }
        lines.push("");
    }
    lines.push(
        `cache: ${response.cache.status} (fetched ${response.cache.fetched_at}, expires ${response.cache.expires_at})`,
    );
    if (warning !== undefined) {
        lines.push(`warning: ${warning}`);
    }
    return `${lines.join("\n")}\n`;
};

const formatHumanError = (message: string) => `Error: ${message}\n`;

const filterConfiguredProviders = (response: ModelsListResponse, config: Awaited<ReturnType<typeof loadConfig>>) => {
    const filtered = Object.fromEntries(
        Object.entries(response.providers).filter(([id]) => isProviderConfigured(id as ProviderId, config)),
    ) as Record<ProviderId, ProviderListEntry>;
    return {
        schema: response.schema,
        cache: response.cache,
        providers: filtered,
    };
};

const modelMatchesFilter = (model: BrokerModelInfo, needle: string) => {
    if (model.route_id.toLowerCase().includes(needle)) {
        return true;
    }
    if (model.display_name.toLowerCase().includes(needle)) {
        return true;
    }
    if (model.provider_model_id.toLowerCase().includes(needle)) {
        return true;
    }
    if (model.canonical_model_id?.toLowerCase().includes(needle)) {
        return true;
    }
    return false;
};

const applyModelFilter = (response: ModelsListResponse, filter: string | undefined) => {
    if (filter === undefined) {
        return response;
    }
    const needle = filter.toLowerCase();
    const providers = Object.fromEntries(
        Object.entries(response.providers).map(([id, entry]) => [
            id,
            {
                ...entry,
                models: entry.models.filter((m) => modelMatchesFilter(m, needle)),
            },
        ]),
    ) as Record<ProviderId, ProviderListEntry>;
    return { ...response, providers };
};

export const runListModelsCommand = async (args: string[]) => {
    const parsed = parseListModelsArgs(args);
    if (!parsed.ok) {
        process.stderr.write(`${parsed.error.message}\n`);
        return 2;
    }

    const { filter, help, json, refresh } = parsed.value;
    if (help) {
        process.stdout.write(HELP_TEXT);
        return 0;
    }

    let config: Awaited<ReturnType<typeof loadConfig>>;
    try {
        config = await loadConfig();
        await configureLogging(config.log_level);
    } catch (e) {
        process.stderr.write(`Error: Failed to load config: ${getErrorMessage(e)}\n`);
        return 1;
    }

    const configDir = getConfigPaths().baseDir;
    const reader = makeLocalFileReader(configDir);
    const writer = makeLocalFileWriter(configDir);

    const result = await loadCatalog({
        configDir,
        fetchFn: globalThis.fetch,
        reader,
        writer,
        forceRefresh: refresh,
    });

    if (!result.ok) {
        if (json) {
            const payload = {
                schema: "models.list.error/1" as const,
                error: {
                    code: "catalog_unavailable" as const,
                    message: result.error.message,
                },
            };
            process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        } else {
            process.stderr.write(formatHumanError(result.error.message));
        }
        return 1;
    }

    const filtered = applyModelFilter(
        filterConfiguredProviders(
            {
                schema: result.schema,
                cache: result.cache,
                providers: result.providers,
            },
            config,
        ),
        filter,
    );

    if (json) {
        process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`);
    } else {
        process.stdout.write(formatHuman(filtered, result.warning));
    }
    return 0;
};

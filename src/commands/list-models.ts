import { getConfigPaths, loadConfig } from "@/config";
import { makeLocalFileReader, makeLocalFileWriter } from "@/providers/cache-fs";
import { loadCatalog } from "@/providers/model-catalog";
import { isProviderConfigured } from "@/providers/registry";
import {
    type BrokerModelInfo,
    type ModelsListError,
    type ModelsListResponse,
    type ProviderId,
    type ProviderListEntry,
    providerIdValues,
} from "@/types/providers";
import type { Result, ToolError } from "@/types/tools";
import { getErrorMessage } from "@/utils/helpers";
import { configureLogging } from "@/utils/logger";
import { parseCliOptions } from "./cli-options";

const LIST_MODELS_BOOLEAN_OPTIONS = ["json", "refresh", "help"] as const;

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
    const parsed = parseCliOptions(args, {
        booleans: LIST_MODELS_BOOLEAN_OPTIONS,
        shortAliases: { h: "help" },
    });
    if (!parsed.ok) {
        if (parsed.kind === "separator") {
            return listModelsArgumentError("Unknown flag: --");
        }
        return listModelsArgumentError(`Unknown flag: ${parsed.token}`, { option: parsed.option });
    }

    if (parsed.positionals.length > 1) {
        return listModelsArgumentError(`Unknown flag: ${parsed.positionals[1]}`);
    }
    if (parsed.positionals[0] === "-") {
        return listModelsArgumentError("Unknown flag: -");
    }

    return {
        ok: true,
        value: {
            refresh: parsed.booleans.refresh,
            json: parsed.booleans.json,
            help: parsed.booleans.help,
            filter: parsed.positionals[0],
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
    const configuredEntries: Array<readonly [ProviderId, ProviderListEntry]> = [];
    for (const providerId of providerIdValues) {
        const entry = response.providers[providerId];
        if (!entry) {
            continue;
        }
        configuredEntries.push([providerId, entry]);
    }
    lines.push(`${configuredEntries.length} configured providers:`);
    lines.push("");
    for (const [providerId, entry] of configuredEntries) {
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

const filterConfiguredProviders = (
    response: ModelsListResponse,
    config: Awaited<ReturnType<typeof loadConfig>>,
): ModelsListResponse => {
    const filtered: Partial<Record<ProviderId, ProviderListEntry>> = {};
    for (const providerId of providerIdValues) {
        const entry = response.providers[providerId];
        if (!entry || !isProviderConfigured(providerId, config)) {
            continue;
        }
        filtered[providerId] = entry;
    }
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

const applyModelFilter = (response: ModelsListResponse, filter: string | undefined): ModelsListResponse => {
    if (filter === undefined) {
        return response;
    }
    const needle = filter.toLowerCase();
    const providers: Partial<Record<ProviderId, ProviderListEntry>> = {};
    for (const providerId of providerIdValues) {
        const entry = response.providers[providerId];
        if (!entry) {
            continue;
        }
        providers[providerId] = {
            ...entry,
            models: entry.models.filter((m) => modelMatchesFilter(m, needle)),
        };
    }
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
        const message = getErrorMessage(e);
        if (json) {
            const payload: ModelsListError = {
                schema: "models.list.error/1",
                error: {
                    code: "config_load_failed",
                    message,
                },
            };
            process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        } else {
            process.stderr.write(`Error: Failed to load config: ${message}\n`);
        }
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
            const payload: ModelsListError = {
                schema: "models.list.error/1",
                error: {
                    code: "catalog_unavailable",
                    message: result.error.message,
                },
            };
            process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        } else {
            process.stderr.write(formatHumanError(result.error.message));
        }
        return 1;
    }

    const cache =
        result.warning !== undefined
            ? {
                  ...result.cache,
                  warning: result.warning,
              }
            : result.cache;

    const filtered = applyModelFilter(
        filterConfiguredProviders(
            {
                schema: result.schema,
                cache,
                providers: result.providers,
            },
            config,
        ),
        filter,
    );

    if (json) {
        process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`);
    } else {
        process.stdout.write(formatHuman(filtered, result.warning ?? filtered.cache.warning));
    }
    return 0;
};

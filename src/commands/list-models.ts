import { getConfigPaths, loadConfig } from "@/config";
import { makeLocalFileReader, makeLocalFileWriter } from "@/providers/cache-fs";
import { loadCatalog } from "@/providers/model-catalog";
import { isProviderConfigured } from "@/providers/registry";
import type { BrokerModelInfo, ModelsListResponse, ProviderId, ProviderListEntry } from "@/types/providers";
import { getErrorMessage } from "@/utils";
import { configureLogging } from "@/utils/logger";

const parseFlags = (
    rawArgs: string[],
):
    | {
          ok: true;
          refresh: boolean;
          json: boolean;
          help: boolean;
          filter: string | undefined;
      }
    | { ok: false; flag: string } => {
    let refresh = false;
    let json = false;
    let help = false;
    let filter: string | undefined;
    let sawSeparator = false;
    for (const arg of rawArgs) {
        if (sawSeparator) {
            continue;
        }
        if (arg === "--") {
            sawSeparator = true;
            continue;
        }
        if (arg === "--refresh") {
            refresh = true;
            continue;
        }
        if (arg === "--json") {
            json = true;
            continue;
        }
        if (arg === "--help" || arg === "-h") {
            help = true;
            continue;
        }
        if (arg.startsWith("-")) {
            return { ok: false, flag: arg };
        }
        if (filter !== undefined) {
            return { ok: false, flag: arg };
        }
        filter = arg;
    }
    return { ok: true, refresh, json, help, filter };
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
    const parsed = parseFlags(args);
    if (!parsed.ok) {
        process.stderr.write(`Unknown flag: ${parsed.flag}\n`);
        return 2;
    }
    if (parsed.help) {
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
        forceRefresh: parsed.refresh,
    });

    if (!result.ok) {
        if (parsed.json) {
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
        parsed.filter,
    );

    if (parsed.json) {
        process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`);
    } else {
        process.stdout.write(formatHuman(filtered, result.warning));
    }
    return 0;
};

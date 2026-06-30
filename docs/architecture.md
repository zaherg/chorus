# Architecture

## High-Level Data Flow

```
User / stdin JSON
    │
    ▼
┌──────────┐
│  cli.ts  │  Entry point. Parses args, dispatches to commands.
└────┬─────┘
     │
     ├──► commands/consensus.ts       Parse flags, orchestrate consensus run
     │         │
     │         ├──► config.ts                 Load & validate ~/.config/chorus/config.json
     │         ├──► providers/model-catalog   Fetch + cache models.dev catalog
     │         ├──► providers/provider-map    Internal provider ID to models.dev key
     │         ├──► providers/resolve-route   route_id resolution + ambiguity + passthrough
     │         ├──► providers/registry        AI SDK provider registry, generateText
     │         ├──► consensus.ts              Core engine: fan-out queries
     │         └──► utils/files.ts            Embed local files (token-budgeted, path-restricted)
     │
     └──► commands/list-models.ts      List configured-provider catalog
               │
               ├──► config.ts                 Load config (configured providers)
               ├──► providers/model-catalog   Load cache, refresh if expired, filter to configured
               └──► providers/provider-map    Provider list status (catalog vs passthrough)
```

## Directory Map

```
src/
  cli.ts                       CLI entry point. Arg routing, help text.
                               Reads version from package.json.
  config.ts                    Config loading, Zod validation, env var resolution.
  consensus.ts                 Core consensus orchestration: parallel/sequential fan-out,
                               prompt building, optional synthesis call.
  commands/
    consensus.ts               CLI handler for `consensus` command.
    list-models.ts             CLI handler for `list-models` command.
                               Emits models.list/1 JSON or human-readable summary.
  prompts/
    consensus.ts               System prompt for consensus participants.
  providers/
    registry.ts                createProviderRegistry factory. Provider factory management,
                               text generation, model resolution to AI SDK calls.
    model-catalog.ts           Fetch, cache, validate, and normalize the models.dev catalog.
    provider-map.ts            Internal provider ID to models.dev provider key mapping.
    resolve-route.ts           route_id parsing, exact route resolution, unqualified
                               ambiguity handling, passthrough handling.
    custom-url.ts              Custom provider URL validation. Enforces HTTPS for
                               non-loopback, rejects credentials and fragments in URLs.
  types/
    index.ts                   Re-exports.
    consensus.ts               Consensus request/response types (ConsensusRequest,
                               ConsensusResult, ConsensusError, ParticipantResponse).
    providers.ts               ProviderId, ModelsListResponse, BrokerModelInfo Zod
                               schemas + types.
    tools.ts                   ToolError, Result<T,E> discriminated union.
  utils/
    files.ts                   File embedding with path restrictions, token budgeting.
    logger.ts                  Structured logging via @logtape/logtape.
skills/
  consensus/
    SKILL.md                   Agent skill: how to call consensus from a coding agent.
    scripts/install.sh         Skill-local binary installer from GitHub Releases.
  delegate/
    SKILL.md                   Agent skill: how to delegate to CLI coding agents.
tests/                          bun:test suite. Uses mock.module, fake keys.
.github/workflows/
  prepare-release.yml         Manual dispatch: bump version, update changelog, tag.
  release-orchestrator.yml    Tag push: test gate then draft release.
  changelog.yml               Reusable git-cliff changelog update.
  release.yml                 Reusable binary build plus draft release.
docs/
  plans/                       Implementation plans (one per feature/bug).
  solutions/                   Documented solutions to past problems.
```

## Models Cache Layout

The broker keeps a local cache of the models.dev catalog under the user config dir:

```
~/.config/chorus/models-cache/catalog.json     # full catalog payload
~/.config/chorus/models-cache/metadata.json    # fetched_at, expires_at, source
```

`metadata.json` is the source of truth for cache status. Default TTL is 24 hours. Successful fetches report `cache.status: "fresh"`. When a refresh fails but a previous cache is readable, the broker reports `cache.status: "stale"`. When no usable cache exists, `list-models` exits non-zero with a `models.list.error/1` payload and `consensus` exits non-zero with a `cli.consensus.error/1` payload.

## Core Modules

### `src/cli.ts` -- Entry Point

Handles `--version`, `--help`, and command dispatch. Routes flags starting with `-` to `runConsensusCommand`, and named subcommands to their handlers. Unknown commands print help and exit code 1. The CLI reads its version from `package.json` at build time.

### `src/config.ts` -- Configuration

- Validates via Zod `ChorusConfigSchema`
- Supports 23 provider API key fields, plus runtime settings (`cli_timeout_ms`, `provider_timeout_ms`, `log_level`, `max_concurrent_processes`)
- Resolves `$ENV_VAR` references in string values
- First-run: creates `~/.config/chorus/` (0700) and `config.json` (0600)
- Repairs broader permissions on existing files at load time

### `src/consensus.ts` -- Core Engine

Implements the broker:

1. Validate at least 2 models requested
2. Embed files if `relevantFiles` provided (token-budgeted, path-restricted)
3. Resolve every requested `route_id` via `providers/resolve-route.ts` (exact, unqualified, or passthrough). Ambiguous unqualified input exits with code 3 before any provider call runs.
4. **Parallel mode:** Fan out to all models concurrently via `runSettledWithConcurrency`, respecting `maxConcurrency`
5. **Sequential mode:** Query models one-by-one; each sees prior responses
6. Collect at least 1 successful participant response. Failed participants keep their `route_id` / `provider` / `provider_model_id` and carry `response: null` plus a structured `error`. If all participants fail, return a `cli.consensus.error/1` payload and exit non-zero.
7. Optional synthesis runs only when `--synthesis-model` is set and at least one participant response succeeded. If the synthesis call fails, raw participant responses are kept and `synthesis_error` is populated.
8. Return `ConsensusResult` (schema `cli.consensus/2`) with per-model responses, optional synthesis, and embedded-file result.

### `src/providers/registry.ts` -- createProviderRegistry

Central provider abstraction:

- **Provider factories:** Creates AI SDK provider instances from config API keys
- **Model resolution:** Delegates to `resolve-route.ts` to turn a `route_id` into a `BrokerModelInfo`; the registry then hands the provider-native model ID to the AI SDK
- **`generateText()`:** Unified text generation across all providers. Maps thinking modes to provider-specific options (Anthropic thinking budget, OpenAI reasoning effort)
- **Passthrough:** Provider-prefixed IDs for configured passthrough providers (`custom`, `gateway`) are passed through to the provider API

### `src/providers/model-catalog.ts` -- Catalog Cache

- Fetches `https://models.dev/catalog.json` on cache miss or when forced via `list-models --refresh`
- Validates the payload against `CatalogJsonSchema` (Zod v4)
- Writes `~/.config/chorus/models-cache/{catalog,metadata}.json`
- Default TTL 24 hours, surfaces `fresh` for successful fetches and `stale` only when refresh failed and a previous cache was used
- Returns `LoadCatalogFailure` (`ok: false`, `code: "catalog_unavailable"`) when no usable cache exists

### `src/providers/provider-map.ts` -- Provider Mapping

- Single source of truth for the internal `ProviderId` to models.dev provider key relationship
- Exposes `getModelsDevProviderKey`, `isCatalogBackedProvider`
- `custom` and `gateway` map to `undefined` (passthrough)

### `src/providers/resolve-route.ts` -- Route Resolution

- Parses `route_id` input (first path segment = provider; rest = provider-native model ID)
- Exact route: use that route when the configured catalog row matches
- Unqualified input: accept only when exactly one configured provider has that exact provider-native ID
- Ambiguous input: return a structured candidate list and exit code 3
- Passthrough: accept provider-prefixed IDs for configured `custom` / `gateway` providers

### Provider Tiers

Two support tiers:

**Catalog:** providers with a models.dev key. Configured catalog providers return executable `route_id` rows from `list-models --json`.

**Passthrough:** providers with no models.dev key (`custom`, `gateway`). The agent may still send provider-prefixed IDs that the provider API will accept or reject.

## Key Patterns

### Module Mocking

Tests use `bun:test`'s `mock.module` to replace imports at the module level. Each test file mocks `@/config`, `@/utils/logger`, `@/providers/registry`, and `@/consensus` as needed, removing the need for dependency injection parameters in command handlers.

### Error Handling

- `ConsensusResult.ok = true` whenever at least one participant call completed (failures stay in `models[]` with structured `error`).
- `ConsensusError.ok = false` (`errors: string[]`) when all participant calls fail.
- `cli.consensus.error/1` payloads for command-level failures (catalog load, model resolution, all-participants-failed).
- `getErrorMessage()` utility extracts messages from unknown error shapes.

### Concurrency

`runSettledWithConcurrency` implements bounded parallel execution: `maxConcurrency` worker promises consume items from a shared index counter. All results collected via `Promise.all`.

### Zod Validation

Used in config loading, stdin JSON parsing, catalog payload validation, and type definitions. Zod v4 with `z.coerce` for number defaults.

## External Dependencies

| Dependency | Purpose |
|---|---|
| `ai` (Vercel AI SDK v7) | Text generation, streaming, provider interface |
| `@ai-sdk/*` | Provider packages (OpenAI, Anthropic, Google, etc.) |
| `zod` v4 | Schema validation |
| `@logtape/logtape` | Structured logging |
| `@openrouter/ai-sdk-provider` | OpenRouter provider |

## Testing

Tests live in `tests/` and use `bun:test`. Strategy:

- **Module mocking:** `bun:test`'s `mock.module` replaces imports like `@/config`, `@/providers/registry`, and `@/consensus`
- **Fake API keys:** No live provider calls
- **Unit tests:** Individual modules (config validation, route resolution, file embedding, catalog caching)
- **Integration tests:** CLI commands with mocked provider registry via `mock.module`

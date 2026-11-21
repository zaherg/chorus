# `@zaherg/chorus` -- Codebase Overview

> Comprehensive reference for onboarding team members. Covers architecture,
> module responsibilities, data flow, conventions, and testing strategy.

---

## 1. Project Identity

| Field | Value |
|---|---|
| **Package** | `@zaherg/chorus` |
| **Runtime** | [Bun](https://bun.sh) (`1.4.5`) |
| **Language** | TypeScript (`7.0.2`) |
| **Binary name** | `consensus` |
| **Entry point** | `src/cli.ts` → `dist/cli.js` |
| **Package manager** | Bun (no npm/yarn lockfiles) |
| **Formatter / linter** | Biome (config in `biome.json`) |

The project ships a single CLI binary, `consensus`, that brokers between agents and LLM providers. The CLI fetches and caches a public models.dev catalog, filters it to configured providers, and returns one raw record per requested model. The CLI reads its version from `package.json` at build time. It is distributed as an npm package and also via platform-specific GitHub Release binaries.

---

## 2. Directory Map

```
.
├── src/
│   ├── cli.ts                   # CLI entry -- routing and help; reads version from package.json
│   ├── config.ts                # Config loader, env-var schema (Zod)
│   ├── consensus.ts             # Core consensus engine
│   ├── commands/
│   │   ├── boolean-options.ts   # Strict CLI boolean flag validator
│   │   ├── consensus.ts         # Top-level consensus CLI handler
│   │   └── list-models.ts       # `list-models` CLI subcommand handler (models.list/1)
│   ├── prompts/
│   │   └── consensus.ts         # System prompt literal
│   ├── providers/
│   │   ├── cache-fs.ts          # Local filesystem reader/writer for models-cache
│   │   ├── registry.ts          # createProviderRegistry factory (SDK factories,
│   │   │                          generateText, model resolution to AI SDK)
│   │   ├── model-catalog.ts     # models.dev catalog fetch, cache, validate, normalize
│   │   ├── provider-map.ts      # Internal ProviderId to models.dev provider key map
│   │   ├── resolve-route.ts     # route_id parsing, exact / unqualified / passthrough
│   │   └── custom-url.ts        # Custom provider URL validation, IP pinning, redirect block
│   ├── types/
│   │   ├── index.ts             # Re-exports providers + tools (omits consensus contracts)
│   │   ├── boolean-options.ts   # Boolean option definitions
│   │   ├── consensus.ts         # ConsensusRequest, ConsensusResult, ConsensusError,
│   │   │                          ParticipantResponse
│   │   ├── files.ts             # EmbeddedFileResult interface
│   │   ├── providers.ts         # Zod schemas for ProviderId, ModelsListResponse,
│   │   │                          BrokerModelInfo
│   │   └── tools.ts             # ToolError, Result<T,E> (discriminated union)
│   └── utils/
│       ├── files.ts             # File-embedding with path allowlist, denylist, token budget
│       ├── helpers.ts           # getErrorMessage() + estimateTokenCount() helpers
│       ├── logger.ts            # Structured logging (LogTape), secret redaction
│       └── prompts.ts           # Prompt builders and safe embedded-file escaping
├── tests/                       # Bun test suite (15 files)
├── skills/
│   ├── consensus/
│   │   ├── SKILL.md             # Consensus skill documentation
│   │   └── scripts/
│   │       └── install.sh       # Platform binary installer (curl + checksum)
│   └── delegate/
│       └── SKILL.md             # Delegate skill documentation
├── .github/
│   └── workflows/
│       ├── ci.yml               # Lint, format, typecheck, tests (also called by release.yml)
│       └── release.yml          # Tag push: validate, CI, native builds, draft release
├── package.json
├── tsconfig.json
├── biome.json
├── CHANGELOG.md
├── README.md
├── RELEASING.md
└── .github/workflows/release.yml
```

---

## 3. Architecture -- Data Flow

```
User invokes:  consensus list-models --json
               consensus --models "openrouter/openai/gpt-5.2,anthropic/claude-sonnet-4-5" --prompt "..."
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│  cli.ts (runCli)                                                 │
│  ├─ Routes `list-models` to commands/list-models.ts              │
│  └─ Routes bare flags or no args to commands/consensus.ts        │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  config.ts (loadConfig)                                          │
│  ├─ Validates config.json (ChorusConfigSchema)                   │
│  └─ Returns ChorusConfig + Paths                                 │
└──────────────────────────────┬───────────────────────────────────┘
                               │
              ┌────────────────┴─────────────────┐
              │  list-models path                │  consensus path
              ▼                                  ▼
┌─────────────────────────────────┐  ┌────────────────────────────────┐
│ providers/model-catalog.ts      │  │ providers/resolve-route.ts     │
│ ├─ Read models-cache/*.json     │  │ ├─ Parse `route_id`            │
│ ├─ Refresh from models.dev      │  │ ├─ Exact / unqualified /       │
│ │   on miss or --refresh        │  │ │   passthrough resolution     │
│ ├─ Validate (CatalogJsonSchema) │  │ └─ Return BrokerModelInfo[]    │
│ └─ Emit models.list/1           │  │                                │
│    filtered to configured       │  │ providers/registry.ts          │
│    providers                    │  │ ├─ Create AI SDK provider      │
└─────────────────────────────────┘  │ ├─ Call generateText() per     │
                                     │ │   participant                │
                                     │ └─ Optional synthesis call     │
                                     │     (only when                 │
                                     │      --synthesis-model set)    │
                                     └─────────────┬──────────────────┘
                                                   │
                                                   ▼
                                     ┌────────────────────────────────┐
                                     │  consensus.ts (runConsensus)   │
                                     │  ├─ Fan out participant calls  │
                                     │  ├─ Collect raw responses      │
                                     │  └─ Emit ConsensusResult       │
                                     │     (cli.consensus/2)          │
                                     └────────────────────────────────┘
```

---

## 4. Module Deep-Dive

### 4.1 `src/cli.ts` -- Entry Point

**Purpose:** Top-level CLI routing.
Routes `list-models`, `--version`/`-v`, and `--help`/`-h`/`help`, and dispatches bare flags or empty arguments directly to the consensus command.

**Exports:**
- `runCli(args: string[]): Promise<number>` -- the entry function
- Calls `printHelp()` and returns `0` for `--help`, `-h`, or `help`
- Prints `consensus <version>` and returns `0` for `--version` or `-v`
- Calls `runListModelsCommand(args.slice(1))` for `list-models`
- Calls `runConsensusCommand(args)` for bare flags (starting with `-`) or no args (which reports missing required flags and returns exit code `2`)
- Calls `printHelp()` and returns `1` for unknown positional subcommands
- `import.meta.main` block reads `process.argv`, wires `SIGINT` (exit `130`) and `SIGTERM` (exit `143`), and calls `runCli`.
  The CLI reads its version from `package.json` at build time.

**Design note:** There is no `consensus consensus` subcommand.
Top-level `consensus` runs consensus directly, and `list-models` is the only operational subcommand.

---

### 4.2 `src/config.ts` -- Configuration

**Purpose:** Load and validate `~/.config/chorus/config.json`.

**Config keys** (subset; full schema in `docs/configuration.md`):

| Key | Purpose |
|---|---|
| `cli_timeout_ms` | Consensus CLI timeout (default 2 700 000) |
| `provider_timeout_ms` | Per-provider request timeout (default 1 800 000) |
| `log_level` | `"debug" \| "info" \| "warn" \| "error"` (default `"info"`) |
| `max_concurrent_processes` | Parallel model query limit (default 3) |
| `openrouter_api_key` | OpenRouter API key |
| `anthropic_api_key` | Anthropic API key |
| `amazon_bedrock_api_key` | Amazon Bedrock API key |
| `amazon_bedrock_region` | Amazon Bedrock AWS region |
| `azure_api_key` | Azure API key |
| `azure_resource_name` | Azure resource name |
| `azure_base_url` | Azure custom base URL |
| `google_vertex_api_key` | Google Vertex AI API key |
| `google_vertex_project` | Google Vertex AI GCP project ID |
| `google_vertex_location` | Google Vertex AI GCP location |
| `custom_api_key` | Custom endpoint API key |
| `custom_url` | Custom endpoint base URL |
| `allow_insecure_custom` | Set to `true` to allow `http://` on public custom URLs (does not relax IP/redirect checks) |

**Exports:**
- `ChorusConfig` (Zod-inferred type)
- `loadConfig(): Promise<ChorusConfig>` -- parses config + creates paths
- `getConfigPaths()` -- resolves `~/.config/chorus`

**Validation** is done at parse-time via Zod's `ChorusConfigSchema`. The first run creates the directory with `0700` and `config.json` with `0600`; broader existing modes are repaired best-effort at load time.

---

### 4.3 `src/consensus.ts` -- Core Engine

**Purpose:** The broker. Accepts a `ConsensusRequest`, queries N models, returns raw responses plus optional synthesis.

**Key types:**

```typescript
ConsensusRequest {
  providerRegistry: ProviderRegistry  // Registry object used for model resolution + text generation
  catalog?: ModelsListResponse         // Pre-loaded models.dev catalog (required for routing)
  configuredProviders?: ReadonlySet<ProviderId>
  models: ConsensusModelConfig[]      // route_id values + per-model overrides
  findings: string                     // The "current state" the models evaluate
  step: string                         // The proposal being evaluated
  parallel?: boolean                   // Default: true
  maxConcurrency?: number             // Default: models.length
  abortSignal?: AbortSignal
  temperature?: number
  synthesisModel?: string              // Optional route_id; opt-in synthesis
  relevantFiles?: string[]            // Files to embed in the prompt
}

ConsensusResult {
  ok: true
  schema: "cli.consensus/2"
  models: ParticipantResponse[]        // One per requested model
  synthesis: string | null
  synthesis_error: ParticipantError | null
  embeddedFiles: EmbeddedFileResult
}

ConsensusError {
  ok: false
  errors: string[]                     // All participant calls failed
}
```

**Parallel mode (default):**
Uses a worker-pool pattern (`runSettledWithConcurrency`) that respects
`maxConcurrency`. All N models are queried simultaneously with a bounded
number of concurrent provider calls. Failing models produce a row in
`models[]` with `response: null` and a structured `error`.

**Sequential mode (`--sequential`):**
Each model sees the responses of all previous models via the prompt, enabling
structured debate where later models can respond to earlier arguments.

**Synthesis (opt-in):**
When `synthesisModel` is set and at least one participant call succeeded, the
engine queries the synthesis model with the successful participant responses.
If the synthesis call fails, raw participant responses stay in `models[]` and
`synthesis_error` carries the structured failure. The broker never auto-picks
a synthesis model.

**File embedding** happens once at the start (deduplicated paths, path
allowlist, 50 k token cap).

---

### 4.4 `src/commands/consensus.ts` -- CLI Handler

**Purpose:** Parses CLI flags, validates input, orchestrates the consensus
pipeline. This is the bridge between the user's shell command and the engine.

**Key responsibilities:**
1. Parse flags: `--models`, `--prompt`, `--stance`, `--thinking-mode`,
   `--temperature`, `--temperature-model`, `--synthesis-model`,
   `--sequential`, `--files`, `--stdin-json`, `--schema`
2. Validate: at least 2 models, prompt required (unless `--stdin-json`)
3. Support **two input modes**:
   - **Flag-based:** `--models "openrouter/openai/gpt-5.2,anthropic/claude-sonnet-4-5" --prompt "..." --stance "openrouter/openai/gpt-5.2=for"`
   - **JSON via stdin:** `--stdin-json` reads a structured JSON payload
     (validated against `StdinConsensusSchema`)
4. Load config, load models.dev catalog, create `ProviderRegistry`, resolve `route_id` values
5. Exit code 1 with `cli.consensus.error/1` for command-level catalog failures
6. Exit code 3 for ambiguous or unknown model input; no provider calls run in that case
7. Execute `runConsensus()`, write JSON result to stdout

**Testing:** The handler directly imports and calls `loadConfig`,
`createProviderRegistry`, and `runConsensus`. Tests use `bun:test`'s
`mock.module` to replace these imports at the module level.

**Exit codes:**
- `0` -- success (at least one participant response collected)
- `1` -- broker error (config load, all participants failed, unrecoverable catalog)
- `2` -- argument parse error
- `3` -- model resolution error (ambiguous or unknown `route_id`)

---

### 4.5 `src/commands/list-models.ts` -- List Models CLI

**Purpose:** Emits the `models.list/1` JSON payload (with `--json`) or a
human-readable summary of the configured-provider catalog.

Flags: `--json`, `--refresh`, `--help`.

Loads the catalog via `providers/model-catalog.ts`, filters to configured
providers via `providers/registry.ts`, and renders the result. When refresh
fails and no usable cache exists, exits non-zero with a
`models.list.error/1` payload.

---

### 4.6 `src/prompts/consensus.ts` -- System Prompt

**Purpose:** A single constant `CONSENSUS_SYSTEM_PROMPT` used for the
per-model queries. It instructs the model to evaluate a proposal from an
assigned stance.

---

### 4.7 Provider System (`src/providers/`)

#### 4.7.1 `registry.ts` -- `createProviderRegistry`

The central abstraction for interacting with LLM providers.

**Responsibilities:**
- **Model resolution to AI SDK:** Given a `route_id`, the registry uses
  `resolve-route.ts` to find a `BrokerModelInfo` row, then calls the AI SDK
  provider with the provider-native model ID.
- **Text generation** (`generateText`): Delegates to the Vercel AI SDK
  (`generateText` from `ai`). Handles:
  - Thinking mode (Anthropic budget tokens, OpenRouter reasoning effort)
  - Timeout signals (merged parent + provider timeout)
  - Error classification: `timeout`, `execution`, `not_found`, `configuration`
- **Provider factory caching:** SDK provider instances (OpenAI client,
  Anthropic client, etc.) are lazily created and cached per provider ID.
- **Passthrough:** For the configured passthrough provider (`custom`), the registry passes provider-prefixed IDs through to the AI SDK provider.

**Supported providers:** 6 `ProviderId` slots. The 5 catalog-backed providers are Amazon Bedrock, Anthropic, Azure, Google Vertex AI, and OpenRouter. The 1 passthrough provider is Custom. Catalog-backed providers expose `route_id` rows from `models.list/1`; the passthrough provider accepts provider-prefixed IDs.

#### 4.7.2 `model-catalog.ts` -- Models.dev Catalog Cache

**Purpose:** Fetch, validate, cache, and normalize the public models.dev
catalog.

**Key features:**
- Fetches `https://models.dev/catalog.json` on cache miss or when `forceRefresh` is set
- Validates the payload against `CatalogJsonSchema` (Zod v4)
- Writes two files under the user config dir:
  - `~/.config/chorus/models-cache/catalog.json`
  - `~/.config/chorus/models-cache/metadata.json`
- Default TTL is 24 hours
- Reports successful fetches as `cache.status: "fresh"`
- Reports `cache.status: "stale"` only when refresh failed and a previous cache was used
- Returns a `models.list.error/1` payload when no usable cache exists

#### 4.7.3 `provider-map.ts` -- Provider ID Map

**Purpose:** Single source of truth for the internal `ProviderId` to
`models.dev` provider key relationship.

Exports:
- `getModelsDevProviderKey(providerId)` -- returns the models.dev key or
  `undefined` for the passthrough provider (`custom`).
- `isCatalogBackedProvider(providerId)` -- `true` for catalog providers.

Both functions read from the internal `PROVIDER_TO_MODELS_DEV_KEY` map.

#### 4.7.4 `resolve-route.ts` -- Route Resolution

**Purpose:** Turn a `route_id` (or bare provider-native ID) into a
`BrokerModelInfo` row.

**Resolution steps:**
1. **Exact route:** if the input contains a `/`, the first segment is the
   internal provider ID and the rest is the provider-native model ID. The
   route is accepted when the configured catalog row matches.
2. **Unqualified input:** a bare provider-native ID is accepted only when
   exactly one configured provider exposes that exact provider-native ID.
3. **Ambiguous input:** when two or more configured providers expose the
   same provider-native ID, the broker returns a structured candidate list
   (`error.code: "ambiguous_model"`); the caller exits with code 3.
4. **Passthrough:** provider-prefixed IDs targeting a configured passthrough
   provider (`custom`) are accepted; the broker passes the
   provider-native ID to the AI SDK provider.

The broker never suffix-matches model IDs.

#### 4.7.5 `custom-url.ts` -- Custom Provider URL Validation

**Purpose:** Validate and secure custom API endpoint URLs at configuration and connection time.

**Security checks:**
1. Must be a valid URL (`new URL()`).
2. Protocol must be `http://` or `https://`.
3. URL credentials (`user:pass@`) and URL fragments (`#`) are always rejected.
4. Plain `http://` URLs are rejected unless `allow_insecure_custom` is `true` or the host is literal loopback (`localhost`, `127.0.0.1`, `::1`).
   Setting `allow_insecure_custom: true` only relaxes the `https://` scheme requirement and never bypasses IP, hostname, credential, fragment, or redirect guards.
5. **SSRF protection:** Blocks private, RFC 6890, and restricted IP ranges (including IPv4-mapped IPv6 literals), `.localhost` subdomains, and DNS lookups resolving to blocked or loopback addresses.
6. **Connection-time IP pinning and redirect blocking:** `createSafeCustomFetch` validates hostnames via `resolveAndValidateHostname`, pins resolved IPs at connection time via `node:http`/`node:https` (`pinnedHttpTransport`), and rejects all HTTP redirects (`redirect: "manual"` and 3xx rejection).

**Default URL:** `http://localhost:11434/v1` (Ollama default) when `custom_url` is unset.

---

### 4.8 `src/types/` -- Type Definitions

#### `consensus.ts`
- `Stance` -- `"for" | "against" | "neutral"`
- `ConsensusModelConfig` -- per-model configuration for a consensus round
- `ParticipantResponse` -- one model's response (`route_id`, `provider`,
  `provider_model_id`, `response`, `stance`, `error`)
- `ParticipantError` -- structured failure (`code: "provider_request_failed"`,
  `message`, `retryable`)
- `ConsensusRequest` -- full input to the consensus engine
- `ConsensusResult` / `ConsensusError` -- discriminated union (`ok: true` /
  `ok: false`)

#### `providers.ts`
- `ProviderId` -- enum of all 6 supported providers (`amazon-bedrock`, `anthropic`, `azure`, `custom`, `google-vertex`, `openrouter`)
- `BrokerModelInfo` -- one executable row in the `models.list/1` output
  (`route_id`, `provider`, `provider_model_id`, `canonical_model_id?`,
  `display_name`, `context_window?`, `output_limit?`, `supports_reasoning?`,
  `supports_tools?`, `supports_structured_output?`)
- `ProviderListEntry` -- `{ status: "catalog" | "passthrough", models:
  BrokerModelInfo[] }`
- `CacheInfo` -- `{ status: "fresh" | "stale", fetched_at, expires_at, warning? }`
- `ModelsListResponse` -- full `models.list/1` payload
- `CatalogJson` / `ProviderCatalog` / `ProviderModelEntry` -- raw catalog
  shapes (validated via Zod)
- `CacheMetadata` -- `models-cache/metadata.json` shape
- All validated with Zod schemas

#### `tools.ts`
- `ToolError` -- discriminated union: `type` (validation, configuration,
  not_found, execution, timeout, cancelled, unknown), `message`, `details?`,
  `retryable`
- `Result<T, E>` -- `{ ok: true; value: T } | { ok: false; error: E }`
  Used throughout the codebase as the standard success/failure pattern
  (never throws for expected errors)

---

### 4.9 `src/utils/` -- Utilities

#### `helpers.ts` -- Shared Helpers

- `getErrorMessage(err: unknown): string` -- extracts `.message` for Error
  objects, `String(err)` otherwise.
  Used everywhere to safely convert catch-clause values.
- `estimateTokenCount(text: string): number` -- simple heuristic:
  `ceil(text.length / 4)`.
  Used for embedded-file token budgets and fallback estimates.

#### `prompts.ts` -- Prompt Builders

- `buildConsensusPrompt()` and `buildSynthesisPrompt()` construct participant
  and synthesis prompts.
- `escapeEmbeddedFilesTag()` and `serializeSafeJson()` guard embedded file
  boundaries and structured prompt inputs.

#### `files.ts` -- File Embedding

- `embedFiles(paths: string[], options?: EmbedFilesOptions): Promise<EmbeddedFileResult>`
- **Path allowlist:** Only files under these roots can be embedded:
  - Current working directory (rejects `/` and `$HOME` as implicit roots)
  - System temp directory (`os.tmpdir()`)
- **Sensitive-file denylist:** Rejects secrets, credential files, `.env`
  variants (except safe templates), private keys, and sensitive `.git` entries.
- **Size and content limits:** 1 MiB per-file byte cap, binary NUL-byte
  rejection, and 50 k total token budget.
  Files that exceed limits or fail checks are skipped.
- **Deduplication and TOCTOU safety:** Duplicate paths are deduplicated, paths
  are canonicalized with `realpath()`, and files are opened with
  `O_NOFOLLOW | O_NONBLOCK`.

#### `logger.ts` -- Structured Logging
- Wraps [`@logtape/logtape`](https://jsr.io/@logtape/logtape) -- a
  structured logging library
- **Sinks:** stderr (all levels), rotating file (error.log, WARNING+)
- **Log file location:** `~/.config/chorus/logs/error.log`
  - Rotating: 5 MB max per file, max 3 files
- **Secret redaction:** `redactSecrets()` strips API keys, tokens, and
  credentials from log output using regex patterns:
  - Stripe keys (`sk-*`, `pk-*`)
  - Anthropic keys (`sk-ant-*`)
  - GitHub tokens (`ghp_*`, `gho_*`, etc.)
  - Slack tokens (`xox*-*`)
  - `Bearer` tokens
  - Google API keys (`AIza*`)
  - AWS access keys (`AKIA*`)
- **`WrappedLogger`** interface: `debug`, `info`, `warn`, `error` methods
  with optional structured context objects

---

## 5. Skills Directory

The `skills/` directory contains standalone skill definitions -- markdown
files that instruct AI coding agents how to use this project's tools.

### `skills/consensus/SKILL.md`
Documents the `consensus` CLI for agents. Covers:
- When to use (architecture decisions, code review, structured debate)
- The `list-models --json` discovery flow
- `route_id` resolution rules (exact, unqualified, ambiguous, passthrough)
- Usage examples (basic consensus, stances, thinking modes, file embedding,
  sequential mode, stdin JSON, opt-in custom synthesis model)
- Output JSON schema (`cli.consensus/2`)
- Exit codes
- Configuration (`~/.config/chorus/config.json`, `$ENV_VAR`,
  permissions `0700` / `0600`)

### `skills/consensus/scripts/install.sh`
Platform-specific binary installer. Downloads the correct `consensus-{platform}-{arch}`
binary from GitHub Releases. Features:
- Platform detection (Darwin/Linux, arm64/x64)
- Latest published stable release by default (resolved once via `/releases/latest`; pre-release tags rejected); the release in `CLI_VERSION` when that constant is set
- SHA-256 checksum verification (default on)
- `--prefix DIR` for custom install location
- `--no-verify` to skip checksum check
- macOS quarantine attribute stripping (`xattr -d com.apple.quarantine`)
- Atomic install (write to `.tmp`, then `mv`)

### `skills/delegate/SKILL.md`
Documents how agents can shell out to external CLI coding agents (Claude
Code, Codex, OpenCode, GitHub Copilot, Pi Coding Agent) for sub-tasks. Covers:
- Direct CLI invocations
- Parallel delegation patterns
- Delegate + consensus workflow
- Model-explicit, ephemeral Pi delegation with tool-restricted reviews

---

## 6. Release Workflows

Releases are driven by GitHub Actions. A maintainer prepares a release commit with the `package.json` version and git-cliff changelog, then pushes a `v*` tag. The tag push triggers `release.yml`, which validates the tag, runs CI, builds and smoke-tests each binary on a native runner, and creates a draft release. There is no local release script. See `RELEASING.md`.

---

## 7. Testing Strategy

**Framework:** Bun's built-in test runner (`bun:test`)

**Test files (15 total):**

| File | What it tests |
|---|---|
| `cli.test.ts` | `runCli` routing: help, version, subcommands, unknown commands |
| `config.test.ts` | `loadConfig`: config parsing, API key reading |
| `consensus.test.ts` | `runConsensus`: parallel/sequential modes, error handling, concurrency limiting, abort signals, model count validation |
| `consensus-cli.test.ts` | `runConsensusCommand`: flag validation, missing args, `--schema`, `--stdin-json`, model resolution |
| `providers.test.ts` | `createProviderRegistry`: model resolution, generateText, timeouts, error types, passthrough |
| `list-models.test.ts` | `runListModelsCommand`: empty providers, cache states, JSON output |
| `model-catalog.test.ts` | `loadCatalog`: cache miss / fresh / stale / refresh failure, `models.list.error/1` |
| `provider-map.test.ts` | `getModelsDevProviderKey`, inverse lookup, passthrough detection |
| `resolve-route.test.ts` | Exact / unqualified / ambiguous / passthrough resolution |
| `custom-url.test.ts` | Custom provider URL and connection-time hostname validation |
| `files.test.ts` | `embedFiles`: allowed paths, non-existent files, outside-allowlist, dedup, empty input |
| `installer.test.ts` | `install.sh`: binary download, checksum verification, `--prefix`, `--no-verify`, quarantine stripping, unsupported platforms |
| `logger.test.ts` | Secret redaction, log-level resolution, and context immutability |
| `package-files.test.ts` | Package manifest integrity: bin entry, files array, `.gitignore` |
| `delegate-skill.test.ts` | Delegate skill contract: Pi command flags, model and thinking precedence, trust, credentials, and failure behavior |

**Testing conventions:**
- **Module mocking** via `bun:test`'s `mock.module` is used pervasively:
  command handler tests mock `@/config`, `@/providers/registry`,
  `@/consensus`, and `@/utils/logger` at the module level, enabling
  unit tests without real API calls
- **Direct injection** for engine-level tests: `runConsensus` still accepts
  a `ProviderRegistry` parameter, so engine tests pass mock registries directly
- **Test helpers** (`tests/helpers.ts`): `testConfig()`, `testModel()`,
  `captureOutput()`, `captureStdout()` for setting up test fixtures and
  capturing stdout/stderr
- **`testConfig()`** creates a `ChorusConfig` pointing to `/tmp/skills-test`
  with all API keys unspecified by default
- **`captureOutput()`** temporarily overrides `process.stderr.write` and
  `process.stdout.write` to collect output
- **`captureStdout()`** convenience wrapper returning `{ result, output }`

---

## 8. Key Conventions & Patterns

### 8.1 Error Handling

- **Result type:** Functions return `Result<T, ToolError>` rather than
  throwing for expected failures. This makes error handling explicit at
  every call site.
- **ToolError types:** `validation`, `configuration`, `not_found`,
  `execution`, `timeout`, `cancelled`, `unknown`. The `retryable` boolean
  tells callers whether a retry makes sense.
- **Throws are reserved** for programmer errors (e.g., `< 2 models`),
  which are caught by the CLI handler and converted to exit code 1.

### 8.2 Provider Abstraction

- All provider interaction goes through the registry object returned by `createProviderRegistry`. No file outside
  `src/providers/` calls the AI SDK directly.
- `generateTextFn` is injectable (via `ProviderRegistryOptions`), enabling
  tests to mock the SDK without network calls or API keys.

### 8.3 Secret Safety

- API keys are loaded from environment variables or `$ENV_VAR` references
  in `~/.config/chorus/config.json`
- The logger (`logger.ts`) redacts known API key/token patterns before
  writing to stderr or log files
- Provider error messages are sanitised. The `generateText` catch block
  returns a structured `ParticipantError` rather than leaking upstream
  error details

### 8.4 Concurrency

- `runSettledWithConcurrency()` in `consensus.ts` is a general-purpose
  bounded-concurrency worker pool. It respects `maxConcurrency` and handles
  individual task failures gracefully via `PromiseSettledResult`.
- The models.dev catalog layer uses deterministic in-flight dedup and TTL
  cache to keep concurrent `list-models` invocations cheap.

### 8.5 Module Mocking

- Command handler tests (`consensus-cli.test.ts`, `list-models.test.ts`)
  use `bun:test`'s `mock.module` to replace imports at the module level.
  Modules commonly mocked: `@/config`, `@/utils/logger`,
  `@/providers/registry`, and `@/consensus`.
- Engine-level tests (`consensus.test.ts`) pass mock `ProviderRegistry`
  objects directly to `runConsensus()`, which still accepts the registry
  as a parameter.
- This pattern avoids mocking file-system modules or environment variables.

### 8.6 Zod Validation

- All external input is validated at parse time via Zod schemas:
  - Config JSON: `ChorusConfigSchema` in `config.ts`
  - Stdin JSON: `StdinConsensusSchema` in `commands/consensus.ts`
  - Models.dev catalog: `CatalogJsonSchema`, `ProviderCatalogSchema` in
    `types/providers.ts`
- Zod v4 is used (`zod/v4` import) -- uses the newer API with
  `z.coerce.number()`, `z.enum()`, etc.

---

## 9. Build & Development

| Command | Purpose |
|---|---|
| `bun run build` | Build `dist/cli.js` (Bun target, shebang `#!/usr/bin/env bun`) |
| `bun run build:binary` | Compile 5 standalone platform binaries into `dist/` |
| `bun run dev` | Run directly from source (`src/cli.ts`) |
| `bun run test` | Build `dist/cli.js` and run `bun test tests/*.test.ts --isolate` |
| `bun run lint:check` | Biome check (`biome check .`) |
| `bun run lint:fix` | Biome check with auto-fix (`biome check --write .`) |
| `bun run format:check` | Biome format check (`biome format .`) |
| `bun run format:fix` | Biome format with auto-fix (`biome format --write .`) |
| `bun run prepack` | Runs `bun run build` before packing/publishing |
| `bun run changelog:update` | Generate `CHANGELOG.md` via `git-cliff` (`.github/config/cliff.toml`) |

**Prepack:** `bun run prepack` runs `bun run build` before `bun publish`.

---

## 10. CI / Release Pipeline

Workflow file: `.github/workflows/release.yml`

- Triggered by pushing a new tag matching `v*`
- Requires the tag to equal `v` + `package.json` version
- Runs `ci.yml` on the tagged commit
- Builds each binary on its own native runner and runs `--version` and `--schema`:
  `consensus-darwin-arm64`, `consensus-darwin-x64`, `consensus-linux-arm64`,
  `consensus-linux-x64`, `consensus-windows-x64.exe`
- Generates `checksums.sha256` with `sha256sum`
- Creates a draft GitHub Release; a maintainer publishes it
- Requires the installer `CLI_VERSION` to be empty for stable releases, or equal to the tag for pre-releases
- The `install.sh` script downloads the latest published stable release, or the release in `CLI_VERSION`

**Release checklist:** See `RELEASING.md`.

---

## 11. External Dependencies

| Package | Version | Purpose |
|---|---|---|
| `ai` | `^7.0.178` | Vercel AI SDK core `generateText` function |
| `@ai-sdk/amazon-bedrock` | `^5.0.146` | Amazon Bedrock provider |
| `@ai-sdk/anthropic` | `^4.0.107` | Anthropic provider |
| `@ai-sdk/azure` | `^4.0.130` | Azure provider |
| `@ai-sdk/google-vertex` | `^5.0.143` | Google Vertex AI provider |
| `@ai-sdk/openai-compatible` | `^3.0.94` | Custom OpenAI-compatible endpoints |
| `@openrouter/ai-sdk-provider` | `^3.1.0` | OpenRouter provider |
| `minimist` | `^1.2.8` | CLI flag parsing |
| `zod` | `^4.6.7` | Schema validation |
| `@logtape/logtape` | `^2.4.2` | Structured logging (paired with custom 0600 rotating file sink) |
| `@biomejs/biome` (dev) | `2.6.8` | Linter and formatter |
| `@types/bun` + `@types/node` + `@types/minimist` (dev) | `^1.4.5` / `26.1.1` / `^1.2.5` | TypeScript type definitions |
| `typescript` (dev) | `^7.0.2` | TypeScript compiler |

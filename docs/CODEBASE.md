# `@zaherg/chorus` -- Codebase Overview

> Comprehensive reference for onboarding team members. Covers architecture,
> module responsibilities, data flow, conventions, and testing strategy.

---

## 1. Project Identity

| Field | Value |
|---|---|
| **Package** | `@zaherg/chorus` |
| **Runtime** | [Bun](https://bun.sh) (`1.3.9`) |
| **Language** | TypeScript (`5.9.3`) |
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
│   │   ├── consensus.ts         # `consensus` CLI subcommand handler
│   │   └── list-models.ts       # `list-models` CLI subcommand handler (models.list/1)
│   ├── prompts/
│   │   └── consensus.ts         # System prompt literal
│   ├── providers/
│   │   ├── registry.ts          # createProviderRegistry factory (SDK factories,
│   │   │                          generateText, model resolution to AI SDK)
│   │   ├── model-catalog.ts     # models.dev catalog fetch, cache, validate, normalize
│   │   ├── provider-map.ts      # Internal ProviderId to models.dev provider key map
│   │   ├── resolve-route.ts     # route_id parsing, exact / unqualified / passthrough
│   │   └── custom-url.ts        # Custom provider URL validation + SSRF guard
│   ├── types/
│   │   ├── index.ts             # Re-exports
│   │   ├── consensus.ts         # ConsensusRequest, ConsensusResult, ConsensusError,
│   │   │                          ParticipantResponse
│   │   ├── providers.ts         # Zod schemas for ProviderId, ModelsListResponse,
│   │   │                          BrokerModelInfo
│   │   └── tools.ts             # ToolError, Result<T,E> (discriminated union)
│   └── utils/
│       ├── files.ts             # File-embedding with path allowlist + token budget
│       └── logger.ts            # Structured logging (LogTape), secret redaction
├── src/utils.ts                 # getErrorMessage() + estimateTokenCount() helpers
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
│       ├── prepare-release.yml  # Manual dispatch: bump version, tag
│       ├── release-orchestrator.yml # Tag push: test gate + draft release
│       ├── changelog.yml        # Reusable changelog update (git-cliff)
│       └── release.yml          # Reusable binary build + draft release
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
               consensus --models "openai/gpt-5.2,anthropic/claude-sonnet-4-5" --prompt "..."
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│  cli.ts (runCli)                                                  │
│  ├─ Routes to commands/consensus.ts or commands/list-models.ts    │
│  └─ If no subcommand, treats bare flags as `consensus`            │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  config.ts (loadConfig)                                           │
│  ├─ Validates config.json (ChorusConfigSchema)                    │
│  └─ Returns ChorusConfig + Paths                                  │
└──────────────────────────────┬───────────────────────────────────┘
                               │
              ┌────────────────┴─────────────────┐
              │  list-models path                │  consensus path
              ▼                                  ▼
┌─────────────────────────────────┐  ┌────────────────────────────────┐
│ providers/model-catalog.ts       │  │ providers/resolve-route.ts     │
│ ├─ Read models-cache/*.json     │  │ ├─ Parse `route_id`            │
│ ├─ Refresh from models.dev       │  │ ├─ Exact / unqualified /       │
│ │   on miss or --refresh         │  │ │   passthrough resolution    │
│ ├─ Validate (CatalogJsonSchema)  │  │ └─ Return BrokerModelInfo[]    │
│ └─ Emit models.list/1            │  │                                │
│    filtered to configured        │  │ providers/registry.ts          │
│    providers                     │  │ ├─ Create AI SDK provider      │
└─────────────────────────────────┘  │ ├─ Call generateText() per     │
                                     │ │   participant                 │
                                     │ └─ Optional synthesis call      │
                                     │     (only when                 │
                                     │      --synthesis-model set)    │
                                     └─────────────┬──────────────────┘
                                                   │
                                                   ▼
                                     ┌────────────────────────────────┐
                                     │  consensus.ts (runConsensus)    │
                                     │  ├─ Fan out participant calls   │
                                     │  ├─ Collect raw responses       │
                                     │  └─ Emit ConsensusResult        │
                                     │     (cli.consensus/2)           │
                                     └────────────────────────────────┘
```

---

## 4. Module Deep-Dive

### 4.1 `src/cli.ts` -- Entry Point

**Purpose:** Top-level CLI routing. Detects whether `consensus` was invoked
with a subcommand or with bare flags.

**Exports:**
- `runCli(args: string[]): Promise<number>` -- the entry function
- Calls `printHelp()` for `--help`, `help`, or no args
- Calls `runConsensusCommand()` for bare flags or the `consensus` subcommand
- Calls `runListModelsCommand()` for `list-models`
- `import.meta.main` block reads `process.argv` and calls `runCli`. The CLI
  reads its version from `package.json` at build time.

**Design note:** Bare flags (`--models`, etc.) are treated as a shorthand for
`consensus --models ...`. The subcommand `consensus` is optional -- either form
works.

---

### 4.2 `src/config.ts` -- Configuration

**Purpose:** Load and validate `~/.config/chorus/config.json`.

**Config keys** (subset; full schema in `docs/configuration.md`):

| Key | Purpose |
|---|---|
| `cli_timeout_ms` | Consensus CLI timeout (default 30 000) |
| `provider_timeout_ms` | Per-provider request timeout (default 120 000) |
| `log_level` | `"debug" \| "info" \| "warn" \| "error"` (default `"info"`) |
| `max_concurrent_processes` | Parallel model query limit (default 3) |
| `openai_api_key` | OpenAI API key |
| `anthropic_api_key` | Anthropic API key |
| `google_api_key` | Google AI API key |
| `openrouter_api_key` | OpenRouter API key |
| `custom_api_key` | Custom endpoint API key |
| `custom_url` | Custom endpoint base URL |
| `allow_insecure_custom` | Set to `true` to allow `http://` custom URLs |
| `<provider>_api_key` | One key slot per supported provider (Alibaba, Amazon Bedrock, Azure, Baseten, Cerebras, Cohere, DeepInfra, DeepSeek, Fireworks, Gateway, Google Vertex, Groq, Hugging Face, Mistral, Perplexity, TogetherAI, Vercel, xAI) |

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
   - **Flag-based:** `--models "openai/gpt-5.2,anthropic/claude-sonnet-4-5" --prompt "..." --stance "openai/gpt-5.2=for"`
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
  - Thinking mode (Anthropic budget tokens, OpenAI reasoning effort)
  - Timeout signals (merged parent + provider timeout)
  - Error classification: `timeout`, `execution`, `not_found`, `configuration`
- **Provider factory caching:** SDK provider instances (OpenAI client,
  Anthropic client, etc.) are lazily created and cached per provider ID.
- **Passthrough:** For configured passthrough providers (`custom`,
  `gateway`), the registry passes provider-prefixed IDs through to the AI
  SDK provider.

**Supported providers:** all 23 `ProviderId` slots. The 21 catalog-backed providers are Alibaba, Amazon Bedrock, Anthropic, Azure, Baseten, Cerebras, Cohere, DeepInfra, DeepSeek, Fireworks, Google, Google Vertex, Groq, Hugging Face, Mistral, OpenAI, OpenRouter, Perplexity, TogetherAI, Vercel, and xAI. The 2 passthrough providers are Custom and Gateway. Catalog-backed providers expose `route_id` rows from `models.list/1`; passthrough providers accept provider-prefixed IDs.

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
  `undefined` for passthrough providers (`custom`, `gateway`).
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
   provider (`custom`, `gateway`) are accepted; the broker passes the
   provider-native ID to the AI SDK provider.

The broker never suffix-matches model IDs.

#### 4.7.5 `custom-url.ts` -- Custom Provider URL Validation

**Purpose:** Validate and secure custom API endpoint URLs.

**Security checks:**
1. Must be a valid URL (`new URL()`)
2. Protocol must be `http://` or `https://`
3. Insecure (`http://`) URLs are rejected **unless**:
   - `allow_insecure_custom` is `true`, **or**
   - The host is loopback (`localhost`, `127.0.0.1`, `::1`)
4. **SSRF protection:** Blocks private/restricted IP ranges:
   - IPv4: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
     `169.254.0.0/16`, `0.0.0.0/8`, non-`127.0.0.1` loopback
   - IPv6: `fe80::/10`, `fc00::/7`, `fd00::/8`
   - `*.localhost` domains (except bare `localhost`)
5. Trailing dots on hostnames are stripped
6. IPv6 bracket notation `[::1]` is unwrapped

**Default URL:** `http://localhost:11434/v1` (Ollama default) when
`custom_url` is unset.

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
- `ProviderId` -- enum of all 23 supported providers
- `BrokerModelInfo` -- one executable row in the `models.list/1` output
  (`route_id`, `provider`, `provider_model_id`, `canonical_model_id?`,
  `display_name`, `context_window?`, `output_limit?`, `supports_reasoning?`,
  `supports_tools?`, `supports_structured_output?`)
- `ProviderListEntry` -- `{ status: "catalog" | "passthrough", models:
  BrokerModelInfo[] }`
- `CacheInfo` -- `{ status: "fresh" | "stale", fetched_at, expires_at }`
- `ModelsListResponse` -- full `models.list/1` payload
- `ModelsListError` -- `models.list.error/1` payload
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

#### `src/utils.ts` -- Shared Utilities

- `getErrorMessage(err: unknown): string` -- extracts `.message` for Error
  objects, `String(err)` otherwise. Used everywhere to safely convert
  catch-clause values.
- `estimateTokenCount(text: string): number` -- simple heuristic:
  `ceil(text.length / 4)`. Used as a fallback when the provider doesn't
  report token counts in usage metadata. Not intended to be precise.

#### `files.ts` -- File Embedding

- `embedFiles(paths: string[]): Promise<EmbeddedFileResult>`
- **Path allowlist:** Only files under these roots can be embedded:
  - Current working directory
  - System temp directory (`os.tmpdir()`)
  - `~/.claude`, `~/.codex`, `~/.copilot`, `~/.opencode`
- **Token budget:** 50 k tokens max (or 40% of model context window,
  whichever is smaller). Files that would exceed the budget are skipped.
- **Deduplication:** Duplicate paths are resolved via `new Set()`.
- **Safety:** All paths are resolved with `realpath()` (symlinks followed,
  canonicalised) before checking the allowlist.
- Uses `Bun.file()` for reading -- Bun-native I/O.

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
- SHA-256 checksum verification (default on)
- `--prefix DIR` for custom install location
- `--no-verify` to skip checksum check
- macOS quarantine attribute stripping (`xattr -d com.apple.quarantine`)
- Atomic install (write to `.tmp`, then `mv`)

### `skills/delegate/SKILL.md`
Documents how agents can shell out to external CLI coding agents (Claude
Code, Codex, OpenCode, GitHub Copilot) for sub-tasks. Covers:
- Direct CLI invocations
- Parallel delegation patterns
- Delegate + consensus workflow

---

## 6. Release Workflows

Releases are driven by GitHub Actions. `prepare-release.yml` (manual dispatch) computes the next version, bumps `package.json` and `skills/consensus/scripts/install.sh` `CLI_VERSION` together, updates `CHANGELOG.md` via git-cliff, then pushes a `v*` tag. The tag push triggers `release-orchestrator.yml`, which runs the test gate and builds binaries, checksums, and a draft release. There is no local release script.---

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
| `files.test.ts` | `embedFiles`: allowed paths, non-existent files, outside-allowlist, dedup, empty input |
| `docs.test.ts` | Documentation contract: no stale references to old names |
| `installer.test.ts` | `install.sh`: binary download, checksum verification, `--prefix`, `--no-verify`, quarantine stripping, unsupported platforms |
| `package-files.test.ts` | Package manifest integrity: bin entry, files array, `.gitignore` |
| `release-contract.test.ts` | Release workflow: artifact naming, version bump, malformed version rejection |

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
| `bun run build:binary` | Compile to standalone binary (`consensus`) |
| `bun run dev` | Run directly from source (`src/cli.ts`) |
| `bun test tests/*.test.ts` | Run all tests |
| `bun run lint` | Biome check (lint + format) |
| `bun run format` | Biome format (auto-fix) |
| `bun run format:check` | Biome format check (CI) |
| `bun run changelog:update` | Generate CHANGELOG.md via git-cliff |

**Prepack:** `bun run prepack` runs `bun run build` before `bun publish`.

---

## 10. CI / Release Pipeline

Workflow file: `.github/workflows/release.yml`

- Triggered by git tags matching `v*`
- Builds platform-specific binaries: `consensus-darwin-arm64`,
  `consensus-darwin-x64`, `consensus-linux-arm64`, `consensus-linux-x64`
- Generates `checksums.sha256` via `shasum -a 256 consensus-*`
- Creates a GitHub Release with all binaries attached
- The `install.sh` script downloads from these releases

**Release checklist:** See `RELEASING.md`.

---

## 11. External Dependencies

| Package | Purpose |
|---|---|
| `ai` (`^7.0.0`) | Vercel AI SDK -- core `generateText` function |
| `@ai-sdk/openai` | OpenAI provider |
| `@ai-sdk/anthropic` | Anthropic provider |
| `@ai-sdk/google` | Google AI provider |
| `@ai-sdk/openai-compatible` | Custom OpenAI-compatible endpoints |
| `@openrouter/ai-sdk-provider` | OpenRouter provider |
| `zod` (`^4.3.6`) | Schema validation |
| `@logtape/logtape` + `@logtape/file` | Structured logging + rotating file sink |
| `@types/bun` + `@types/node` | TypeScript type definitions |

# Development

## Prerequisites

- [Bun](https://bun.sh) 1.4.5 (pinned in `package.json`)
- Node.js types (auto-installed via `bun install`)

## Setup

```bash
git clone https://github.com/zaherg/chorus.git
cd chorus
bun install
```

## Project Structure

See [Architecture](./architecture.md) for the full module map.

```
src/
  cli.ts              Entry point
  config.ts           Configuration loading
  consensus.ts        Core consensus engine
  commands/           CLI command handlers
  prompts/            System prompts
  providers/          Provider registry, models.dev catalog & cache, route resolution, custom URL guards
  types/              Zod schemas and TypeScript types
  utils/              Helpers (`helpers.ts`), file embedding (`files.ts`), logging (`logger.ts`), prompt builders (`prompts.ts`)
skills/               Agent skill definitions
tests/                bun:test suite
docs/                 Documentation
```

## Commands

| Command | Description |
|---|---|
| `bun run test` | Build `dist/cli.js`, then run the test suite |
| `bun run build` | Bundle CLI to `dist/cli.js` |
| `bun run build:binary` | Compile 5 standalone platform binaries into `dist/` |
| `bun run dev` | Run CLI from source (`bun run src/cli.ts`) |
| `bun run lint:check` | Check lint rules via Biome |
| `bun run lint:fix` | Auto-fix lint violations via Biome |
| `bun run format:fix` | Auto-fix formatting via Biome |
| `bun run format:check` | Check formatting without writing |
| `bunx tsc -p tsconfig.json --noEmit` | TypeScript type check |

### Running from source

```bash
bun run src/cli.ts --help
bun run src/cli.ts list-models
bun run src/cli.ts --schema
```

## Build

```bash
bun run build
```

Produces `dist/cli.js` with a bun shebang. This is the artifact distributed via npm.

For standalone binaries (no Bun runtime needed):

```bash
bun run build:binary
```

Produces 5 platform binaries under `dist/`:
`consensus-darwin-arm64`, `consensus-darwin-x64`, `consensus-linux-x64`, `consensus-linux-arm64`, and `consensus-windows-x64.exe`.

## Testing

```bash
bun run test
```

The package test checks `dist/cli.js`, so the script builds it before running the suite.

Run specific test files:

```bash
bun test tests/config.test.ts
bun test tests/consensus.test.ts
```

### Test Strategy

- **Module mocking:** Tests use `bun:test`'s `mock.module` to replace imports. Command handler tests mock `@/config`, `@/utils/logger`, `@/providers/registry`, and `@/consensus` at the module level.
- **Fake API keys:** Tests use empty or fake keys. No live provider API calls.
- **Unit tests:** Individual modules -- config validation, model resolution, token estimation, file embedding
- **Integration tests:** CLI commands with mocked provider registry via `mock.module`
- **Contract tests:** Release artifact structure, package file integrity

### Writing Tests

Command handler tests use `mock.module` to replace dependencies:

```typescript
import { mock } from "bun:test";

mock.module("@/config", () => ({
    loadConfig: async () => testConfig(),
}));

mock.module("@/utils/logger", () => ({
    configureLogging: async () => {},
}));

mock.module("@/providers/registry", () => ({
    createProviderRegistry: () => mockRegistry,
}));
```

Engine-level tests (e.g., `consensus.test.ts`) pass a mock `ProviderRegistry` directly to `runConsensus()`, no `mock.module` needed.

See existing tests in `tests/` for patterns.

## Code Quality

### Formatting & Linting

Uses [Biome](https://biomejs.dev) for both linting and formatting:

```bash
bun run lint:check    # Check lint rules
bun run lint:fix      # Auto-fix lint violations
bun run format:fix    # Auto-fix formatting
bun run format:check  # Check formatting without writing
```

### TypeScript

Strict TypeScript with ES modules. Configuration in `tsconfig.json`. Run type checking:

```bash
bunx tsc -p tsconfig.json --noEmit
```

## Conventions

### Error Handling

- Return `Result<T, ToolError>` for expected failures: `{ ok: true, value: T }` on success, `{ ok: false, error: ToolError }` on failure
- Throw exceptions only for programmer errors (e.g., missing required arguments, impossible states)
- Use `getErrorMessage()` utility to extract messages from unknown error shapes
- `ToolError` has `type` (7 categories), `message`, optional `details`, and `retryable` flag

### Module Imports

Use `@/` path alias for internal imports (configured in `tsconfig.json`):

```typescript
import { loadConfig } from "@/config";
import { runConsensus } from "@/consensus";
```

### Zod Validation

Use Zod v4 for all runtime validation. Prefer `z.coerce` for number parsing from config files. Use `.default()` for optional fields with sensible defaults.

### Secret Safety

- Never log API keys
- Config values use `$ENV_VAR` references, not literal secrets
- Config file permissions enforced: directory `0700`, file `0600`

## CI / Release

Releases are automated via GitHub Actions.
Pushing a `v*` tag triggers `release.yml`, which validates the tag against `package.json` and the installer `CLI_VERSION`, runs `ci.yml`, builds and smoke-tests each binary on a native runner, and creates a draft release.
There is no local release script; see [RELEASING.md](../RELEASING.md) for the steps.

### Changelog

Uses [git-cliff](https://github.com/orhun/git-cliff) with `.github/config/cliff.toml`:

```bash
bun run changelog:update -- --tag vX.Y.Z
```

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Dependencies

### Runtime

| Package | Version | Purpose |
|---|---|---|
| `@ai-sdk/amazon-bedrock` | `^5.0.146` | Amazon Bedrock provider |
| `@ai-sdk/anthropic` | `^4.0.107` | Anthropic provider |
| `@ai-sdk/azure` | `^4.0.130` | Azure provider |
| `@ai-sdk/google-vertex` | `^5.0.143` | Google Vertex AI provider |
| `@ai-sdk/openai-compatible` | `^3.0.94` | Custom OpenAI-compatible endpoints |
| `@logtape/logtape` | `^2.4.2` | Structured logging |
| `@openrouter/ai-sdk-provider` | `^3.1.0` | OpenRouter provider |
| `ai` | `^7.0.178` | Vercel AI SDK core |
| `minimist` | `^1.2.8` | CLI argument parsing |
| `zod` | `^4.6.7` | Schema validation |

### Dev

| Package | Version | Purpose |
|---|---|---|
| `@biomejs/biome` | `2.6.8` | Linter and formatter |
| `@types/bun` | `^1.4.5` | Bun type definitions |
| `@types/minimist` | `^1.2.5` | `minimist` type definitions |
| `@types/node` | `26.1.1` | Node.js type definitions |
| `typescript` | `^7.0.2` | TypeScript compiler |

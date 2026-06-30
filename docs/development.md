# Development

## Prerequisites

- [Bun](https://bun.sh) 1.3.9 or newer
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
  providers/          Provider registry, discovery, selection
  types/              Zod schemas and TypeScript types
  utils/              Error, file, logging, token utilities
skills/               Agent skill definitions
tests/                bun:test suite
docs/                 Documentation
```

## Commands

| Command | Description |
|---|---|
| `bun test` | Run test suite |
| `bun run build` | Bundle CLI to `dist/cli.js` |
| `bun run build:binary` | Compile standalone binary |
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

For a standalone binary (no Bun runtime needed):

```bash
bun run build:binary
```

Produces `consensus` binary.

## Testing

```bash
bun test
```

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

Releases are automated via GitHub Actions. Run `prepare-release.yml` (manual dispatch) to bump the version, update `CHANGELOG.md`, and push a `v*` tag. The tag push triggers `release-orchestrator.yml`, which runs the test gate and creates a draft release with binaries. There is no local release script.

### Changelog

Uses [git-cliff](https://github.com/orhun/git-cliff) with `cliff.toml` config:

```bash
bun run changelog:update
```

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Dependencies

### Runtime

| Package | Version | Purpose |
|---|---|---|
| `ai` | ^7.0.0 | Vercel AI SDK core |
| `@ai-sdk/openai` | ^3.0.0 | OpenAI provider |
| `@ai-sdk/anthropic` | ^3.0.0 | Anthropic provider |
| `@ai-sdk/google` | ^3.0.0 | Google provider |
| `@openrouter/ai-sdk-provider` | ^2.10.0 | OpenRouter provider |
| `zod` | ^4.3.6 | Schema validation |
| `@logtape/logtape` | * | Structured logging |

Plus additional `@ai-sdk/*` SDK packages for the remaining catalog-backed providers.

### Dev

| Package | Version | Purpose |
|---|---|---|
| `@types/bun` | ^1.3.14 | Bun type definitions |
| `@types/node` | 25.4.0 | Node.js type definitions |
| `typescript` | ^5.9.3 | TypeScript compiler |

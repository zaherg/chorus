# Getting Started

## Prerequisites

- [Bun](https://bun.sh) 1.3.9 or newer (for source builds)
- API keys for at least one supported provider

## Installation

### NPM (recommended)

```bash
npm install -g @zaherg/chorus
consensus --version
```

Requires Bun on `PATH`. The npm package exposes `consensus` from the built CLI runtime.

### Agent skill install

If you added the consensus skill to your agent, run the installer from the skill directory:

```bash
skills/consensus/scripts/install.sh
bin/consensus --version
```

The installer downloads the pinned GitHub Release binary into `bin/consensus`. Flags:

- `--prefix DIR` -- install to `DIR/consensus`
- `--no-verify` -- skip checksum verification

### From source

```bash
git clone https://github.com/zaherg/chorus.git && cd chorus
bun install
bun run build   # produces dist/cli.js
```

## Configuration

First run creates `~/.config/chorus/config.json` with empty defaults. Edit it to add API keys:

```json
{
  "openai_api_key": "$OPENAI_API_KEY",
  "anthropic_api_key": "$ANTHROPIC_API_KEY",
  "google_api_key": "$GOOGLE_API_KEY"
}
```

Values can reference shell variables with `$ENV_VAR` syntax. On POSIX systems, the config directory uses `0700` and the file uses `0600` permissions.

Full config schema: see [Configuration](./configuration.md).

## First Consensus

### 1. Discover available routes

Run `list-models --json` first. The output is a `models.list/1` payload with the configured-provider catalog. Use the `route_id` values to map the user's wording to a configured provider.

```bash
consensus list-models --json
```

Example output (truncated):

```json
{
  "schema": "models.list/1",
  "cache": {
    "status": "fresh",
    "fetched_at": "2026-07-08T00:00:00.000Z",
    "expires_at": "2026-07-09T00:00:00.000Z"
  },
  "providers": {
    "openai": {
      "status": "catalog",
      "models": [
        {
          "route_id": "openai/gpt-5.2",
          "provider": "openai",
          "provider_model_id": "gpt-5.2",
          "display_name": "GPT-5.2",
          "context_window": 400000,
          "supports_reasoning": true
        }
      ]
    }
  }
}
```

Match the user's request to a `route_id` for each model you want to query. Prefer exact provider-qualified `route_id` values. Avoid bare IDs when ambiguity is possible.

### 2. Run a consensus

Pass 2 or more `route_id` values to `--models`:

```bash
consensus \
  --models "openai/gpt-5.2,anthropic/claude-sonnet-4-5" \
  --prompt "Should we use a monorepo?"
```

### 3. Read the output

The CLI returns JSON with schema `cli.consensus/2`:

```json
{
  "ok": true,
  "schema": "cli.consensus/2",
  "models": [
    {
      "route_id": "openai/gpt-5.2",
      "provider": "openai",
      "provider_model_id": "gpt-5.2",
      "response": "monorepo ...",
      "stance": "for",
      "error": null
    },
    {
      "route_id": "anthropic/claude-sonnet-4-5",
      "provider": "anthropic",
      "provider_model_id": "claude-sonnet-4-5",
      "response": "Consider polyrepo ...",
      "stance": "against",
      "error": null
    }
  ],
  "synthesis": null,
  "synthesis_error": null,
  "embeddedFiles": {
    "embedded_files": [],
    "embedded_text": "",
    "skipped_files": [],
    "total_tokens": 0
  }
}
```

The CLI is a broker. It returns raw participant responses for the agent to compare and combine. Synthesis is opt-in via `--synthesis-model`.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0    | Success |
| 1    | Consensus error (all participants failed, config error, catalog unavailable) |
| 2    | Argument parse error (missing required flags, invalid values) |
| 3    | Model resolution error (unknown or ambiguous model ID) |

## Key Concepts

### Consensus

Send one prompt to multiple LLM models, collect independent responses, and return them to the agent. The broker returns a successful response when at least one participant call completed; failed participants are reported inline with `response: null` and a structured `error`.

### Synthesis (opt-in)

CLI-side synthesis is opt-in. Provide `--synthesis-model <route_id>` when the user explicitly asks for it. When synthesis fails, raw participant responses are kept and `synthesis_error` is populated; the command does not fail solely because synthesis failed.

### Modes

- **Parallel (default):** All models queried concurrently. Each model sees only the original prompt.
- **Sequential (`--sequential`):** Models queried one at a time. Each model sees prior responses plus the original prompt.

See [CONCEPTS.md](../CONCEPTS.md) for full domain vocabulary.

## Next Steps

- [CLI Reference](./cli-reference.md) for all commands and flags
- [Providers](./providers.md) for adding more providers
- [Agent Skills](./agent-skills.md) for using skills inside coding agents

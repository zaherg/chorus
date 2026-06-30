# CLI Reference

## `consensus`

Run a multi-model consensus. The CLI brokers raw model responses and returns one record per requested model. It does not synthesize by default.

```
consensus --models "<route_id>,<route_id>" --prompt "..." [flags]
```

### USAGE

```
consensus --models "<route_id>,<route_id>" --prompt "..." [flags]
consensus --stdin-json
```

### FLAGS

#### Required

| Flag | Description |
|---|---|
| `--models <ids>` | Comma-separated model IDs as `route_id` values. Two or more. |
| `--prompt <text>` | Prompt text (or use `--stdin-json`). |

#### Optional

| Flag | Description |
|---|---|
| `--stance <model=for\|against\|neutral>` | Per-model stance (repeatable). |
| `--thinking-mode <model=minimal\|low\|medium\|high\|max>` | Per-model thinking mode (repeatable). |
| `--temperature <0-1>` | Global temperature. |
| `--temperature-model <model=0-1>` | Per-model temperature (repeatable). |
| `--synthesis-model <route_id>` | Opt-in CLI-side synthesis. Omit by default; combine raw responses in the agent. |
| `--sequential` | Sequential mode (default: parallel). |
| `--files <paths>` | Comma-separated file paths to embed. |
| `--stdin-json` | Read full request as JSON from stdin. |
| `--schema` | Print output JSON schema and exit. |

### `--models` semantics

`--models` accepts exact provider-qualified `route_id` values returned by `consensus list-models --json`. Example:

```bash
consensus --models "openai/gpt-5.2,anthropic/claude-sonnet-4-5,google/gemini-2.5-pro" \
  --prompt "Should we use a monorepo or polyrepo?"
```

Bare provider-native IDs (for example `gpt-5.2`) are accepted only when exactly one configured provider exposes that exact provider-native model ID. The CLI never suffix-matches model IDs. When two or more configured providers expose the same provider-native ID, the broker returns a structured ambiguity response listing candidate `route_id` values; it does not choose. Use provider-prefixed IDs to disambiguate.

For `passthrough` providers (`custom`, `gateway`), the CLI accepts provider-prefixed IDs (for example `custom/local-model`) only when the model is known to the agent or supplied explicitly by the user.

### OUTPUT

JSON to stdout, schema `cli.consensus/2`:

```json
{
  "ok": true,
  "schema": "cli.consensus/2",
  "models": [
    {
      "route_id": "openai/gpt-5.2",
      "provider": "openai",
      "provider_model_id": "gpt-5.2",
      "response": "...",
      "stance": "for",
      "error": null
    },
    {
      "route_id": "anthropic/claude-sonnet-4-5",
      "provider": "anthropic",
      "provider_model_id": "claude-sonnet-4-5",
      "response": null,
      "stance": null,
      "error": {
        "code": "provider_request_failed",
        "message": "Provider request failed",
        "retryable": true
      }
    }
  ],
  "synthesis": null,
  "synthesis_error": null,
  "embeddedFiles": {
    "embedded_files": ["src/auth.ts"],
    "embedded_text": "...",
    "skipped_files": [],
    "total_tokens": 500
  }
}
```

Field notes:
- `models[].route_id` -- the executable route the agent passed.
- `models[].provider` -- internal provider ID (for example `openai`).
- `models[].provider_model_id` -- the model ID handed to the AI SDK provider.
- `models[].response` -- raw text from the provider, or `null` on failure.
- `models[].stance` -- the stance the model ultimately took, or `null` on failure.
- `models[].error` -- structured failure, or `null` on success.
- `synthesis` -- synthesized text, or `null` when synthesis was not requested or failed.
- `synthesis_error` -- structured synthesis failure, or `null` when synthesis succeeded or was not requested.
- `embeddedFiles` -- result of embedding referenced files into prompts.

The command returns a successful broker response when at least one participant call completed. Failed participants keep their `route_id` / `provider` / `provider_model_id` and carry `response: null` plus a structured `error`. If all participant calls fail or a command-level catalog load fails, the command exits non-zero with a `cli.consensus.error/1` payload.

Example command-level error:

```json
{
  "ok": false,
  "schema": "cli.consensus.error/1",
  "error": {
    "code": "catalog_unavailable",
    "message": "Model catalog unavailable"
  }
}
```

### Stdin JSON Input

When `--stdin-json` is used, pipe a JSON object:

```json
{
  "models": ["openai/gpt-5.2", "google/gemini-2.5-pro"],
  "prompt": "Evaluate this approach",
  "findings": "optional findings text",
  "step": "optional step description",
  "stances": { "openai/gpt-5.2": "for", "google/gemini-2.5-pro": "against" },
  "thinking_modes": { "openai/gpt-5.2": "high" },
  "temperatures": { "openai/gpt-5.2": 0.3 },
  "temperature": 0.7,
  "files": ["src/main.ts"],
  "synthesis_model": "anthropic/claude-sonnet-4-5"
}
```

### EXIT CODES

| Code | Meaning |
|---|---|
| 0 | Success (at least one participant response collected) |
| 1 | Broker error (config load, all participants failed, or unrecoverable catalog error) |
| 2 | Argument parse error or invalid stdin JSON |
| 3 | Model resolution error (ambiguous unqualified input, unknown `route_id`, or no providers configured) |

## `consensus list-models`

List model IDs available from configured providers. The broker fetches and caches the public models.dev catalog and filters it to configured providers.

```
consensus list-models [--json] [--refresh] [--help]
```

### FLAGS

| Flag | Description |
|---|---|
| `--json` | Output as `models.list/1` JSON payload (see below). |
| `--refresh` | Force a fresh fetch from models.dev before listing; falls back to a readable stale cache if refresh fails. |
| `--help`, `-h` | Print help and exit. |

### OUTPUT (human-readable)

```
3 configured providers:

  openai (catalog)
    - openai/gpt-5.2  GPT-5.2 [ctx: 400000] [reasoning] [tools] [structured]
    - openai/gpt-5-mini  GPT-5 mini [ctx: 200000] [tools]

  anthropic (catalog)
    - anthropic/claude-sonnet-4-5  Claude Sonnet 4.5 [ctx: 200000] [reasoning] [tools]

  custom (passthrough)
    (no catalog; use provider-prefixed IDs)

cache: fresh (fetched 2026-07-08T00:00:00.000Z, expires 2026-07-09T00:00:00.000Z)
```

### OUTPUT (JSON)

JSON payload with schema `models.list/1`. Only configured providers are listed; unconfigured providers are omitted.

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
          "canonical_model_id": "openai/gpt-5.2",
          "display_name": "GPT-5.2",
          "context_window": 400000,
          "output_limit": 128000,
          "supports_reasoning": true,
          "supports_tools": true,
          "supports_structured_output": true
        }
      ]
    },
    "custom": {
      "status": "passthrough",
      "models": []
    }
  }
}
```

Per-provider `status`:
- `catalog` -- the broker has models.dev rows for this configured provider; the `models[]` rows are executable `route_id` values.
- `passthrough` -- the provider is configured but has no catalog rows; the agent may still send provider-prefixed IDs that the provider API will accept or reject.

`cache.status`:
- `fresh` -- successful fetch or current cache.
- `stale` -- refresh failed, but the previous cache was used.

If refresh fails and no usable cache exists, the CLI prints a `models.list.error/1` payload with `error.code: "catalog_unavailable"` and exits non-zero.

The broker does not rank or choose models. `display_name`, `context_window`, `output_limit`, `supports_reasoning`, `supports_tools`, and `supports_structured_output` are stable metadata for the agent to consider; the broker does not use them to pick a "best" model.

## `consensus --schema`

Print the output JSON schema.

```
consensus --schema
```

Outputs a JSON object describing the consensus output shape with type hints.

## Global Flags

| Flag | Description |
|---|---|
| `--version`, `-v` | Print version and exit |
| `--help`, `-h`, `help` | Print help and exit |

## EXAMPLES

### List models and pick routes

```bash
consensus list-models --json
# Match the user's wording to a `route_id` returned above.
```

### Basic parallel consensus

```bash
consensus \
  --models "openai/gpt-5.2,google/gemini-2.5-pro" \
  --prompt "Should we use a monorepo or polyrepo?"
```

### With stances

```bash
consensus \
  --models "openai/gpt-5.2,google/gemini-2.5-pro" \
  --prompt "Should we migrate from REST to GraphQL?" \
  --stance "openai/gpt-5.2=for" \
  --stance "google/gemini-2.5-pro=against"
```

### With per-model thinking mode

```bash
consensus \
  --models "openai/gpt-5.2,anthropic/claude-sonnet-4-5" \
  --prompt "Review this architecture for scalability" \
  --thinking-mode "openai/gpt-5.2=high" \
  --thinking-mode "anthropic/claude-sonnet-4-5=max"
```

### Sequential consensus

```bash
consensus \
  --models "openai/gpt-5.2,google/gemini-2.5-pro" \
  --prompt "What are the trade-offs?" \
  --sequential
```

### With embedded files

```bash
consensus \
  --models "openai/gpt-5.2,google/gemini-2.5-pro" \
  --prompt "Review this code" \
  --files "src/cli.ts,src/config.ts"
```

### Custom synthesis model (opt-in)

```bash
consensus \
  --models "openai/gpt-5.2,google/gemini-2.5-pro" \
  --prompt "..." \
  --synthesis-model "anthropic/claude-sonnet-4-5"
```

### Stdin JSON

```bash
echo '{"models":["openai/gpt-5.2","google/gemini-2.5-pro"],"prompt":"Should I use tabs or spaces?"}' | \
  consensus --stdin-json
```

### Passthrough provider example

```bash
# Only `custom` and `gateway` are passthrough providers. All other providers
# (including xAI, Perplexity, DeepSeek, etc.) are catalog-backed.
# Use provider-prefixed IDs for passthrough providers only when the
# model is known or supplied by the user.
consensus \
  --models "custom/example-model,openai/gpt-5.2" \
  --prompt "Compare these responses"
# Replace example-model with the provider-native model ID you intend to call.
```

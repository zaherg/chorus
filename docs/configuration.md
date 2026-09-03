# Configuration

## Config File

Location: `~/.config/chorus/config.json`

Created on first run with sensible defaults (API keys are empty). On POSIX systems, the directory uses `0700` and the file uses `0600`. Existing broader permissions are repaired on load.

### Full Schema

```json
{
  "cli_timeout_ms": 2700000,
  "provider_timeout_ms": 1800000,
  "log_level": "info",
  "max_concurrent_processes": 3,
  "openrouter_api_key": "",
  "anthropic_api_key": "",
  "google_vertex_api_key": "",
  "amazon_bedrock_api_key": "",
  "azure_api_key": "",
  "custom_api_key": "",
  "custom_url": "",
  "allow_insecure_custom": false
}
```

### Runtime Settings

| Key | Type | Default | Description |
|---|---|---|---|
| `cli_timeout_ms` | integer | `2700000` | Overall CLI timeout for the consensus run |
| `provider_timeout_ms` | integer | `1800000` | Per-provider API call timeout |
| `log_level` | string | `"info"` | Logging level: `debug`, `info`, `warn`, `error` |
| `max_concurrent_processes` | integer | `3` | Max concurrent provider calls in parallel mode |
| `allow_insecure_custom` | boolean | `false` | Set to `true` to allow insecure custom provider URLs |

### Provider API Keys

Each provider has a corresponding config key:

| Key | Provider |
|---|---|
| `openrouter_api_key` | OpenRouter |
| `anthropic_api_key` | Anthropic |
| `google_vertex_api_key` | Google Vertex AI |
| `amazon_bedrock_api_key` | Amazon Bedrock |
| `azure_api_key` | Azure OpenAI |
| `custom_api_key` | Custom OpenAI-compatible endpoint |
| `custom_url` | Custom endpoint base URL |

### Custom Provider

`custom_url` must be set alongside `custom_api_key`. The CLI enforces HTTPS for non-loopback URLs. Local HTTP is allowed for `localhost`, `127.0.0.1`, and `::1`. URL credentials and fragments are rejected. Direct private/link-local hosts are rejected (this is not a full SSRF defense).

To allow insecure custom URLs on any host:

```json
{
  "allow_insecure_custom": true,
  "custom_url": "http://my-internal-server/v1",
  "custom_api_key": "$CUSTOM_API_KEY"
}
```

## Environment Variable References

String values can reference shell environment variables with `$ENV_VAR`:

```json
{
  "openrouter_api_key": "$OPENROUTER_API_KEY",
  "anthropic_api_key": "$ANTHROPIC_API_KEY"
}
```

Unresolved `$ENV_VAR` references remain as literal strings (e.g., `$MISSING_VAR` stays as-is). Only top-level string values undergo `$ENV_VAR` resolution; non-string values pass through unchanged.

## Logging

Log files are stored in `~/.config/chorus/logs/`:

| File | Contents |
|---|---|
| `error.log` | Warnings and errors for quick debugging |

Set `log_level` to `debug` for verbose output, or `error` for minimal output.

## Validation

Config is validated via Zod on startup. Invalid values cause the CLI to exit with an error message. The schema:

- Coerces numeric strings to numbers for `cli_timeout_ms`, `provider_timeout_ms`, `max_concurrent_processes`
- Validates `log_level` against allowed enum values
- Refines: `custom_url` and `custom_api_key` must be set together (setting one without the other is an error)

## Example Configs

### Minimal (OpenRouter only)

```json
{
  "openrouter_api_key": "$OPENROUTER_API_KEY"
}
```

### Multi-provider with custom endpoint

```json
{
  "openrouter_api_key": "$OPENROUTER_API_KEY",
  "anthropic_api_key": "$ANTHROPIC_API_KEY",
  "google_vertex_api_key": "$GOOGLE_VERTEX_API_KEY",
  "custom_api_key": "$OLLAMA_API_KEY",
  "custom_url": "http://localhost:11434/v1",
  "log_level": "debug",
  "max_concurrent_processes": 10
}
```

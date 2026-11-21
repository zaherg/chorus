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
  "anthropic_api_key": "",
  "openrouter_api_key": "",
  "amazon_bedrock_api_key": "",
  "amazon_bedrock_region": "",
  "azure_api_key": "",
  "azure_resource_name": "",
  "azure_base_url": "",
  "google_vertex_api_key": "",
  "google_vertex_project": "",
  "google_vertex_location": "",
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
| `allow_insecure_custom` | boolean | `false` | Set to `true` to allow `http://` on non-loopback public custom URLs (does not bypass private-IP, credential, fragment, or redirect checks) |

### Provider Configuration

Each provider uses its API key and, where required by the provider SDK, its target region, resource, or project fields:

| Key | Provider | Purpose |
|---|---|---|
| `openrouter_api_key` | OpenRouter | API key |
| `anthropic_api_key` | Anthropic | API key |
| `amazon_bedrock_api_key` | Amazon Bedrock | API key (or use `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, or `AWS_PROFILE`) |
| `amazon_bedrock_region` | Amazon Bedrock | AWS region (also falls back to `AWS_REGION`, `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`, or `AWS_ENDPOINT_URL`) |
| `azure_api_key` | Azure OpenAI | API key |
| `azure_resource_name` | Azure OpenAI | Azure resource name (also falls back to `AZURE_RESOURCE_NAME`) |
| `azure_base_url` | Azure OpenAI | Explicit Azure base URL (alternative to `azure_resource_name`) |
| `google_vertex_api_key` | Google Vertex AI | API key |
| `google_vertex_project` | Google Vertex AI | GCP project ID (also falls back to `GOOGLE_VERTEX_PROJECT`; pair with `google_vertex_location`) |
| `google_vertex_location` | Google Vertex AI | GCP location/region (also falls back to `GOOGLE_VERTEX_LOCATION`; pair with `google_vertex_project`) |
| `custom_api_key` | Custom OpenAI-compatible endpoint | API key |
| `custom_url` | Custom OpenAI-compatible endpoint | Base URL |

### Custom Provider

To replace a legacy `baseten_api_key`, see [Migrating from Baseten](./providers.md#migrating-from-baseten).

`custom_url` must be set alongside `custom_api_key`.
The CLI enforces HTTPS for non-loopback URLs, while literal `localhost`, `127.0.0.1`, and `::1` are allowed over `http://` by default.
URL credentials, URL fragments, `.localhost` subdomains, private/RFC 6890/link-local IP addresses (including IPv4-mapped IPv6 literals), DNS resolutions to blocked/loopback addresses, and all HTTP redirects are always rejected.
At connection time, `createSafeCustomFetch` validates and pins the resolved IP addresses to mitigate DNS rebinding.

Setting `allow_insecure_custom` to `true` only relaxes the `https://` scheme check so plain `http://` can be used on public hosts.
It does not allow private RFC 1918 hosts, `.localhost` subdomains, credentials, fragments, or redirects:

```json
{
  "allow_insecure_custom": true,
  "custom_url": "http://api.example.com/v1",
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

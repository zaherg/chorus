# Providers

## Overview

The broker supports 23 provider slots: 21 catalog-backed providers plus 2 passthrough providers. Each configured provider falls into one of two tiers. The broker uses a public models.dev catalog (fetched and cached locally) to produce executable `route_id` values for catalog providers.

## Provider Tiers

### Catalog (Tier 1)

These providers have a models.dev catalog key. The broker fetches and caches their model rows and exposes them as executable `route_id` values. Run `consensus list-models --json` to see the rows available for your configured providers.

| Provider | Config Key | models.dev key |
|---|---|---|
| Alibaba | `alibaba_api_key` | `alibaba` |
| Amazon Bedrock | `amazon_bedrock_api_key` | `amazon-bedrock` |
| Anthropic | `anthropic_api_key` | `anthropic` |
| Azure | `azure_api_key` | `azure` |
| Baseten | `baseten_api_key` | `baseten` |
| Cerebras | `cerebras_api_key` | `cerebras` |
| Cohere | `cohere_api_key` | `cohere` |
| DeepInfra | `deepinfra_api_key` | `deepinfra` |
| DeepSeek | `deepseek_api_key` | `deepseek` |
| Fireworks | `fireworks_api_key` | `fireworks-ai` |
| Google | `google_api_key` | `google` |
| Google Vertex | `google_vertex_api_key` | `google-vertex` |
| Groq | `groq_api_key` | `groq` |
| Hugging Face | `huggingface_api_key` | `huggingface` |
| Mistral | `mistral_api_key` | `mistral` |
| OpenAI | `openai_api_key` | `openai` |
| OpenRouter | `openrouter_api_key` | `openrouter` |
| Perplexity | `perplexity_api_key` | `perplexity` |
| TogetherAI | `togetherai_api_key` | `togetherai` |
| Vercel | `vercel_api_key` | `vercel` |
| xAI | `xai_api_key` | `xai` |

### Passthrough (Tier 2)

These providers are configured but have no models.dev catalog key. The agent may still send provider-prefixed IDs that the provider API will accept or reject. Use them only when the model is known to the agent or supplied by the user. If unsure, ask the user for the exact provider-native model ID.

| Provider | Config Key | ID format |
|---|---|---|
| Custom OpenAI-compatible | `custom_api_key` + `custom_url` | `custom/<model-id>` |
| Gateway | `gateway_api_key` | `gateway/<model-id>` |

For passthrough providers, `consensus list-models --json` reports `status: "passthrough"` and an empty `models` array. Use provider-prefixed IDs such as `custom/example-model` or `gateway/example-model`. Replace example-model with the provider-native model ID you intend to call.

## Catalog Fetch and Cache

The broker fetches `https://models.dev/catalog.json` and writes two files under the user config dir:

```
~/.config/chorus/models-cache/catalog.json
~/.config/chorus/models-cache/metadata.json
```

`metadata.json` records `fetched_at`, `expires_at`, and the source URL. The default TTL is 24 hours. Successful fetches report `cache.status: "fresh"`. When a refresh fails but a previous cache is readable, the broker uses the stale cache and reports `cache.status: "stale"`. When no usable cache exists, `list-models` exits non-zero with a `models.list.error/1` payload (`error.code: "catalog_unavailable"`), while `consensus` uses `cli.consensus.error/1` for command-level catalog failures.

`list-models --json` filters the catalog to configured providers only. Unconfigured providers are omitted entirely.

## Broker Model Row

A `models.list/1` row carries the broker's stable shape for each model. The `route_id` is the exact CLI input the agent should pass to `--models` or `--synthesis-model`. `provider_model_id` is the model ID passed to the AI SDK provider after stripping the prefix. `canonical_model_id` is the models.dev canonical model key when one exists.

```typescript
interface BrokerModelInfo {
    route_id: string;
    provider: ProviderId;
    provider_model_id: string;
    canonical_model_id?: string;
    display_name: string;
    context_window?: number;
    output_limit?: number;
    supports_reasoning?: boolean;
    supports_tools?: boolean;
    supports_structured_output?: boolean;
}
```

The broker does not rank or choose models. `display_name`, `context_window`, `output_limit`, and the boolean capability flags are stable metadata for the agent to consider; the broker does not pick a "best" model from them.

## Model Resolution

When the agent passes a model ID to `--models` or `--synthesis-model`:

1. **Exact route.** If the input is an exact `route_id` that matches a configured catalog row, the broker uses that route. The first path segment is the internal provider ID; everything after the first slash is the provider-native model ID passed to the AI SDK.
2. **Optional unqualified input.** A bare provider-native ID (no `/`) is accepted only when exactly one configured provider exposes that exact provider-native ID. The CLI never suffix-matches model IDs.
3. **Ambiguous input.** If a bare ID maps to multiple configured providers, the broker returns a structured ambiguity response listing candidate `route_id` values and exits with code 3. The agent must pick an exact `route_id` and retry. No provider calls run.
4. **Passthrough.** A provider-prefixed ID targeting a configured passthrough provider (`custom`, `gateway`) is accepted when the model is known to the agent or supplied by the user. The broker hands the provider-native ID to the AI SDK provider and lets the API accept or reject it.

Example ambiguity response:

```json
{
  "schema": "cli.consensus.error/1",
  "error": {
    "code": "ambiguous_model",
    "input": "gpt-5.2",
    "candidates": ["openai/gpt-5.2", "openrouter/openai/gpt-5.2"],
    "message": "Model 'gpt-5.2' is exposed by multiple configured providers: openai/gpt-5.2, openrouter/openai/gpt-5.2. Use a fully qualified route_id."
  }
}
```

## Synthesis Model Selection

Synthesis is opt-in. The broker never auto-picks a synthesis model.

- If `--synthesis-model <route_id>` is set, the broker runs an extra synthesis call using that route.
- If `--synthesis-model` is absent, the broker skips synthesis and returns raw participant responses in `models[]`.
- If the synthesis model cannot be resolved or fails, the broker keeps the raw participant responses and populates `synthesis_error`. The broker does not fail the whole command solely because synthesis failed.

## Thinking Mode Mapping

Per-model thinking modes are mapped to provider-specific options:

| Thinking Mode | Anthropic (budgetTokens) | OpenAI (reasoningEffort) |
|---|---|---|
| `minimal` | 1,024 | `low` |
| `low` | 5,000 | `low` |
| `medium` | 20,000 | `medium` |
| `high` | 50,000 | `high` |
| `max` | 80,000 | `high` |

Other providers ignore thinking mode.

## Custom Provider URL Validation

Custom endpoints (`custom_url`) are validated:

- HTTPS required for non-loopback hosts.
- HTTP allowed for `localhost`, `127.0.0.1`, and `::1`.
- URL credentials (`user:pass@`) rejected.
- URL fragments (`#`) rejected.
- Direct private/link-local hosts rejected, including IPv4-mapped IPv6 literals. This is not a full SSRF defense.

Set `allow_insecure_custom` to `true` to bypass these checks.

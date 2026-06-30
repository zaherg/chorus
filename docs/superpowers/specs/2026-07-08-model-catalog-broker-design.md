# Model Catalog Broker Design

Date: 2026-07-08

## Summary

The CLI should act as an agent-facing broker between agents and model providers. It should not decide which model is best, rank providers, synthesize answers by default, or maintain hand-curated model lists. Instead, it should fetch model and provider data from models.dev, cache that data locally, filter it by the user's configured providers, send prompts to agent-selected models, and return raw model responses for the agent to combine.

## Goals

- Remove hand-curated static model routing and scoring.
- Avoid querying every provider API for model lists.
- Use models.dev as the source of model/provider catalog data.
- Cache models.dev data in the user's config directory.
- Return configured-provider model options to the agent.
- Let the agent choose the exact provider/model route.
- Return raw model responses by default so the agent can compare, validate, and combine them.
- Keep the system simple and maintainable.

## Non-Goals

- The CLI will not rank models or providers.
- The CLI will not synthesize model responses by default.
- The CLI will not choose a synthesis model automatically; synthesis requires an explicit `--synthesis-model <route_id>`.
- The CLI will not infer provider ownership from model name prefixes like `gpt-` or `gemini-`.
- The CLI will not maintain a static registry of selected models.
- The CLI will not validate model availability by calling every provider before use.

## Current Problems

### Static registry is misleading

`STATIC_MODEL_REGISTRY` contains a small hand-curated model list with fields such as `score`, `context_window`, aliases, and descriptions. This creates maintenance burden and can become stale quickly.

### Prefix inference routes incorrectly

Current logic infers providers from model ID prefixes:

- `gpt-*` maps to OpenAI
- `gemini-*` maps to Google
- `claude-*` maps to Anthropic

That is not reliable because many models are available through aggregators such as OpenRouter, Vercel AI Gateway, DeepInfra, or other providers.

### Runtime provider discovery is inconsistent

Some providers expose `/models` endpoints, while others only accept model IDs and let the API reject invalid ones. Provider discovery also adds network latency and failure modes for each configured provider.

### Capabilities are mostly unused

Fields such as `score`, `supports_thinking`, `supports_vision`, `supports_images`, `aliases`, and `description` are either unused or used only for display/ranking behavior that the CLI should not own.

## Target Behavior

When the agent needs model choices, it runs:

```sh
consensus list-models --json
```

The CLI:

1. Loads user config.
2. Reads the local models.dev cache if present and fresh.
3. Fetches models.dev data if the cache is missing, expired, or manually refreshed.
4. Maps internal provider IDs to models.dev provider keys.
5. Builds a configured-provider view from `catalog.providers[providerKey].models`.
6. Optionally enriches model rows from `catalog.models` when useful.
7. Returns structured JSON with executable route IDs for the agent.

The agent chooses exact provider/model IDs based on the user's request.

## models.dev Input

The CLI fetches and caches only the combined models.dev catalog endpoint:

- `https://models.dev/catalog.json` - combined catalog with top-level `models` and `providers` keys

This single endpoint is sufficient because it contains the same data as the narrower endpoints:

- `catalog.models` equals `https://models.dev/models.json`
- `catalog.providers` equals `https://models.dev/api.json`

The cached file lives in the user's config directory.

```text
~/.config/zaherg-skills/
├── config.json
└── models-cache/
    ├── catalog.json
    └── metadata.json
```

`models-cache/metadata.json` stores metadata:

```json
{
  "schema": "models-cache/1",
  "fetched_at": "2026-07-08T00:00:00.000Z",
  "expires_at": "2026-07-09T00:00:00.000Z",
  "source": "https://models.dev/catalog.json"
}
```

## Cache Rules

### Read from cache when

- `models-cache/metadata.json` exists.
- `models-cache/catalog.json` exists.
- `expires_at` is in the future.
- Cached catalog passes schema validation.

### Refresh cache when

- Cache files are missing.
- Metadata file is missing or invalid.
- Cache expired.
- Agent passes `--refresh`.

`consensus list-models` accepts `--refresh`. The flag forces a catalog refresh before filtering configured providers. It works with both human output and `--json`. It does not apply to `consensus --models`.

Config changes do not require catalog refresh. The cached catalog is global models.dev data. Each command filters that catalog against the current config, so adding or removing provider keys changes output immediately without re-fetching models.dev.

### Fetch failure behavior

If refresh fails but a previous cache exists, use the stale cache and set `cache.status` to `stale` with a short structured warning in JSON metadata. Human-readable mode may also print the warning to stderr. This keeps the agent usable during transient models.dev outages.

If refresh fails and no cache exists, return a clear error explaining that model catalog data could not be loaded.

### Cache safety

- Fetch with a timeout.
- Fetch with `Accept: application/json` and `User-Agent: @zaherg/skills/<package-version>`.
- Treat non-2xx HTTP status, invalid content type, timeout, oversized response, and JSON parse failure as refresh failures.
- Enforce a maximum response size before writing to disk.
- Validate that JSON has top-level `models` and `providers` objects.
- Write to temporary files first, then atomically rename into place.
- Keep cache files private under the existing config directory permissions.
- Ignore corrupt cache files and refresh when possible.

## Provider Mapping

Filtering uses configured providers from `config.json`, but model rows come from models.dev provider keys. Add an explicit adapter map from internal `ProviderId` to models.dev provider key.

This map is not a model registry. It only connects provider identifiers across systems.

Known mappings:

| Internal provider ID | models.dev provider key |
| --- | --- |
| `alibaba` | `alibaba` |
| `amazon-bedrock` | `amazon-bedrock` |
| `anthropic` | `anthropic` |
| `azure` | `azure` |
| `baseten` | `baseten` |
| `cerebras` | `cerebras` |
| `cohere` | `cohere` |
| `deepinfra` | `deepinfra` |
| `deepseek` | `deepseek` |
| `fireworks` | `fireworks-ai` |
| `google` | `google` |
| `google-vertex` | `google-vertex` |
| `groq` | `groq` |
| `huggingface` | `huggingface` |
| `mistral` | `mistral` |
| `openai` | `openai` |
| `openrouter` | `openrouter` |
| `perplexity` | `perplexity` |
| `togetherai` | `togetherai` |
| `vercel` | `vercel` |
| `xai` | `xai` |

Providers with no mapped catalog key, such as `custom`, return `status: "passthrough"` when configured.

`gateway` decision: internal `gateway` remains `status: "passthrough"` and is not catalog-backed in this design. Internal `vercel` maps to models.dev provider key `vercel`.

"Configured provider" means `isProviderConfigured(providerId, config)` returns true using existing required API key and required config checks. Providers present in config but missing required credentials are omitted from `models.list/1`.

## Output Shape

`list-models --json` should return configured providers only.

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
    "openrouter": {
      "status": "catalog",
      "models": [
        {
          "route_id": "openrouter/openai/gpt-5.2",
          "provider": "openrouter",
          "provider_model_id": "openai/gpt-5.2",
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

Provider statuses:

- `catalog`: models.dev has catalog entries for this configured provider.
- `passthrough`: provider is configured but no catalog key is mapped. Agent may still use explicit provider-prefixed model IDs.

Cache statuses:

- `fresh`: cache is valid and current.
- `stale`: refresh failed, but existing cache was usable.

When refresh fails and no usable cache exists, return an error response with `schema: "models.list.error/1"`, `error.code: "catalog_unavailable"`, a human-readable `error.message`, and exit non-zero. Do not return `models.list/1` with a failed cache status.

Not configured providers are omitted entirely.

## Model Shape

The CLI normalizes a stable broker row from `catalog.providers[providerKey].models`:

```ts
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

`route_id` is the exact CLI input the agent should pass to `--models` or `--synthesis-model`. `provider_model_id` is the model ID passed to the AI SDK provider after stripping the provider prefix. `canonical_model_id` links back to models.dev canonical model metadata when available.

Normalize fields as follows:

- `provider_model_id`: provider model key from `catalog.providers[providerKey].models`.
- `route_id`: internal provider ID plus `/` plus `provider_model_id`.
- `display_name`: provider model `name` if present, otherwise `provider_model_id`.
- `context_window`: provider model `limit.context` if numeric.
- `output_limit`: provider model `limit.output` if numeric.
- `supports_reasoning`: provider model `reasoning` if boolean.
- `supports_tools`: provider model `tool_call` if boolean.
- `supports_structured_output`: provider model `structured_output` if boolean.
- `canonical_model_id`: exact key in `catalog.models` when one exists for the same canonical model, otherwise undefined. Do not infer canonical IDs by suffix.

The broker may include stable models.dev metadata that helps agents choose, but it must not rank or choose models.

## Model Resolution

The consensus command should expect `route_id` values selected by the agent. `--models` accepts two or more comma-separated models. The CLI should not impose an upper limit beyond practical timeout and provider constraints. The agent decides model count from the user's request.

### Exact route

If the agent passes an exact `route_id`, the CLI uses that route.

Example:

```sh
consensus --models "openai/gpt-5.2,anthropic/claude-sonnet-4-5,google/gemini-2.5-pro" --prompt "..."
```

For route parsing, the first path segment is the internal provider ID. Everything after the first slash is the provider-native model ID passed to the AI SDK provider.

### Optional unqualified input

Bare provider-native IDs may be accepted only when exactly one configured provider has an exact provider-native ID match. The CLI should not suffix-match model IDs because that creates false ambiguity.

Example:

- `gpt-5.2` may resolve to OpenAI if OpenAI is the only configured provider with provider model ID `gpt-5.2`.
- `gpt-5.2` must return a structured ambiguity response if both OpenAI and another configured provider expose that exact provider model ID, so the agent can choose a provider-qualified `route_id`.
- `gpt-5.2` must not match `openrouter/openai/gpt-5.2` by suffix.

### Ambiguous input

If input maps to multiple configured providers, the CLI should not choose. It should return a structured ambiguity response listing candidate `route_id` values so the agent can choose.

Example:

```json
{
  "schema": "cli.consensus.error/1",
  "error": {
    "code": "ambiguous_model",
    "input": "gpt-5.2",
    "candidates": ["openai/gpt-5.2", "example-provider/gpt-5.2"],
    "message": "Model input matches multiple configured providers."
  }
}
```

Ambiguity returns non-zero exit and no provider calls run until the agent chooses an exact `route_id`.

### Passthrough provider

If a provider is configured but not represented in the catalog, exact provider-prefixed IDs should still be accepted.

Example:

```sh
consensus --models "custom/local-model,openrouter/deepseek/deepseek-v4-pro" --prompt "..."
```

For passthrough providers, the CLI sends the provider-native model ID to the AI SDK provider and lets the provider API accept or reject it.

## Response Combination and Optional Synthesis

By default, the CLI should not synthesize, clean up, summarize, or judge model responses. It should return one raw response record per requested model and let the agent compare, validate, discard, clean up, or combine them.

Default output should include every requested model, even failed or low-value responses:

- Requested model `route_id`
- Provider
- Provider-native model ID
- Raw response text exactly as returned after SDK normalization, or `null` when no text was produced
- Stance the model took (`"for"`, `"against"`, `"neutral"`, or `null` when the call failed)
- Per-model error, if any

Participant prompt behavior:

Participant model calls keep the existing prompt construction behavior unless explicitly changed by a later spec. `step`, `findings`, stance, and embedded relevant files are still included in each participant prompt. This design changes routing and response aggregation, not the participant prompt contract.

Participant failure behavior:

- The command returns a successful broker response when at least one requested participant call completes, even if other participant calls fail.
- Failed participant calls remain in `models[]` with `response: null` and a structured `error`.
- If all participant calls fail, return a command error with `schema: "cli.consensus.error/1"` and exit non-zero.
- Optional synthesis runs only when `--synthesis-model` is provided and at least one participant response succeeded.

Optional synthesis can remain as an explicit opt-in feature:

- If `--synthesis-model <route_id>` is provided, the CLI may run an extra synthesis call.
- If `--synthesis-model` is absent, skip synthesis without error.
- If the synthesis model cannot be resolved or fails, return raw participant responses and include a synthesis error field. Do not fail the whole command as long as participant responses were collected.

Rationale:

- The agent is primary user and can decide whether responses are useful.
- The CLI should not filter out weak, conflicting, or low-quality responses unless the provider call failed before producing text.
- Broker should collect and return provider outputs, not act as moderator.
- Optional synthesis preserves compatibility for workflows that still want CLI-side summary.
- Removing default synthesis eliminates model ranking and auto-selection concerns.

Default consensus response shape:

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
    "embedded_files": ["/abs/path/file.ts"],
    "embedded_text": "--- File: /abs/path/file.ts ---\n...",
    "skipped_files": ["/abs/path/missing.ts"],
    "total_tokens": 1234
  }
}
```

If optional synthesis succeeds, `synthesis` contains only the synthesized text. If optional synthesis fails, `synthesis` stays `null` and `synthesis_error` explains the failure.

`embeddedFiles` is always present on success (empty arrays and zero token count when `--files` is absent). `embedded_text` is the concatenated file content injected into each participant prompt; `skipped_files` lists paths that could not be read.

Command surface for the consensus broker:

- `--schema` prints the `cli.consensus/2` output JSON schema and exits 0.

## Implementation Components

Add replacement components before removing old discovery and routing code:

- `src/providers/model-catalog.ts`: fetch, cache, validate, and normalize models.dev catalog data.
- `src/providers/provider-map.ts`: internal provider ID to models.dev provider key mapping.
- `src/providers/resolve-route.ts`: route ID parsing, exact route resolution, unqualified ambiguity handling, and passthrough handling.
- `src/commands/list-models.ts`: broker JSON output using normalized catalog rows.

## Code Removals

Remove or replace:

- `STATIC_MODEL_REGISTRY`
- `MODEL_PREFIX_TO_PROVIDER`
- `inferProvider` routing behavior
- `findModelByIdOrAlias` alias behavior
- `ModelCapabilitiesSchema`
- `capabilities.score` ranking
- Auto-selection logic in `selectModel`
- Required synthesis-model behavior
- Runtime provider `/models` discovery as the primary catalog source

Keep:

- Provider factory creation in `registry.ts`
- Provider-prefixed passthrough routing
- AI SDK provider boundary in `src/providers/`
- Custom provider URL validation
- Secret-safe logging

## Agent Skill Update

Agent Skill Update is required for completion, but should be implemented after broker behavior and tests pass. It must not change broker runtime behavior.

The bundled `skills/consensus/SKILL.md` should instruct agents to:

1. Run `consensus list-models --json` before invoking consensus.
2. Match the user's model wording to the returned configured-provider catalog.
3. Prefer exact provider-qualified IDs.
4. Omit `--synthesis-model` by default and combine raw responses in the agent.
5. Provide `--synthesis-model` only when user explicitly asks for CLI-side synthesis or when agent intentionally opts into it.
6. If a provider is `passthrough`, use provider-prefixed IDs only when the requested model is known by the agent or explicitly supplied by the user. If unsure, ask the user for the exact provider and model ID before invoking consensus.
7. Do not ask the CLI to choose the best model.

## Testing Plan

### Unit tests

Unit tests must use checked-in models.dev fixture JSON and injected fetch/cache dependencies. No unit test should call live `https://models.dev`.

- Cache miss fetches injected catalog source and writes `models-cache/catalog.json`.
- Fresh cache avoids network fetch.
- Expired cache refreshes.
- Refresh failure uses stale cache when available.
- Refresh failure without cache returns an error.
- `list-models --json` omits unconfigured providers.
- Configured catalog provider returns broker rows with executable `route_id` values.
- Configured passthrough provider returns `status: "passthrough"`.
- Config changes alter filtered output without refreshing catalog.
- Ambiguous unqualified model returns structured candidate `route_id` values for agent selection.
- Provider-qualified passthrough model routes to correct provider.
- Missing synthesis model skips synthesis and still returns raw participant responses.
- Provided synthesis model adds synthesis output when successful.
- Failed synthesis model keeps raw participant responses and includes `synthesis_error`.

### Integration tests

- With OpenAI + OpenRouter configured, `list-models --json` includes both provider groups.
- With only DeepInfra configured, `list-models --json` includes DeepInfra as a catalog provider.
- With only custom configured, `list-models --json` includes custom as passthrough.
- `consensus --models` with exact provider-qualified IDs reaches provider registry.

## Migration Notes

Existing users who pass bare model IDs may need to switch to provider-qualified IDs when the same model appears under multiple configured providers.

The CLI should provide structured disambiguation candidates rather than silently choosing a provider.

## Decisions

1. Cache TTL defaults to 24 hours.
2. `catalog.providers[providerKey].models` is authoritative for provider availability and provider-native model IDs.
3. `catalog.models` is optional enrichment data.
4. Human-readable `list-models` output can stay minimal because the primary consumer is agents.

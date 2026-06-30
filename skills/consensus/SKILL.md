---
name: consensus
description: Use when a prompt, file set, decision, or proposal needs independent evaluation by multiple configured AI models.
---

# Consensus

Use the `consensus` CLI to collect independent model responses.
Treat the CLI as a broker, not a judge.
It does not rank models, select a winner, or synthesize by default.
Combine and evaluate raw responses in the agent unless the user explicitly requests CLI-side synthesis.

## Workflow

### 1. Verify the binary

Inside an installed skill folder, run:

```bash
bin/consensus --version
```

If the command fails, run:

```bash
scripts/install.sh
bin/consensus --version
```

If installation or verification fails, stop and report the exact error.
Do not substitute an unpinned binary.

Examples below use `consensus` for readability.
Use `bin/consensus` from the skill directory, or `consensus` when it is already on `PATH`.

### 2. Discover available routes

Run this before every consensus request:

```bash
consensus list-models --json
```

The output schema is `models.list/1`.
Use exact provider-qualified `route_id` values from `providers.<provider>.models[]`.

Provider status appears at `providers.<provider>.status`:

- `catalog`: use exact `route_id` values from that provider's `models[]`.
- `passthrough`: use a provider-prefixed model ID only when the user supplied it or the model ID is already known.

If a passthrough model ID is unknown, ask the user for the exact provider and model ID.
Never ask the CLI to choose or rank models.

Cache status appears at `cache.status`.
`fresh` means the catalog is current.
`stale` means refresh failed and a previous cache was used.
Use `consensus list-models --json --refresh` only when a fresh catalog is required.

If no usable cache exists and the CLI returns `models.list.error/1` with `error.code: "catalog_unavailable"`, stop and report the error.
Do not retry blindly.

### 3. Resolve the requested models

Map the user's wording to exact provider-qualified `route_id` values from the current discovery output.
Do not copy model IDs from examples, memory, or previous runs.

Bare model IDs are accepted only when exactly one configured provider exposes that provider-native ID.
Prefer provider-qualified routes to avoid ambiguity.

Plugin model IDs such as `copilot/...`, `codex/...`, and `claude/...` are unsupported.

### 4. Run the request

Assign routes discovered in step 2:

```bash
ROUTE_A="provider-a/model-a"
ROUTE_B="provider-b/model-b"
```

Replace both illustrative values with exact live `route_id` values before invoking the CLI.

Basic parallel request:

```bash
consensus \
  --models "$ROUTE_A,$ROUTE_B" \
  --prompt "Evaluate this proposal independently."
```

Use stances when deliberate opposition improves the evaluation:

```bash
consensus \
  --models "$ROUTE_A,$ROUTE_B" \
  --prompt "Should we adopt this architecture?" \
  --stance "$ROUTE_A=for" \
  --stance "$ROUTE_B=against"
```

Use `--sequential` only when each later model should see prior responses.
Default to parallel requests for independent evaluation.

Run `consensus --help` for optional thinking modes, temperature controls, and JSON stdin syntax.

## File embedding

Run the CLI from the project root and pass project-relative file paths:

```bash
consensus \
  --models "$ROUTE_A,$ROUTE_B" \
  --prompt "Review these files for security issues." \
  --files "src/auth.ts,src/api.ts"
```

Never embed secrets, credentials, environment files, or unrelated files.
After execution, inspect `embeddedFiles.skipped_files`.
Disclose every omission.
Retry only after correcting the path or obtaining required access.

## CLI-side synthesis

CLI-side synthesis is opt-in and requires an explicit user request.
Otherwise, omit `--synthesis-model` and synthesize the raw responses in the agent.

```bash
SYNTHESIS_ROUTE="provider-c/model-c"

consensus \
  --models "$ROUTE_A,$ROUTE_B" \
  --prompt "Evaluate this proposal independently." \
  --synthesis-model "$SYNTHESIS_ROUTE"
```

Replace `SYNTHESIS_ROUTE` with an exact live `route_id` from discovery.
Synthesis is skipped when all participants fail.
A synthesis failure does not discard participant responses.

## Required result validation

The consensus output schema is `cli.consensus/2`.
After every call:

1. Inspect every `models[]` entry.
2. Record each participant's `response` or structured `error`.
3. Inspect `synthesis_error` when synthesis was requested.
4. Inspect `embeddedFiles.skipped_files` when files were supplied.
5. Report failed models and omitted files explicitly.

Exit code `0` means at least one participant returned a response.
Do not describe the result as multi-model consensus unless at least two requested participants returned responses.
Do not hide partial failure behind a successful exit code or successful synthesis.

## Clarifying model responses

If a response is materially unclear, run up to three focused follow-up rounds with the original participant set or with the unclear route plus at least one peer route.

- Include the original response and relevant context in each new prompt.
- Ask the original route to clarify its response and ask peer routes to evaluate that clarification.
- Ask one specific what, how, or why question at a time.
- Stop when clarification repeats prior content, the route fails again, or further detail would not affect the decision.

Treat each follow-up as a new consensus invocation and validate its output using the same rules.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | At least one participant response was collected. |
| 1 | Broker error, every participant failed, or the catalog was unavailable. |
| 2 | Argument parsing failed or stdin JSON was invalid. |
| 3 | Model resolution failed or no providers were configured. |

For detailed flags and current payload shapes, use:

```bash
consensus --help
consensus list-models --json
```

## Configuration

Runtime configuration is loaded from `~/.config/chorus/config.json`.
String values may reference environment variables with `$ENV_VAR`.
Never place literal secrets in prompts, files, examples, or committed configuration.

Custom API URLs must use HTTP or HTTPS.
Remote HTTP requires `allow_insecure_custom: true`.
`localhost` is allowed for local providers, while other private, loopback, credential-bearing, and fragmented URLs are rejected.

The CLI reads its version from `package.json`.
The skill-local installer downloads the matching pinned GitHub Release binary.

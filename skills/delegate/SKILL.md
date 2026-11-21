---
name: delegate
description: Use only when the user explicitly asks to shell out to external CLI coding agents such as Claude Code, Codex, OpenCode, GitHub Copilot, or Pi Coding Agent for focused sub-tasks or parallel independent work. Do not use for multi-model comparison or debate (use consensus instead).
disable-model-invocation: true
---

# Delegate

## Activation and Guardrails

Use this skill only when the user explicitly asks to delegate work to a named external CLI coding agent (Claude Code, Codex, OpenCode, GitHub Copilot, or Pi Coding Agent).
Do not use this skill for multi-model comparison, independent evaluation, or structured debate.
For multi-model debate, use `consensus` when `consensus` is available on `PATH`, or `bin/consensus` from an installed consensus skill folder after running `scripts/install.sh`.

<critical>
- Do not invoke this skill automatically.
- Invoke only when the user explicitly requests external CLI delegation.
- Never try another agent if the one the user asked for did not work or sidetracked.
</critical>

Chorus has no built-in delegate command.
Instead, shell out to the requested CLI agent directly.

### Preflight and Postflight Safety Rules

Apply these checks across every delegated CLI agent:

1. Verify the requested binary is installed before invoking it by running `command -v <agent>`.
2. Never pass secrets, API keys, or credentials in prompts, CLI flags, environment dumps, or log files.
3. Choose explicit read-only versus file-mutating flags that match the user's authorization, and check `<agent> --help` before passing flags you have not verified on the installed version.
4. After every delegated run inside a repository, inspect the worktree with `git status` and `git diff` and report the exit status and any changed files.

## How to Delegate

### Claude Code

Check `claude --help` to confirm supported non-interactive, model, and permission flags on the installed binary.
When the user requests a specific model, supply it through a variable rather than hardcoding stale model identifiers.

With a specific prompt:

```bash
claude --print "Refactor the authentication module to use async/await instead of callbacks. Files: src/auth.ts, src/auth_test.ts"
```

With a user-supplied or live-discovered model (replace `CLAUDE_MODEL` with a current model ID confirmed via `claude --help` or live discovery):

```bash
: "${CLAUDE_MODEL:?Set CLAUDE_MODEL to a live model ID supported by claude}"

claude --print \
  --model "$CLAUDE_MODEL" \
  "Review this pull request for security issues. Focus on: SQL injection, XSS, CSRF. Files: src/api/handlers.ts. Do not modify files."
```

### Codex (OpenAI)

Check `codex --help` and `codex review --help` to verify supported flags, sandbox modes, and model options on the installed version.
Use `codex exec` for non-interactive task execution rather than interactive `codex`.

With a specific prompt:

```bash
codex exec "Generate unit tests for src/utils/files.ts covering edge cases: empty strings, unicode, very long inputs"
```

To review a specific feature or issue:

```bash
codex review "Review this pull request for security issues. Focus on: SQL injection, XSS, CSRF. Files: src/api/handlers.ts"
```

With a user-supplied or live-discovered model and explicit reasoning effort (do not invent model IDs; confirm supported models and `-c` keys with `codex --help`):

```bash
: "${CODEX_MODEL:?Set CODEX_MODEL to a live model ID supported by codex}"

codex review \
  -m "$CODEX_MODEL" \
  -c model_reasoning_effort=low \
  "Review this pull request for security issues. Focus on: SQL injection, XSS, CSRF. Files: src/api/handlers.ts"
```

For higher reasoning effort, set `-c model_reasoning_effort=high` with the same verified `CODEX_MODEL`.

### Pi Coding Agent

For delegated Pi tasks, run Pi non-interactively with `--print` and always pass explicit model and thinking values.
Explicit model and thinking selection is a delegate workflow policy, not a Pi CLI requirement.
Run Pi from the root of the project that owns the delegated task.
The command examples in this section use POSIX shell syntax, including variable guards and line continuations, and are written for the macOS and zsh environment of this repository.
They do not claim native PowerShell compatibility.

Make sure to use equivalent commands that match the user's operating system.

Model selection follows this exact precedence:

1. If the user supplied an exact provider-qualified Pi model, use it unchanged.
2. If the user supplied a provider and a provider-native model separately, normalize them to `provider/model-id`.
3. If the user or project already established `PI_MODEL`, use that exact value.
4. Otherwise run `pi --list-models`, present the relevant live candidates, and ask the user to choose.

Never infer a model from Pi's configured default.
Never silently select the first fuzzy-search result.
Never silently switch models after a failure.
Do not reconstruct model identifiers from memory.

The provider-native model may itself contain a slash, so provider `openrouter` plus native model `openai/gpt-5.4` becomes `openrouter/openai/gpt-5.4`.

When the user supplies the provider and provider-native model separately, normalize them before use:

```bash
PI_PROVIDER="provider"
PI_PROVIDER_MODEL="model-id"
PI_MODEL="${PI_PROVIDER}/${PI_PROVIDER_MODEL}"
```

These values are illustrative placeholders.
Always use values from the user or from current `pi --list-models` output.

When the user already supplied an exact provider-qualified model, set `PI_MODEL` to that exact `provider/model-id` value.

Discover live models first, then select the exact provider and model pair from the output:

```bash
pi --list-models
```

Narrow the catalog with an optional search term:

```bash
pi --list-models gpt-5.4
```

If the user did not name an exact model and no established `PI_MODEL` value exists, stop and ask the user to choose from the live list.

The `PI_MODEL` shell guard in the examples checks presence only.
It rejects an unset or empty value, but it cannot prove exact provider qualification or catalog membership.
Exact qualification is established by input provenance and the live catalog, never by counting slashes in the identifier.

Thinking-level selection follows this exact precedence:

1. Use the exact thinking level requested by the user.
2. If the user did not request one and an established `PI_THINKING` value exists, use it.
3. Otherwise use `high` as the fallback for the implementation and review examples below.

Never silently change a requested thinking level.
The examples express this precedence with an explicit variable so no command hardcodes over a user choice:

```bash
PI_THINKING="${PI_THINKING:-high}"
```

Before executing a task with a non-`off` thinking level, confirm that the selected model reports thinking support in `pi --list-models`.
If the requested level is unsupported, report the mismatch and ask the user whether to select another model or explicitly use `off`.
Never silently downgrade a requested thinking level.

Every one-shot task keeps `--print` and `--no-session`.
Use a persistent session only when the user explicitly requests resumable work.
Do not add continuation or resume flags to the default examples.

Shared input preparation for the task examples:

```bash
: "${PI_MODEL:?Set PI_MODEL to an exact provider-qualified model from pi --list-models}"
PI_THINKING="${PI_THINKING:-high}"
```

#### Focused implementation delegation

Coding tools stay enabled because the task authorizes changes.

```bash
: "${PI_MODEL:?Set PI_MODEL to an exact provider-qualified model from pi --list-models}"
PI_THINKING="${PI_THINKING:-high}"

pi --print \
  --no-session \
  --model "$PI_MODEL" \
  --thinking "$PI_THINKING" \
  "Implement focused tests for src/config.ts. Follow AGENTS.md, run the targeted tests, and report changed files and verification results."
```

#### Tool-restricted review delegation

This review uses no mutation-capable tools and no discovered extensions.

```bash
: "${PI_MODEL:?Set PI_MODEL to an exact provider-qualified model from pi --list-models}"
PI_THINKING="${PI_THINKING:-high}"

pi --print \
  --no-session \
  --model "$PI_MODEL" \
  --thinking "$PI_THINKING" \
  --no-extensions \
  --tools read,grep,find,ls \
  "Review error handling in src/providers/. Report concrete findings with file references. Do not modify files."
```

The tool allowlist excludes `bash`, `powershell`, `edit`, and `write`, and `--no-extensions` disables discovered extensions.
This is a tool restriction, not an operating-system sandbox, and it is not safe execution for untrusted repositories.
Untrusted repositories require an external sandbox or container.
Inspect the worktree after any Pi run inside a project.

Non-interactive Pi runs do not display a project-trust prompt.
Pi applies a saved trust decision or the configured non-interactive fallback.
The default commands above omit `--approve` because it can authorize unreviewed project-local executable resources.
The default commands also omit `--no-approve` because it can suppress intentionally configured project behavior.
Use either override only when the user intentionally requests that trust behavior.
Context files stay enabled in project task examples, so Pi receives `AGENTS.md` and/or `CLAUDE.md` project instructions.

Before running Pi against a provider, the safe readiness check is:

```bash
: "${PI_MODEL:?Set PI_MODEL to an exact provider-qualified model from pi --list-models}"

pi auth check \
  --model "$PI_MODEL" \
  --no-refresh \
  --json
```

Run this check only when preparing for an actual Pi provider invocation.
Catalog discovery and static documentation validation do not require it.
Never run credential-emitting operations during validation, specifically `--credentials`, `pi auth print-api-key`, and `pi auth print-bearer-token`.
Never place credentials in command arguments, prompts, logs, examples, tests, or committed configuration.

On failure, capture the process exit code and preserve relevant stdout and stderr without exposing credentials or unrelated sensitive data.
Report the exact harness, the exact model, the exact thinking level, the working directory, and the failed task stage.
Report the exact error, or a safely redacted equivalent when the raw error contains secrets.
Then stop.
Do not retry the same command automatically.
Do not retry with another model automatically.
Do not switch to another harness automatically.
Retry or substitute only after explicit user authorization.

### OpenCode

Check `opencode --help` to verify available model and permission flags on the installed binary.

```bash
opencode run "Analyze the error handling patterns in src/providers/ and suggest improvements. Do not modify files."
```

### GitHub Copilot CLI

Check `copilot --help` to confirm non-interactive prompt and permission flags on the installed binary.
Use `-p` for non-interactive execution:

```bash
copilot -p "Explain the consensus algorithm in src/consensus.ts and identify potential race conditions"
```

## Patterns

### Parallel delegation (independent tasks)

Parallel runs must either be read-only or target strictly disjoint files so concurrent agents do not overwrite each other's changes.
Isolate logs in a temporary directory created with `mktemp -d`, clean it up with a `trap`, and capture each child process exit code individually with `wait`:

```bash
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

claude --print "Write tests for src/config.ts only. Do not modify other files." > "$TMP_DIR/config-tests.log" 2>&1 &
PID_A=$!
claude --print "Write tests for src/consensus.ts only. Do not modify other files." > "$TMP_DIR/consensus-tests.log" 2>&1 &
PID_B=$!

STATUS_A=0
wait "$PID_A" || STATUS_A=$?
STATUS_B=0
wait "$PID_B" || STATUS_B=$?

cat "$TMP_DIR/config-tests.log"
cat "$TMP_DIR/consensus-tests.log"
echo "Exit codes: config=$STATUS_A consensus=$STATUS_B"
```

### Delegate + consensus (get agent output, then run consensus)

This pipeline requires `jq` on `PATH`.
Discover live consensus routes first, run `codex exec` non-interactively while checking its exit status, and stream the review text through stdin to `jq -Rs` instead of `--arg` so large outputs are never exposed in process arguments or truncated by `ARG_MAX`:

```bash
# Discover live routes first and replace the illustrative placeholders below:
consensus list-models --json
ROUTE_A="provider-a/model-a"
ROUTE_B="provider-b/model-b"

# Collect a non-interactive code review from Codex and fail fast on non-zero exit:
REVIEW="$(codex exec "Review src/consensus.ts for correctness and edge cases. Do not modify files.")" || {
  echo "codex exec failed" >&2
  exit 1
}

# Stream $REVIEW via stdin to jq -Rs and pipe the strict request into consensus --stdin-json:
printf '%s' "$REVIEW" | jq -Rs \
  --arg route_a "$ROUTE_A" \
  --arg route_b "$ROUTE_B" \
  '{
    models: [$route_a, $route_b],
    prompt: "Evaluate this code review for accuracy and missed edge cases.",
    findings: .,
    stances: { ($route_a): "for", ($route_b): "against" }
  }' | consensus --stdin-json
```

### Working directory

Most CLI agents operate in the current working directory.
Run from the target project root using `cd` or the agent's working directory flag:

```bash
cd /path/to/project && claude --print "Run the test suite and fix any failures"
```

## Notes

- Each CLI agent (including Pi Coding Agent) must be installed separately and available on `PATH`.
- Chorus does not manage or install these agents.
- For structured multi-model debate, use `consensus` instead of manual delegation.

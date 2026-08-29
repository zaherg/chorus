---
name: delegate
description: Use when you need to shell out to external CLI coding agents such as Claude Code, Codex, OpenCode, GitHub Copilot, or Pi Coding Agent for focused sub-tasks or parallel independent work.
---

# Delegate

## When to Use

Delegate tasks to specialized CLI agents (Claude Code, Codex, OpenCode, GitHub Copilot, Pi Coding Agent) when you need:
- A fresh context window for a complex sub-task
- A different agent's perspective on a problem
- Parallel execution of independent tasks
- Code changes by a coding-focused agent

<critical>
- Never try another agent if the one the user asked for didn't work or sidetracked.
</critical>

Skills has no built-in delegate command. Instead, shell out to the CLI agents directly.

For structured multi-model debate, use `consensus` when `consensus` is available on `PATH`, or `bin/consensus` from an installed consensus skill folder after running `scripts/install.sh`.

## How to Delegate

### Claude Code

With a specific prompt:

```bash
claude --print "Refactor the authentication module to use async/await instead of callbacks. Files: src/auth.ts, src/auth_test.ts"
```

With a specific prompt and a model:

```bash
claude --print "Review this pull request for security issues. Focus on: SQL injection, XSS, CSRF. Files: src/api/handlers.ts" --model claude-sonnet-4-20250514
```

### Codex (OpenAI)

With a specific prompt:

```bash
codex exec "Generate unit tests for src/utils/tokens.ts covering edge cases: empty strings, unicode, very long inputs"
```

To review a specific feature or issues:

```bash
codex review "Review this pull request for security issues. Focus on: SQL injection, XSS, CSRF. Files: src/api/handlers.ts"
```

With a specific model and low reasoning effort:


```bash
codex review "Review this pull request for security issues. Focus on: SQL injection, XSS, CSRF. Files: src/api/handlers.ts" -m gpt-5.6-luna -c model_reasoning_effort=low
```

With a specific model and high reasoning effort:


```bash
codex review "Review this pull request for security issues. Focus on: SQL injection, XSS, CSRF. Files: src/api/handlers.ts" -m gpt-5.6-luna -c model_reasoning_effort=high
```


### Pi Coding Agent

For delegated Pi tasks, run Pi non-interactively with `--print` and always pass explicit model and thinking values.
Explicit model and thinking selection is a delegate workflow policy, not a Pi CLI requirement.
Run Pi from the root of the project that owns the delegated task.
The command examples in this section use POSIX shell syntax, including variable guards and line continuations, and are written for the macOS and zsh environment of this repository.
They do not claim native PowerShell compatibility.

Make sure to use an equivalent commands that matches the user operating system.

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

```bash
opencode run "Analyze the error handling patterns in src/providers/ and suggest improvements"
```

### GitHub Copilot CLI

```bash
copilot "Explain the consensus algorithm in src/consensus.ts and identify potential race conditions"
```

## Patterns

### Parallel delegation (independent tasks)

```bash
claude --print "Write tests for src/config.ts" > /tmp/config-tests.log 2>&1 &
claude --print "Write tests for src/consensus.ts" > /tmp/consensus-tests.log 2>&1 &
wait
cat /tmp/config-tests.log
cat /tmp/consensus-tests.log
```

### Delegate + consensus (get agent output, then run consensus)

```bash
# Get code review from codex
REVIEW=$(codex "Review src/consensus.ts for correctness and edge cases")

# Run consensus on the review
consensus \
  --models "gpt-5.2,gemini-2.5-pro" \
  --prompt "Evaluate this code review: $REVIEW" \
  --stance "gpt-5.2=for" \
  --stance "gemini-2.5-pro=against"
```

### Working directory

Most CLI agents operate in the current directory. Use `cd` or the agent's working directory flag:

```bash
cd /path/to/project && claude --print "Run the test suite and fix any failures"
```

## Notes

- Each CLI agent (including Pi Coding Agent) must be installed separately and available on PATH.
- Skills does not manage or install these agents.
- For structured multi-model debate, use `consensus` instead of manual delegation.

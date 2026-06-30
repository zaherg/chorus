---
name: delegate
description: Use when you need to shell out to external CLI coding agents such as Claude Code, Codex, OpenCode, or GitHub Copilot for focused sub-tasks or parallel independent work.
---

# Delegate

## When to Use

Delegate tasks to specialized CLI agents (Claude Code, Codex, OpenCode, GitHub Copilot) when you need:
- A fresh context window for a complex sub-task
- A different agent's perspective on a problem
- Parallel execution of independent tasks
- Code changes by a coding-focused agent

<critical>
- Never try another agent if the one the user asked for didn't work or sidetracked.
</critical>

Skills no longer has a built-in delegate command. Instead, shell out to the CLI agents directly.

For structured multi-model debate, use `consensus` when `consensus` is available on `PATH`, or `bin/consensus` from an installed consensus skill folder after running `scripts/install.sh`.

## How to Delegate

### Claude Code

```bash
claude --print "Refactor the authentication module to use async/await instead of callbacks. Files: src/auth.ts, src/auth_test.ts"
```

With a specific role/prompt:

```bash
claude --print "Review this pull request for security issues. Focus on: SQL injection, XSS, CSRF. Files: src/api/handlers.ts" --model claude-sonnet-4-20250514
```

### Codex (OpenAI)

```bash
codex exec "Generate unit tests for src/utils/tokens.ts covering edge cases: empty strings, unicode, very long inputs"
```

To review a specific feature or issues:

```bash
codex review "Review this pull request for security issues. Focus on: SQL injection, XSS, CSRF. Files: src/api/handlers.ts"
```

With a specific model:


```bash
codex review "Review this pull request for security issues. Focus on: SQL injection, XSS, CSRF. Files: src/api/handlers.ts" --model gpt-5.5
```


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

- Each CLI agent must be installed separately and available on PATH.
- Skills does not manage or install these agents.
- For structured multi-model debate, use `consensus` instead of manual delegation.

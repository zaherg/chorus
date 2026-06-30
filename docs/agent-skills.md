# Agent Skills

Skills follows the [Agent Skills specification](https://agentskills.io/specification). Two skills are bundled in `skills/skills/`. A third development-time skill, `index-knowledge`, lives in `.agents/skills/`.

## `consensus` Skill

**Path:** `skills/skills/consensus/SKILL.md`

Multi-model consensus for coding agents. The `consensus` CLI is a broker: it returns one raw record per requested model so the agent can compare, combine, or judge responses on its own.

### When to Use

- Architecture decisions with trade-offs
- Code review from multiple perspectives
- Challenging assumptions with structured debate
- Getting a second (or third) opinion before choosing a direction

### Setup

From within the installed skill directory:

```bash
scripts/install.sh
bin/consensus --version
```

The installer downloads the pinned GitHub Release binary. This is separate from npm/bun installation -- the skill bundles its own binary.

### Usage Patterns

All examples use `consensus` for readability. From the skill directory, use `bin/consensus` instead.

#### Discover routes with `list-models --json`

Always run `consensus list-models --json` first. The response shape is `models.list/1`. Use the returned `route_id` values to map the user's wording to configured providers. Each provider has a `status`:

- `catalog`: the `models[]` rows are executable `route_id` values.
- `passthrough`: the provider has no catalog rows; use provider-prefixed IDs only when the model is known to the agent or supplied by the user.

Prefer exact provider-qualified `route_id` values. Avoid bare IDs like `gpt-5.2` when ambiguity is possible. Do not ask the CLI to choose the best model.

#### Basic parallel consensus

```bash
consensus \
  --models "openai/gpt-5.2,anthropic/claude-sonnet-4-5,google/gemini-2.5-pro" \
  --prompt "Should we use a monorepo or polyrepo for this project?"
```

#### With stances

```bash
consensus \
  --models "openai/gpt-5.2,google/gemini-2.5-pro" \
  --prompt "Should we migrate from REST to GraphQL?" \
  --stance "openai/gpt-5.2=for" \
  --stance "google/gemini-2.5-pro=against"
```

#### With file embedding

```bash
consensus \
  --models "openai/gpt-5.2,google/gemini-2.5-pro" \
  --prompt "Review this code for security issues" \
  --files "src/auth.ts,src/api.ts"
```

#### Sequential mode

```bash
consensus \
  --models "openai/gpt-5.2,google/gemini-2.5-pro,anthropic/claude-sonnet-4-5" \
  --prompt "Design a caching strategy" \
  --sequential
```

#### Stdin JSON

```bash
echo '{
  "models": ["openai/gpt-5.2", "google/gemini-2.5-pro"],
  "prompt": "Evaluate this approach",
  "stances": { "openai/gpt-5.2": "for", "google/gemini-2.5-pro": "against" },
  "thinking_modes": { "openai/gpt-5.2": "high" },
  "temperatures": { "openai/gpt-5.2": 0.3 },
  "temperature": 0.7,
  "files": ["src/main.ts"]
}' | consensus --stdin-json
```

#### Custom synthesis model (opt-in)

Omit `--synthesis-model` by default. Combine raw responses in the agent. Provide `--synthesis-model` only when the user explicitly asks for CLI-side synthesis.

```bash
consensus \
  --models "openai/gpt-5.2,google/gemini-2.5-pro" \
  --prompt "..." \
  --synthesis-model "anthropic/claude-sonnet-4-5"
```

#### Passthrough provider

For `passthrough` providers (`custom`, `gateway`), use provider-prefixed IDs only when the model is known to the agent or explicitly supplied by the user. If unsure, ask the user for the exact provider and model ID.

```bash
# xAI is a passthrough slot in this example. Replace example-model with the
# provider-native model ID you intend to call.
consensus \
  --models "xai/example-model,openai/gpt-5.2" \
  --prompt "Compare these responses"
```

### Model Availability

`consensus list-models --json` returns the configured-provider catalog with shape `models.list/1`. It includes:

- `cache.status` -- `fresh` (cache is current) or `stale` (refresh failed, previous cache used).
- `providers[].status` -- `catalog` (executable `route_id` rows) or `passthrough` (no catalog rows).
- `providers[].models[].route_id` -- the exact CLI input the agent should pass to `--models` or `--synthesis-model`.

Plugin model IDs (`copilot/...`, `codex/...`, `claude/...`) are NOT supported.

### Output

JSON to stdout with schema `cli.consensus/2`. Each requested model appears in `models[]` with `route_id`, `provider`, `provider_model_id`, `response`, `stance`, and a structured `error` (or `null`). The CLI returns a successful broker response when at least one participant call completed; failed participants keep their `route_id` and carry `response: null` plus a structured `error`. See [CLI Reference](./cli-reference.md) for the full output schema.

## `delegate` Skill

**Path:** `skills/skills/delegate/SKILL.md`

Guidance for delegating tasks to external CLI coding agents. This skill does not provide a built-in delegate command; instead, it documents how to shell out to agents directly.

### When to Use

- Fresh context window for a complex sub-task
- Different agent's perspective on a problem
- Parallel execution of independent tasks
- Code changes by a coding-focused agent

### Supported Agents

Shell out to these CLI agents directly (must be installed separately on `PATH`):

#### Claude Code

```bash
claude --print "Refactor the authentication module to use async/await. Files: src/auth.ts"
```

With a specific model:

```bash
claude --print "Review this PR for security issues. Files: src/api/handlers.ts" \
  --model claude-sonnet-4-5
```

#### Codex (OpenAI)

```bash
codex exec "Generate unit tests for src/utils/tokens.ts covering edge cases"
```

#### OpenCode

```bash
opencode run "Analyze the error handling patterns in src/providers/"
```

#### GitHub Copilot CLI

```bash
copilot "Explain the consensus algorithm in src/consensus.ts"
```

### Patterns

#### Parallel delegation

```bash
claude --print "Write tests for src/config.ts" > /tmp/config-tests.log 2>&1 &
claude --print "Write tests for src/consensus.ts" > /tmp/consensus-tests.log 2>&1 &
wait
cat /tmp/config-tests.log
cat /tmp/consensus-tests.log
```

#### Delegate + consensus

```bash
REVIEW=$(codex "Review src/consensus.ts for correctness and edge cases")
consensus \
  --models "openai/gpt-5.2,google/gemini-2.5-pro" \
  --prompt "Evaluate this code review: $REVIEW" \
  --stance "openai/gpt-5.2=for" \
  --stance "google/gemini-2.5-pro=against"
```

### Working Directory

Most CLI agents operate in the current directory. Use `cd` or the agent's working directory flag:

```bash
cd /path/to/project && claude --print "Run the test suite and fix any failures"
```

### Notes

- Each CLI agent must be installed separately and available on `PATH`
- Skills does not manage or install these agents
- For structured multi-model debate, use `consensus` instead of manual delegation
- Never try another agent if the one the user asked for didn't work or sidetracked

## `index-knowledge` Skill

**Path:** `.agents/skills/index-knowledge/SKILL.md`

Generate hierarchical AGENTS.md knowledge base for a codebase. Creates a root AGENTS.md plus complexity-scored subdirectory documentation. Operates in two modes: update (modify existing, create new where warranted) or create-new (regenerate from scratch).

### When to Use

- Documenting a new codebase for agent consumption
- Updating stale project documentation
- Generating structured knowledge bases with complexity scoring

### Usage

```bash
--create-new   # Read existing, remove all, regenerate from scratch
--max-depth=2  # Limit directory depth (default: 5)
```

Default mode is update: modify existing AGENTS.md files and create new ones where warranted.

### Workflow

1. **Discovery + Analysis** -- Launch parallel explore agents, run bash structural analysis, LSP codemap, read existing AGENTS.md files
2. **Score & Decide** -- Score directories by file count, code ratio, symbol density, and reference centrality; determine which directories need AGENTS.md
3. **Generate** -- Root AGENTS.md first, then subdirectory AGENTS.md files in parallel
4. **Review** -- Deduplicate, trim, validate against quality gates (50-150 lines, no generic advice, no parent redundancy)

### Notes

- Not every directory needs an AGENTS.md; scoring threshold determines placement
- Child AGENTS.md files must never repeat parent content
- When Serena MCP is available, the root AGENTS.md uses compact orientation (5-12 lines for structure); otherwise falls back to navigation-focused format (15-35 lines)

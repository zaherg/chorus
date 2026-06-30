# Chorus

> [!IMPORTANT]
> This project is under heavy active development. Expect frequent breaking changes, new features, and reworked internals. Lock to a specific version if you depend on it in production.

Chorus is a collection of AI Agent Skills.

The consensus skill providing multi-model AI consensus, backed by a supporting CLI that act as a broker between the coding agent and model providers. It query multiple AI SDK model providers in parallel, return raw model responses, and your coding agent will compares, combines, and synthesize a final recommendation.

## Install

### Via the skills CLI

Add the agent skills from this repo with Vercel's `skills` CLI:

```bash
npx --yes skills add zaherg/chorus
```

> [!NOTE]
> In the first use of the skill, it will download and install the binary from the github release using the install script.


**[Optional]** Then run the skill-local installer (from the installed skill folder) to fetch the pinned GitHub Release binary:

```bash
.agents/skills/consensus/scripts/install.sh
```

The installer downloads the binary into `bin/consensus` under the current skill directory. Use `scripts/install.sh --prefix DIR` to install to `DIR/consensus`, or `scripts/install.sh --no-verify` only when checksum verification must be skipped explicitly.

### From source

Requires [Bun](https://bun.sh) 1.3.14 or newer.

```bash
git clone https://github.com/zaherg/chorus.git && cd chorus
bun install
bun run build:binary
```

Then you can get the CLI from the `dist` directory.

### Standalone use

This CLI is built for agents. If you want to use it on your own, read the bundled skill files for usage details:

- [`skills/consensus/SKILL.md`](./skills/consensus/SKILL.md)
- [`skills/delegate/SKILL.md`](./skills/delegate/SKILL.md)

## Configuration

The CLI stores its configuration at `~/.config/chorus/config.json`. The file is created automatically on first run with empty defaults, so you only need to edit it to add credentials and preferences.

Set the provider API keys you intend to use (for example `openai_api_key`, `anthropic_api_key`, `google_api_key`, `openrouter_api_key`). For any key you can use a `$ENV_VAR` reference instead of a literal value. At least one configured provider key is required to run a consensus.

Optional settings include `cli_timeout_ms`, `provider_timeout_ms`, `log_level`, `max_concurrent_processes`, and `allow_insecure_custom`.

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | Success (at least one participant response collected) |
| 1 | Broker error (config load, all participants failed, or unrecoverable catalog error) |
| 2 | Argument parse error or invalid stdin JSON |
| 3 | Model resolution error (ambiguous or unknown `route_id`, or no providers configured) |

## Agent Skills

Skills follows the [Agent Skills specification](https://agentskills.io/specification). Two skills are bundled:

### consensus

[`skills/consensus/`](./skills/consensus/SKILL.md) runs multi-model independent evaluation of a prompt, file set, decision, or proposal. It fans out across selected models in parallel and brokers the raw model responses back to you. You combine them in the agent rather than relying on CLI-side synthesis.

### delegate

[`skills/delegate/`](./skills/delegate/SKILL.md) shells out to local CLI coding agents for focused sub-tasks or parallel independent work. It targets locally-installed agents only: Claude Code, Codex, OpenCode, and GitHub Copilot. If an agent is not installed on the machine, delegate does not run it.

## Development

Useful commands:

```bash
bun test
bun run build
bunx tsc -p tsconfig.json --noEmit
bun run src/cli.ts
bun run src/cli.ts --help
bun run src/cli.ts list-models --json
bun run src/cli.ts --schema
```

The local test suite uses fake keys and dependency injection; no live provider
API keys are required.

The repo currently uses:

- Bun for runtime and package management
- TypeScript with ES modules
- Zod v4 for validation
- Biome for linting and formatting

The CLI reads its version from `package.json` at build time.

## Disclaimer

Skills orchestrates requests to third-party AI providers. Model output can be incomplete, outdated, or incorrect. Review important decisions and code changes before relying on them.

Provider APIs, model availability, pricing, and terms can change independently of this package. Keep credentials private and follow each provider's usage policies.

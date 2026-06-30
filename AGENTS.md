# AGENTS.md

## Purpose

This file defines principles and contracts that remain stable while implementations change.

## Response style

- Be concise and technically precise.
- Lead with the answer or outcome.
- Include only details needed to understand or act.
- Prefer short paragraphs and small lists.
- Avoid repeating the request, process narration, and unnecessary background.
- Expand only when safety, ambiguity, or correctness requires it.

## Collaboration Notes

> importance level: Critical
> enforcement: Mandatory agent workflow

- Never use em-dash characters anywhere: prose, docs, code comments, commit messages, or PRs. Use commas, colons, parentheses, or separate sentences instead.
- Use Subagent-Driven execution for multi-step work with independent tasks, broad reviews, or high-risk changes. Handle simple, tightly coupled tasks directly.
- Continue without confirmation when scope is clear and actions are safe. Ask only when blocked by material ambiguity, missing authority, or irreversible risk.
- Serena MCP is mandatory for code understanding and code changes. Start investigation with Serena's semantic tools, such as symbol overviews, symbol search, references, declarations, implementations, diagnostics, and pattern search, before reading source files directly or using raw grep, regex, or ad hoc exploration.
- Use Serena's refactoring and symbolic editing tools for renames, safe deletes, symbol body edits, insertions, and related changes whenever applicable.
- Direct file reads and basic file edits are allowed for small non-code files, configs, generated files, or cases Serena cannot handle. State the reason whenever bypassing Serena.
- Treat bypassing Serena for code exploration without one of those reasons as a process violation.
- Prefer simple, robust, maintainable solutions. Treat implementation cost as secondary, but keep effort proportional to the problem and expected value.
- When writing commit messages, NEVER auto-add your agent name as co-author.
- Never manually modify CHANGELOG.md files or any files that are marked as auto-generated.
- When writing or substantially editing long Markdown files, put each full sentence on its own line.
- Preserve normal Markdown structure, but avoid wrapping multiple sentences onto one physical line.
- For bug fixes, reproduce the failure through the closest practical user-facing path. If E2E reproduction is unavailable, use the highest realistic integration level and document the limitation.
- When end-to-end testing a product, inspect the UI carefully and maintain pixel-level quality within the task's scope.
- Report unrelated defects discovered during testing. Fix them only when they block verification, are clearly safe and local, or the user authorizes broader scope.


---

# PROJECT KNOWLEDGE

## CORE CONTRACTS

- TypeScript uses strict mode with bundler module resolution.
- Runtime validation uses Zod v4 schemas.
- Biome formats and checks the project.
- Expected operational failures use `Result<T, ToolError>`.
- Read messages from `unknown` errors with `getErrorMessage()`.
- Only `src/providers/` may import or call `ai` or `@ai-sdk/*` packages.
- Provider registry code stays catalog-stateless.
- Model resolution uses broker flow, `loadCatalog` plus `resolveRoute`.
- Do not restore removed legacy model listing or provider inference paths.
- Catalog data is validated, normalized, cached, and may serve safe stale data after fetch failure.
- Custom API URLs reject credentials, fragments, private and loopback targets, and IPv4-mapped IPv6 bypasses.
- `resolveAndValidateHostname` protects connection-time DNS resolution.
- `createSafeCustomFetch` validates every custom request and redirect target.
- API keys come from environment variables or `$ENV_VAR` configuration references.
- Config directory and file permissions are repaired to `0700` and `0600`.

## TESTING AND BUILD

- Treat `package.json` and CI configuration as the source of truth for Bun and dependency versions.
- Tests run in isolated processes.

## RELEASE

- Releases are driven entirely by GitHub Actions. `prepare-release.yml` (manual dispatch) bumps the version, updates `CHANGELOG.md`, and pushes a `v*` tag; the tag push triggers `release-orchestrator.yml` (test gate then draft release). No local release script exists.

## AVOID

- Do not hardcode API keys or other secrets.
- Do not use `any`.
- Do not use plugin model identifiers in consensus configuration.
- Do not treat derived documentation as authoritative over specs or hand-written prose.

## NOTES

- `src/utils.ts` and `src/utils/` coexist, so bare `@/utils` resolves to the file.
- Import consensus contracts directly from `@/types/consensus`.
- `src/types/index.ts` intentionally omits consensus contract exports.

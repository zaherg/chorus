# Security Policy

## Supported Versions

Skills is currently in pre-release. Security fixes are applied to the latest version only.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report vulnerabilities by emailing the maintainer directly or opening a [GitHub Security Advisory](https://github.com/zaherg/chorus/security/advisories/new) (private disclosure).

Include:
- Description of the vulnerability and its potential impact
- Steps to reproduce
- Any suggested fix (optional)

You can expect an acknowledgement within 48 hours and a resolution timeline within 7 days for critical issues.

## Security Model

### Runtime Config

Skills reads provider API keys and runtime settings from
`~/.config/chorus/config.json`. Config string values may reference shell
variables with `$ENV_VAR`; prefer this for API keys so secrets do not need to be
stored directly in the file. On POSIX systems, first-run creation uses `0700`
for the config directory and `0600` for `config.json`, and broader existing
modes are repaired best-effort when the config is loaded. Avoid logging full
config files, environment dumps, or command lines that contain secrets.


### Provider Endpoints

Skills sends prompts, embedded file contents, model-discovery requests, and authentication credentials to configured provider endpoints. Configured providers are data recipients and must be trusted.

**OpenAI-Compatible Custom Providers**

Custom provider endpoints configured via `custom_url` are treated as trusted
local configuration. The CLI applies guardrails: HTTPS enforcement for
non-loopback URLs, local HTTP allowance for `localhost`, `127.0.0.1`, and `::1`,
rejection of blocked internal private/link-local direct hosts including
IPv4-mapped IPv6 literals, and rejection of URL credentials and fragments. It
does not perform DNS rebinding protection, redirect-to-private-host defense, or
resolved-IP enforcement. Custom providers receive the same data as SaaS
providers: prompts, embedded file contents, and authentication headers. Only
configure endpoints you trust.

### Logging

Secret redaction is applied to log messages and structured context before they reach stderr and file sinks. This is defense-in-depth and does not cover direct `process.stderr.write` paths or provider-generated error payloads that bypass the logger wrapper. Do not log raw prompts, full provider responses, or authentication headers.

### File Embedding

When `--files` or the stdin JSON `files` field is used, local file contents are embedded into prompts sent to all selected participant providers and the synthesis provider. The CLI emits a privacy warning to stderr but does not gate or validate file content. Current JSON output may include embedded file contents via the `embedded_text` field. Treat file contents as transmitted to third parties.

### AI Review Disclosure

The security controls in this codebase were designed and reviewed with AI assistance (Claude). No independent human security audit has been performed as of the initial release. Community review is welcome.

## Known Limitations

- Prompts passed to CLI tools are visible in the OS process table (`ps`)

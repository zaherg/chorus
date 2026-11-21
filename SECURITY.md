# Security Policy

## Supported Versions

Chorus is currently in pre-release.
Security fixes are applied to the latest version only.

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

Chorus reads provider API keys and runtime settings from `~/.config/chorus/config.json`.
Config string values may reference shell variables with `$ENV_VAR`; prefer this for API keys so secrets do not need to be stored directly in the file.
On POSIX systems, first-run creation uses `0700` for the config directory and `0600` for `config.json`, and broader existing modes are repaired best-effort when the config is loaded.
Avoid logging full config files, environment dumps, or command lines that contain secrets.

### Provider Endpoints

Chorus sends prompts, embedded file contents, model-discovery requests, and authentication credentials to configured provider endpoints.
Configured providers are data recipients and must be trusted.

**OpenAI-Compatible Custom Providers**

Custom provider endpoints configured via `custom_url` are treated as trusted local configuration.
The CLI applies multiple URL and network guardrails:
- HTTPS enforcement for non-loopback URLs (`allow_insecure_custom: true` only relaxes `https:` to allow `http:`, and does not disable any other check).
- Local HTTP allowance for literal `localhost`, `127.0.0.1`, and `::1`.
- Rejection of URL credentials, URL fragments, `.localhost` subdomains, private/RFC 6890/link-local hosts (including IPv4-mapped IPv6 literals), and DNS records that resolve to blocked or loopback addresses.
- Connection-time resolved-IP validation and IP pinning via `resolveAndValidateHostname` and `createSafeCustomFetch` (`node:http`/`node:https` pinned lookup) to mitigate DNS rebinding.
- Rejection of all HTTP redirects (`redirect: "manual"` and 3xx response rejection).

Custom providers receive the same data as SaaS providers: prompts, embedded file contents, and authentication headers.
Only configure endpoints you trust.

### Logging

Secret redaction is applied to log messages and structured context before they reach stderr and file sinks. This is defense-in-depth and does not cover direct `process.stderr.write` paths or provider-generated error payloads that bypass the logger wrapper. Do not log raw prompts, full provider responses, or authentication headers.

### File Embedding

When `--files` or the stdin JSON `files` field is used, local file contents are embedded into prompts sent to all selected participant providers and the synthesis provider. The CLI emits a privacy warning to stderr but does not gate or validate file content. Current JSON output may include embedded file contents via the `embedded_text` field. Treat file contents as transmitted to third parties.

### AI Review Disclosure

The security controls in this codebase were designed and reviewed with AI assistance (Claude). No independent human security audit has been performed as of the initial release. Community review is welcome.

## Known Limitations

- Prompts passed to CLI tools are visible in the OS process table (`ps`)

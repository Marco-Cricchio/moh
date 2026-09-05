# Security Policy

## Supported versions

moh ships as a self-contained binary distributed via
[GitHub Releases](https://github.com/Marco-Cricchio/moh/releases) with a
built-in self-update channel. Security fixes land on `develop` and are
published in the next release; always update to the latest release before
reporting an issue.

| Version | Supported |
| --- | --- |
| latest release | ✅ |
| older releases | ❌ (update first) |

## Reporting a vulnerability

Please use
[GitHub's private vulnerability reporting](https://github.com/Marco-Cricchio/moh/security/advisories/new)
for anything that could be a security issue. Do **not** open a public issue.

You will get an acknowledgment within a few days and a follow-up as the report
is triaged.

## Scope

moh is a coding agent: **by design it reads files and executes commands in your
project**, gated by its permission system (allow/ask/deny rules, per-tool
defaults, extension vetoes). The following are *not* vulnerabilities:

- moh running a command the user (or a permission rule) authorized
- an agent editing files inside the project root under an `allow` rule
- prompt-injection outcomes that stay within the granted permissions

The following are in scope:

- **Permission system escapes**: a tool call executed without the required
  permission (rule bypass, mis-merged rule precedence, deny/ask not honored,
  extension veto ignored)
- **Out-of-root writes** persisting as reusable rules (they must always be
  asked per-occurrence)
- **Credential leakage**: tokens from provider auth or MCP stores appearing in
  logs, transcripts, session files, or error messages
- **Self-update channel**: binary or skill-bundle integrity (signature/hash
  checks bypassed, update served from an unexpected origin)
- **Session file integrity**: the append-only event log being rewritten or
  forged in a way replay/resume would trust
- **MCP trust model**: project-scope MCP servers being started without the
  user-config trust decision

When in doubt, report privately — we would rather triage a non-issue than
miss a real one.

## Disclosure

We follow coordinated disclosure: fixes are developed privately, released, and
credit is given to reporters in the release notes unless anonymity is
preferred.

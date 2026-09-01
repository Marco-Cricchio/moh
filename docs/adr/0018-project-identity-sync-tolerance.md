# ADR-0018: Stable project identity and sync-tolerant user data

Status: accepted · Date: 2026-09-01 · Issue: #397 (parent: #396, session continuity, vision note 28) · Implementation: #398, #399, #400, #401, #402

## Context

moh's per-project user data (session logs, memory) lives under
`~/.moh/projects/<slug>/`, where the slug is `basename + "-" + sha256(cwd)`
(`session-store.ts`). Two machines with different checkout paths produce
different slugs: sessions, memory and MCP trust never find each other, so
"resume yesterday's work on the office PC" requires manual path gymnastics.
`mcpTrust` in the user config is keyed by absolute project path — same
problem. The memory lock's mtime-based staleness is fragile under sync
transports (iCloud/Dropbox perturb mtimes), and interleaved appends to one
session file from two machines corrupt history silently. There is no
headless way to discover a session: `moh run --session <file>` needs the
exact path.

## Decision

moh becomes **sync-tolerant, not sync-owning**: no transport ships in Core
(ADR-0004); the user syncs `~/.moh/` through any channel. The portable
artifacts have stable, append-only formats and repeatable ownership rules, so
retransferring an unchanged artifact does not require a moh-side merge. This
is conflict-safe **for serial use only**: moh detects a competing session
writer and does not claim to merge divergent histories or make concurrent
writes safe.

- **Project identity** (`resolveProjectIdentity(cwd, home)` in
  `project-identity.ts`): a stable uuid in `.moh/project.json` at the
  project root, created silently on first resolution (O_EXCL, race-safe).
  The slug becomes id-derived; the legacy hashed slug remains the fallback
  when the file is unreadable, and a legacy project directory is migrated
  once by atomic rename. This file is a **deliberate exception to principle
  5** ("sessions and memory are user data, never in the project's `.moh/`"):
  it contains only a random id — no paths, no user data — and committing it
  is what makes clone-continuity work. Committing is the user's choice; moh
  does not gitignore it.
- **Portable set (allowlist)**: session JSONL logs, memory (index + topic
  files), user-authored skills, user config excluding the `auth` section.
  **Ignore-list (local by construction)**: memory lock files, bash re-run
  ledger outputs, update-check cache, first-party skills + their hash
  manifest (binary-owned), `auth` tokens (one `moh provider login` per
  endpoint per machine — tokens never travel).
- **mcpTrust re-keyed** by the identity slug; pre-#396 absolute-path keys
  stay readable so existing consents survive the upgrade.
- **Single-writer sessions**: `SessionStore.append` tracks its byte
  baseline and emits a `session_writer_conflict` chrome event when the file
  grows from elsewhere. Warning only; concurrent same-file writing is
  declared unsupported and auto-fork is a follow-up. The log stays
  append-only and integral either way.
- **Content-based memory lock**: the lock records `{pid, bootId}` (per-machine
  id); reclamation is by content (foreign machine / dead pid), with the
  mtime rule kept only as the legacy-empty-lock fallback.
- **Headless discovery**: `moh run --resume [query]` lists/filters the
  project's sessions newest-first and resumes the unique match. No TUI
  dependency.
- Session-log schema versioning is unchanged: cross-machine reads of a
  newer schema keep failing loudly.

## Consequences

- Single-machine users see zero behavior change beyond the silent identity
  file and the one-time directory migration.
- Users who sync `~/.moh/` gain cross-machine continuity for sessions,
  memory, skills and config-feel; credentials and binary-owned state never
  enter the sync channel.
- Session discovery is exposed through `SessionStore.summaries`, a client
  need under ADR-0004; project-identity resolution itself remains internal
  to the Core.
- Two machines writing the *same* session file concurrently still risk
  interleaved lines; moh now warns instead of staying silent, but recovery
  (fork on conflict) remains manual.
- The identity file in `.moh/` means project-level and user-level state are
  no longer perfectly separable by directory; future project-`.moh` content
  must justify itself against the same "no user data" bar.

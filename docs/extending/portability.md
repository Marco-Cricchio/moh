# Portability across machines

**Who this is for:** you use moh from more than one machine and want to
continue the same project's work. This page is the user-facing contract for
moh's data. It applies whether you use the TUI, `moh run`, or embed the Core.

moh is **sync-tolerant**, not sync-owning ([ADR-0018](../adr/0018-project-identity-sync-tolerance.md)). It does not select, configure, or operate a sync service. You own the transport — for example iCloud, Dropbox, or a private Git repository — and moh makes the data below safe to carry through it for serial use. Recopying an unchanged portable artifact needs no moh-side merge; concurrent writers are not supported.

## Set up a channel

1. Arrange for your chosen channel to copy the portable parts of `~/.moh/`
   between machines. Do not copy it blindly: use the allowlist and ignore-list
   below.
2. Keep `.moh/project.json` when cloning or sharing the project. moh creates
   it silently on the first open if it is absent. It contains only an opaque
   project id, no absolute path or user data. moh does not gitignore it;
   committing it is optional, but makes a fresh clone resolve the same session
   and memory directory.
3. On every machine, authenticate each endpoint locally with
   `moh provider login <endpoint>`. Credentials deliberately do not travel.
4. Use a session serially. Before working on the same session from another
   machine, finish or fork it on the first one.

The project id selects the same `~/.moh/projects/<slug>/` directory despite
checkout paths differing across machines. Existing path-hashed directories
migrate automatically once when a declared identity is first resolved.

## What travels

Sync only these user-owned artifacts:

| Artifact                       | Why it travels                                                            |
| ------------------------------ | ------------------------------------------------------------------------- |
| `projects/<slug>/*.jsonl`      | Append-only session histories; resume and fork use them.                  |
| `projects/<slug>/memory/`      | Durable project memory (the index and topic files).                       |
| `skills/` user-authored skills | Your workflows should be available on every machine.                      |
| `config`, excluding `auth`     | Provider choices and user preferences make another machine feel the same. |

This allowlist is deliberate. New state is not portable merely because it
happens to be below `~/.moh/`.

## What stays local

Exclude these artifacts from the channel:

| Artifact                                       | Why it stays local                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `auth` in `config`                             | OAuth/API credentials are machine-local; never export or copy tokens. |
| `projects/<slug>/memory/.lock`                 | A transient, machine-specific coordination lock.                      |
| `bash-ledgers/` and their output files         | A local short-lived cache for expensive command re-runs.              |
| `update-check.json`                            | A local update-check cache.                                           |
| First-party skills and `.moh-first-party.json` | The installed binary owns and refreshes these files.                  |

First-party skills are restored or upgraded by the binary. Keep your own
skills distinct from them when configuring a selective sync rule.

## Conflict and compatibility behavior

A session JSONL file has one writer. Concurrently opening the same session on
two machines is unsupported: moh detects external file growth at append
boundaries and emits a `session_writer_conflict` warning, but it does not
merge writers or auto-fork. Fork manually to recover a divergent line of
work.

Session logs remain append-only and schema-versioned. An older moh binary
fails loudly rather than reading a newer schema incorrectly; upgrade it
before resuming that session. These limits make the contract conflict-safe
for serial cross-machine use, not a substitute for a collaborative,
multi-writer sync protocol.

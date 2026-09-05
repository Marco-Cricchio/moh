# ADR-0013: Distribute moh as a single compiled binary

Status: accepted · Date: 2025 · Spec: internal cli-binary-distribution spec (local)

## Context

moh needs public distribution: install once, then type `moh`. The two viable channels are an npm package (requires Node-or-Bun at the user's end and, for Node users, porting ~8 core modules off Bun runtime APIs: `Bun.spawn`, `Bun.file`, `Bun.Glob`, `Bun.CryptoHasher`, `Bun.sleep`) or a self-contained executable compiled with `bun build --compile`, which embeds the Bun runtime.

## Decision

Ship a single compiled binary per platform (macOS arm64/x64, Linux x64 at 0.1.0), distributed via GitHub Releases with a `curl | sh` installer and, later, a Homebrew tap. First-party skills are embedded in the binary and copied to `~/.moh/skills/` on first run via the existing hash-manifest workflow seam. Do not publish to npm and do not maintain Node compatibility; revisiting that is an explicit future decision.

## Consequences

- Zero runtime prerequisites for users; the `bun …` developer entrypoint stays the source of truth.
- No Node port layer to build or double-test, at the cost of a per-platform build matrix in CI and larger artifacts (~tens of MB).
- Anything the binary reads at runtime must be embedded or user-owned (`~/.moh/…`); repo-relative reads are a bug in the binary context.
- Windows support is deferred until the TUI's raw-terminal story there is understood.

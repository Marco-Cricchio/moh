# ADR-0044: Windows support is WSL-first — the native binary stays data-gated

Status: accepted · Date: 2026-09-23 · Related: ADR-0013 (refines its Windows deferral), cli-binary-distribution spec

## Context

moh ships to macOS and Linux. ADR-0013 deferred Windows wholesale — "until
the TUI's raw-terminal story there is understood" — and the distribution spec
fixed the 0.1.0 platform set at macOS arm64/x64 and Linux x64.

Windows is now the open gap, and it is one the harness category has answered
in two incompatible ways. A survey of the peers (2026-09) found that Claude
Code ships a **native** Windows build and presents a three-way setup table
(native / WSL 2 / WSL 1, with sandboxing available only under WSL 2), while
Codex CLI ships a PowerShell installer and never mentions WSL at all; Gemini
CLI targets Windows through npm. So "the category is WSL-first" is false —
moh choosing WSL-first is a deliberate divergence from the most direct
competitors, not a convergence with them.

A native Windows build is not a packaging task. It pulls in ConPTY (moh's PTY
substrate — 13 test files depend on it), a Windows path model (file mentions,
realpath-anchored permission globs, project slugs), a second shell grammar
(the bash tool and shell-word permission tokens), and a Windows CI matrix. The
users who would benefit first — developers who live in a terminal — already
have, or can install in one command, a Linux environment (`wsl --install`).

The operational reality of the Windows developer is two scenarios, and both
were in scope for the phase that produced this decision: the repository inside
the WSL distro (identical to Linux), and the repository on NTFS reached from
WSL through `/mnt/c` (where every file operation crosses the 9P boundary and
grep/glob over a large tree is dramatically slower). Neither is served by
promising native support, and the second is the one a user is most likely to
hit by accident, since that is where their Windows-side checkouts live.

## Decision

**Windows support is WSL-first: moh reaches Windows as the Linux binary running
inside WSL, distributed through the existing checksummed `curl | sh` installer.
A native Windows binary is not rejected — it is deferred, gated by usage data.**

- **One work package serves both repository scenarios.** Nothing in the core
  changes for the distro-internal case; the `/mnt` case is served by honest
  guidance plus one visible tool-side signal (below), never by a silent
  fallback or a hidden perf hack.
- **Distribution extends the existing channel.** `scripts/install.sh` already
  downloads the release binary, verifies its sha256, and installs to
  `~/.local/bin`. Phase 1 adds `linux-arm64` to the build targets and the
  release matrix (covering ARM64 Windows laptops under WSL), a warning-with-
  consent path when invoked as root, a non-blocking notice when running inside
  WSL, and installation hardening (same-filesystem atomic install; a
  pre-replacement smoke test so a binary that cannot execute — e.g. musl
  incompatibility on Alpine — aborts cleanly instead of destroying a working
  install).
- **The `/mnt` slowness is surfaced, not buried.** moh detects once, at
  session assembly, that the project root resolves under `/mnt/` and shows a
  persistent, never-blocking hint (a TUI footer line; one line for headless
  `moh run`). It is always on, with no config to silence it in phase 1. This
  is a conscious **first-in-market** choice: the survey found that no peer
  offers guidance, detection, or warnings for NTFS-via-WSL projects — the
  closest anyone comes is a setup table telling users to pick a mode based on
  where their projects live.
- **The first minute is documented where the user arrives.** An install
  subsection in the README (`Windows (via WSL)`: install WSL, run the same one
  command inside the distro, keep projects in the distro filesystem) and a
  short `/mnt` explanation added to the manual's getting-started page, whose
  generated mirror is refreshed by the existing manual generator.

## Consequences

- No ConPTY, no Windows path model, no PowerShell tool, no Windows CI matrix.
  The core, the PTY substrate, the permission grammar and the test suite stay
  exactly as they are.
- **WSL hides the path problem rather than solving it.** Paths remain POSIX
  because the distro presents them that way; a future native phase inherits the
  whole path/shell/PTY problem untouched. This is the cost of the deferral, and
  it is the main thing a future ADR would have to pay.
- **Nothing in CI exercises WSL.** The pipeline can build and smoke-test the
  Linux binaries natively (including on an ARM64 runner), and can unit-test the
  installer, but there is no WSL runner: the `/mnt` detection, the footer hint
  in a real WSL terminal, and the WSL notice are covered by unit tests and
  review, not end-to-end. Accepted and recorded, not hidden.
- The installer's root path warns and asks for consent on a terminal (reading
  from `/dev/tty`, since under `curl | sh` stdin is the script itself) and, with
  no terminal to ask, proceeds while still printing the risk. It is never
  silent, and never a hard refusal — the person running it keeps the decision.
- ADR-0013 is refined, not reversed: Windows is still out of the *native*
  platform set, and this ADR records what "deferred" now means — served through
  WSL, with promotion to native judged on usage data.

## Alternatives considered

- **Native-first.** The peers prove it is possible, and the raw-terminal story
  is now better understood than when ADR-0013 deferred it. Rejected for now:
  the cost (ConPTY, path model, shell grammar, a second CI matrix) is large
  relative to the users it unlocks today, and the technical audience that would
  adopt moh on Windows is the one least blocked by installing WSL. This is the
  option a future ADR revisits when usage data justifies it.
- **WSL-first but docs-only for the `/mnt` cost.** Rejected by explicit owner
  decision: the visible hint makes the cost legible at the moment it is
  incurred, which is exactly where the user can still act on it (move the
  project into the distro). Docs alone reach only the reader who already
  suspects.
- **Shipping `musl` build variants and version pinning with the ARM64 work.**
  Rejected for phase 1: the pre-replacement smoke test turns a failed run into
  a clear message, which covers the Alpine case at a fraction of the cost;
  pinned installs are a separate future decision.
- **A hard refusal to run the installer as root.** Rejected: the owner's
  position is that the risk decision belongs to the person running the command
  — the tool's job is to make the risk visible, not to overrule it.
- **Additional channels (Homebrew-on-Linux tap, npm package).** Out of phase 1:
  the compiled binary through the checksummed script is the single headline
  channel, and each extra channel is maintenance surface with no proven demand.

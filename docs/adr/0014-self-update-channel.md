# ADR-0014: Self-update channel for the moh binary

Status: accepted · Date: 2025 · Spec: internal cli-binary-distribution spec (local), update channel section

## Context

ADR-0013 ships moh as a compiled binary via GitHub Releases. Users need to learn that a new
version exists and get to it with minimal friction. The update path must not require the
install script again, must be verifiable (release checksums), and must respect the same
privacy posture as the existing skills upstream check (opt-out, background, silent on failure).

## Decision

1. **Update check**: at TUI startup, query the GitHub API `releases/latest` endpoint for the
   newest stable release. The result is cached in `~/.moh/update-check.json`
   (`{ lastCheckedAt, latestVersion }`), so the "update available" notice is deterministic even
   offline. The check is on by default and can be disabled with an `updateCheck` flag in the user
   config (independent of workflow mode). It is skipped entirely in dev runs (non-compiled
   execution detected via `$bunfs` in `import.meta.dir`).
   **Amended 2026-08-30 (#328, owner decision):** the check runs on *every* launch, not only
   when the cache is stale; the 24h cache stays as offline fallback and storage. While a
   session is open past the 24h window, the check re-fires so a long-running user is notified
   in-session when a new release ships. The privacy posture is unchanged (opt-out, no
   identifiers, silent failure, never delays startup). Additionally, a successful
   `moh update` refreshes the cache (`lastCheckedAt: now`, `latestVersion: installed`) so the
   cache agrees with the freshly updated binary, and the TUI projection suppresses the
   nonstable notice when the cache predates the running binary (cache-stale, not dev build).
   **Amended (#348, owner decision):** while a TUI session is open, a single 30-minute
   scheduler drives *both* update call-homes: the binary `releases/latest` check above and
   the first-party skills upstream-index check (the skills `index.json` on the repo's main
   branch). The skill check is no longer gated by workflow mode or by the
   `workflow.upstreamCheck` setting — that setting is **deprecated** (it now controls
   nothing; users who opted out of the skill check should set the shared
   `updateCheck: false`). One tick never overlaps the previous in-flight one, results are
   discarded at unmount, background failures stay silent, and polling is **notify-only**:
   skill files are never touched without the explicit diff-and-consent
   `/skills update apply` path. The shared opt-out (`updateCheck`) governs both checks;
   neither carries identifiers.
2. **Notice**: when a newer stable version exists, the TUI shows a one-shot toast at startup
   and a fixed line on the home screen inviting the user to run `moh update`; **#328:** the
   notice also renders left-aligned on the second row of the status bar (the cwd/branch/mode
   tail stays right-aligned on the same row and is never displaced). When the running
   version is *newer* than the latest stable (dev/non-stable build), the notice says so and
   the remedy is the same command. Network failures, malformed responses, and timeouts are
   handled with total silence: an update check must never degrade startup. **#348:** a
   discovered skill update gets the same persistent status-row-2 representation (count +
   `/skills update`), coexisting with the binary notice; both clear after refresh, version
   change, or applying the updates.
3. **`moh update`**: the CLI self-updates. It downloads the platform asset from the latest
   GitHub Release, verifies its sha256 against the release's `checksums.txt`, and replaces the
   running executable atomically (download to a temp file, rename over the current binary).
   It always targets the latest stable — including a downgrade from a non-stable build, which
   asks for confirmation first. In dev runs it refuses and points to git.
   Prerelease-suffixed builds (e.g. `0.2.0-rc.1`) count as non-stable and follow the same
   confirmation path. Non-interactive runs (no confirm callback, no `--yes`) decline the
   downgrade and exit non-zero. The `MOH_RELEASES_URL` env var overrides the endpoint — it
   exists for the e2e harness (`npm run e2e:update`) and is not a user-facing knob.
   **Amended 2026-08-30 (#351, owner decision):** the command reports progress instead of
   running silent. The core exposes an optional `onProgress` callback on `performSelfUpdate`
   emitting phase transitions (`checking`, `downloading` with the received byte count,
   `verifying`, `installing`); rendering lives entirely in the CLI (headless core, thin
   clients). On a TTY, one line per phase — committed with `✓` (or `✗` when that phase is
   where the update failed) — with a braille spinner animating the open line; the interactive
   downgrade prompt pauses the spinner so readline owns the terminal. Piped (non-TTY) runs
   and `NO_COLOR` degrade to plain milestone lines, no ANSI, no timers — logs and the e2e
   harness keep their existing contracts (exit codes, final messages, output streams).

## Consequences

- One upgrade mechanism for binary users; the install script remains the first-install path
  (and stays a working alternative).
- The updater trusts only GitHub Releases plus the published checksums; no secondary version
  file to keep in sync.
- A call-home exists (version check); it is opt-out, cached, carries no identifiers, and is
  documented in the README.
- **#348:** the call-home surface is two endpoints (binary release + skills index) on one
  30-minute cadence behind one opt-out; `workflow.upstreamCheck` is deprecated.

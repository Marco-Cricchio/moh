# ADR-0014: Self-update channel for the moh binary

Status: accepted · Date: 2025 · Spec: `docs/spec/cli-binary-distribution.md` (update channel section)

## Context

ADR-0013 ships moh as a compiled binary via GitHub Releases. Users need to learn that a new
version exists and get to it with minimal friction. The update path must not require the
install script again, must be verifiable (release checksums), and must respect the same
privacy posture as the existing skills upstream check (opt-out, background, silent on failure).

## Decision

1. **Update check**: at TUI startup, at most once every 24h, query the GitHub API
   `releases/latest` endpoint for the newest stable release. The result is cached in
   `~/.moh/update-check.json` (`{ lastCheckedAt, latestVersion }`), so the "update available"
   notice is deterministic even offline. The check is on by default and can be disabled with an
   `updateCheck` flag in the user config (independent of workflow mode). It is skipped entirely
   in dev runs (non-compiled execution detected via `$bunfs` in `import.meta.dir`).
2. **Notice**: when a newer stable version exists, the TUI shows a one-shot toast at startup
   and a fixed line on the home screen inviting the user to run `moh update`. When the running
   version is *newer* than the latest stable (dev/non-stable build), the notice says so and
   the remedy is the same command. Network failures, malformed responses, and timeouts are
   handled with total silence: an update check must never degrade startup.
3. **`moh update`**: the CLI self-updates. It downloads the platform asset from the latest
   GitHub Release, verifies its sha256 against the release's `checksums.txt`, and replaces the
   running executable atomically (download to a temp file, rename over the current binary).
   It always targets the latest stable — including a downgrade from a non-stable build, which
   asks for confirmation first. In dev runs it refuses and points to git.
   Prerelease-suffixed builds (e.g. `0.2.0-rc.1`) count as non-stable and follow the same
   confirmation path. Non-interactive runs (no confirm callback, no `--yes`) decline the
   downgrade and exit non-zero. The `MOH_RELEASES_URL` env var overrides the endpoint — it
   exists for the e2e harness (`npm run e2e:update`) and is not a user-facing knob.

## Consequences

- One upgrade mechanism for binary users; the install script remains the first-install path
  (and stays a working alternative).
- The updater trusts only GitHub Releases plus the published checksums; no secondary version
  file to keep in sync.
- A call-home exists (version check); it is opt-out, cached, carries no identifiers, and is
  documented in the README.

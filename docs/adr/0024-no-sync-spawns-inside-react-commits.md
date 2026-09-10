# ADR-0024: No synchronous spawns inside React commits

Status: accepted · Date: 2026-09-10 · Issue: #595 flake family

## Context

The PTY suite carried an intermittent failure for days: a TUI test would
hang through its readiness budgets and then fail on an unrelated assertion.
The raw PTY dump captured the real cause — the TUI child **crashed at
startup** with:

```
error: Should not already be working.
      at performWorkOnRoot (react-reconciler)
      ...
      at execFileSync
      at canonicalRemoteSlug   (core/project-identity.ts)
      at listSessionSummaries  (core/session-store.ts)
      at isColdDirectory       (core/handoff-coldstart.ts)
      at <anonymous>           (tui/App.tsx — mount-time passive effect)
```

`canonicalRemoteSlug` runs `execFileSync("git", ["remote", "get-url", …])`.
When that spawn's completion re-entered the reconciler scheduler while a
commit was still in flight (a race that fires only under load — exactly the
condition of a full PTY suite run), react-reconciler's development build
threw from `performWorkOnRoot` and Ink died before the first frame. The
harness then drained its readiness budgets against a dead screen, turning a
one-second crash into a ~25-second confusing failure.

The same pattern existed elsewhere: `resolveTrackerSync` (`Bun.spawnSync`)
in a lazy `useState` initializer, `listSessionSummaries` called in Home's
render body after every rename, and the cold-directory gate re-resolving
the project identity from a passive effect.

## Decision

**Code reachable from React renders, lazy state initializers, or mount-time
effects must never synchronously spawn a subprocess.** Concretely, in
`packages/core` and `packages/tui`:

- No `execFileSync` / `spawnSync` / `Bun.spawnSync` on paths reachable from
  `render()`, `useState(() => …)` initializers, `useMemo` factories, or
  mount passive effects.
- Spawn-based resolution happens **before the first frame** (see
  `renderTui`'s warm-up of `projectSlug` and `resolveTrackerSync`) or in
  continuations after an `await` boundary (outside the commit window).
- Sync-spawning primitives may keep process-lifetime memos when that makes
  later call sites spawn-free (`resolveTrackerSync` memoizes per cwd), but
  a memo is an optimization, not the safety argument — the warm-up is.
- Gates that run in effects (`isColdDirectory`) use filesystem-only probes
  (`SessionStore.listSpawnFree`) instead of identity resolution.

Rationale: the reconciler asserts single-threaded work; a synchronous child
process yields control to Bun's scheduler mid-commit and any scheduled
render continuation re-enters the assertion. The failure is load-dependent,
which is why it survived as "flaky tests" instead of surfacing as a
deterministic bug.

**Testing rule**: the PTY harness fails fast when the TUI child exits with
an unexpected code, and includes the de-ANSIed tail of the child's output —
a crash is never reported as a slow screen.

## Alternatives considered

- **Memoize `canonicalRemoteSlug` per cwd**: rejected. It breaks the
  legitimate mid-process `git remote add` → identity migration (#592) and
  leaks stale slugs for temp directories that appear/disappear under a repo
  (git searches upward for the remote).
- **Make the pin unconditional for the process lifetime**: rejected. It
  silently disables the #592 migration and has no cheap correctness signal
  ("nothing open" ≠ "no data to migrate").
- **Make identity resolution async everywhere**: too invasive; session
  creation is deliberately synchronous (ADR-0005 assembly).

## Consequences

- Extension writers: phase hooks and startup-effect code follow the same
  rule — do the spawn before mount, or defer past an `await`.
- The first resolution of the project identity costs one `git` spawn in
  `renderTui`, before any frame; later resolutions are memo- or pin-served
  while a session is open (#591) and re-spawn only on Home re-mounts with
  nothing open, which is outside the commit window in practice.
- `SessionStore.listSpawnFree` exists as the filesystem-only twin of
  `SessionStore.list` for startup gates; it never resolves the remote
  identity by construction.

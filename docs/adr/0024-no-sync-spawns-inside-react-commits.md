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

## Amendment — 2026-09-24, #939: the invariant moves into the boot

**What #939 found, measured.** The rule above held only as long as every
caller remembered it, and two of its load-bearing claims were false:

- **The warm-up is not a safety argument.** A mount in a process where
  `projectSlug(cwd, home)` had *already* run still performed four
  synchronous identity spawns (measured on the pre-fix tree): the #591 pin is
  released whenever no session file is under it yet, so Home's listing, the
  session assembly's `SessionStore.create`, the prompt composer and the
  handoff artifact all re-resolved — and one of them is reached from `App`'s
  render phase (`projectSessionsDir` ← `SessionStore.create` ←
  `sessionFromConfig` ← `useState`). Production spawned on those paths all
  along.
- **The failure needs pending React work, not a specific call site.** Under
  bun a synchronous spawn runs the event loop inside the call: with any
  queued scheduler task (an earlier keystroke, another root's update) the
  spawn that is *reached* crashes — from a render, from a layout effect, and
  from a **passive** effect alike (`flushPassiveEffects` runs inside
  `CommitContext`). Warming the identity in the same tick does not help
  either: the drain itself yields and re-queues the task.

**The decision.** The invariant is now carried by the *boot*, not by each
call site:

- `prepareProjectIdentity(cwd, home)` resolves the identity **past an
  `await`** (an async `git` probe — a promise continuation is not a React
  execution window) and pins it (`preparedIdentities`), so every later
  resolution — render, effect, `useMemo`, tracker, handoff — is
  memory-served and spawn-free. `isProjectIdentityPrepared` is the
  synchronous test, and `prepareProjectIdentityNow` is the twin for entry
  points that run outside React (`renderTui`, before the first frame).
- `App` mounts its tree **only once the identity is prepared** (the
  `IdentityGate` wrapper in `packages/tui/src/App.tsx`). A plain
  `render(<App/>)` — a test, an embed, a future entry point — can no longer
  make Ink die; a cold mount shows a boot frame for the duration of one
  async `git` probe, a warmed one (the installed TUI) paints its real first
  frame exactly as before.
- `prepareTrackerRemote(cwd)` does the same for the tracker probe, whose
  lazy `useState` was the other synchronous spawn on App's startup path.
- `sessionFromConfig` passes its own `mohHome` to the `PromptComposer`: the
  composer resolves the session-notes slug, and building it from the
  *process* home would re-introduce an unpinned resolution on the render
  path (and disagree with the identity the gate prepared for this session's
  home).

**What the rule now says.** "No synchronous spawn inside a React commit"
remains the standard for new code, but the *safety* is structural: a
resolver that must spawn is prepared at the boot, and a mount site never
carries the invariant. The warm-up in `renderTui` stays as a latency
pre-warm (the first frame does not pay a `git` spawn), not as the argument.

**Documented evidence this closes** (each carried the same failure, or a
workaround obliged by it):

- `packages/core/src/tracker.ts` — the per-cwd memo whose comment cites the
  #595 crash and the missing-executable throw (kept as plain economy).
- `packages/core/src/project-identity.ts` — the "deliberately NOT memoized"
  note that named the TUI warm-up as the safety argument.
- `packages/core/src/handoff-coldstart.ts` — `isColdDirectory` is
  filesystem-only *because* a spawn in a mount-time effect crashed Ink; the
  rule stands, the reason is now the boot rather than the gate's fork.
- `packages/tui/src/file-index.ts` and `packages/tui/src/Home.tsx` — the
  async listing / "not in the render body" notes citing the same crash.
- `packages/tui/test/browser-settings-row.test.tsx` — the hand-rolled
  warm-up at every mount site (removed).
- `packages/tui/test/cold-wizard.test.tsx` — the `projectSlug` mock the
  #595 flake family had grown: nothing to drop, the component never
  resolved an identity.

# ADR-0060: Parallel development lanes use isolated worktrees and explicit relationships

**Status:** accepted · Date: 2026-10-01 · Related: ADR-0055 (orchestration capability), ADR-0023 (session tree)

## Context

A user can start multiple moh sessions for issues belonging to one feature. If those sessions share a project working tree, uncommitted edits, generated files, and test state become intermingled. Physical isolation alone is insufficient: issues in the same feature may be independent, dependent, or intended to be validated together.

moh therefore needs a native model that answers both questions:

1. Which filesystem state belongs to this session?
2. What is this activity's relationship to the other activities in the feature?

## Decision

moh introduces **feature groups** and **lanes**.

A feature group collects related development activities. A lane is one executable activity with a session, a standard Git worktree, and a standard Git branch. Every active lane owns exactly one worktree and branch; active sessions may not share a worktree by accident.

A lane records the exact base revision used at creation, its target ref, and its relationship to other lanes. Relationships are explicit:

- `independent`: same feature group, no branch dependency;
- `depends-on`: the lane is based on a selected parent lane and forms a stack;
- `integration`: an isolated worktree used to validate selected lane refs together.

A feature-group relationship does not imply a Git dependency. moh never infers dependency solely from issue text or shared feature membership.

Lane metadata is user data outside the project repository. The headless core owns lifecycle, policy, and Git operations. TUI and CLI are thin projections. Lifecycle and integration transitions are recorded as append-only chrome events in the owning session log.

The initial implementation uses ordinary Git worktrees and branches. Shared mutable worktrees, synthetic index/branch mechanisms, implicit rebases, and automatic push or pull-request creation are not part of this decision.

## Lifecycle

Creating a lane captures:

- feature-group id;
- lane id;
- owning session id;
- worktree path;
- branch ref;
- base ref and resolved base revision;
- target ref;
- relationship and optional parent lane;
- lifecycle status.

Creating a dependent lane requires an explicit parent lane. Updating or integrating a lane never silently rewrites another lane's base. A lane whose operation encounters a conflict enters a resumable `conflicted` state with source revision, target revision, operation, and worktree metadata retained.

An integration lane is isolated from all child sessions. It is a validation projection, not a shared mutable workspace.

## Authorization

An orchestration that creates child sessions may receive a lane-management capability in its consented envelope. Each spawn request names its lane assignment; the runtime intersects it with the granted envelope. A child cannot widen its path scope, select another lane, or create a lane outside the orchestration's authorization. The core performs the operation and records the result; an extension cannot write lane events directly or bypass permission rules.

## Consequences

### Positive

- Concurrent sessions cannot corrupt one another through shared uncommitted files.
- Related tasks remain visible as one feature group without losing normal Git semantics.
- Stacked work has an explicit topology and exact base revisions.
- Combined validation can happen without giving child sessions a shared mutable directory.
- Lane state can survive process restart and support resumable conflicts.

### Costs

- Multiple worktrees may duplicate dependency installations and generated artifacts.
- A lane graph and integration lifecycle add domain state beyond ordinary branches.
- Dependency relationships require an explicit user or orchestrator decision.
- Core Git operations need platform-aware worktree cleanup and stale-state handling.

## Rejected for now

- Allowing sessions to share one worktree by default: it recreates the motivating failure mode.
- Inferring `depends-on` from issue text: inference can silently produce the wrong branch topology.
- Making feature membership imply dependency: same-feature work is often parallel and independent.
- Storing lane state in the project repository: it pollutes project data and violates the user-data boundary.
- Making clients own lane state: TUI and CLI would diverge and headless orchestration could not participate.

## Amendment: lazy lanes, task labels, stale cleanup (2026-10-01)

Provisioning on every fresh session start created lanes nobody needed —
single-session work paid worktree, branch and registry costs with nothing
to isolate. Three refinements, all without inference:

**Lazy lanes.** The checkout itself is the first workspace. A lane is
provisioned only when parallelism is observable: an active lane already
exists, or the client reports a live sibling session of the same project
(a session file modified in the last 10 minutes — the cross-process
signal; no registry, no questions). The declared trade-off: the first
session is not isolated until a second one appears; isolation protects
sessions born after parallelism emerged.

**Task labels.** The lane records *what* it is working on (the issue id or
task text, from the client's prompt), rendered by `moh lanes list` and
`/lanes` with the lane's age in days. A stale lane is identifiable by its
work, not by a random id.

**Stale cleanup.** `moh lanes cleanup [--apply] [--min-age-days N]`
(default 7, dry run by default): a lane idle past the cutoff whose
worktree has NO uncommitted changes is removed — worktree, branch,
registry row; its committed work lives on the branch until landed. Dirty
lanes are reported, never touched. `/lanes` surfaces the cleanup door.

## Amendment 3: in-modal deletion and `moh lanes delete` (2026-10-04)

A stale lane could only be *abandoned* — the registry row stayed forever,
and the TUI could not delete anything. Three refinements:

**`moh lanes delete <lane-id> [--keep-worktree]`.** The destructive
counterpart of `abandon`: worktree removed, branch deleted, registry row
dropped — nothing left behind. `abandon` stays the reversible lifecycle
step (status `abandoned`, branch deleted, worktree removed, row kept so
the worktree path stays attributed); `delete` is the "forget this lane"
step. Caveats are explicit, not hidden: `git worktree remove --force`
discards uncommitted changes and `branch -D` drops unlanded commits —
committed-but-unlanded work on the branch is lost with the branch.
`--keep-worktree` degenerates to a forced registry-row drop, leaving git
state on disk untouched (for "the filesystem is already gone / handled").

**The `/lanes` modal owns the destructive doors.** `d` deletes the focused
lane (y/N confirm), `x` drops only its registry row, `D` deletes every
lane of every group behind a typed confirmation (`delete all`) that stops
at the first refusal. This amends the "TUI and CLI are thin projections"
stance for exactly these two irreversible operations: they are moments of
user intent, not lifecycle transitions, and routing them through the CLI
added friction without adding safety — the typed confirmation and the
per-lane `y/N` are the safety. Everything else (integrate, resolve,
abandon, status) stays CLI-first.

**Deletion vs the worktree directory, precisely.** Both `abandon` and
`delete` remove the worktree directory via `git worktree remove --force`;
the shared `.moh-lanes/<repo>/` parent and the registry file are never
deleted by lane operations (cleanup prunes rows, never the directory
tree's root). A `delete` on a lane whose worktree is already missing
removes only the branch and the row.

## Amendment 4: worktrees live under `~/.moh/projects/<slug>/lanes/` (2026-10-04)

Lane worktrees originally lived at `<checkout-parent>/.moh-lanes/<repo>/<branch>`:
written **outside** the project, beside the checkout. Three problems: the
write needed permissions outside the project's own tree (sandbox and
convention friction); the location was a positional contract —
`mainCheckoutFor` recognized a lane by walking up to a literal
`.moh-lanes` directory name, so any layout change broke reentry; and the
per-project namespace was the checkout's directory *name*, colliding for
same-named checkouts.

**Decision: the lane worktree root is `<home>/.moh/projects/<slug>/lanes/`**
— beside the project's session store and lane registry, which already
live there. Consequences, stated:

- The slug is resolved with the same identity resolution the session
  store uses (declared identity > git origin > legacy path hash), so a
  worktree path maps back to exactly one project; same-named checkouts
  can no longer collide.
- `mainCheckoutFor` re-anchors on the worktree's `.git` **file** (the
  `gitdir:` pointer `git worktree add` writes — ordinary checkouts have a
  `.git` directory): the pointer's `<checkout>/.git/worktrees/<name>`
  shape names the owning checkout. Position on disk is no longer the
  contract; git's own pointer is.
- `resolveWorktreePath` takes the home explicitly; clients already pass
  one to the service, so nothing new is injected.
- Existing lanes created by the previous layout keep their recorded
  `worktreePath` and keep working (the registry row is the source of
  truth); only *new* lanes land under the home root. A stale
  `.moh-lanes` directory beside an old checkout is inert user data.

## Amendment 5: a lane owns its dependency install (2026-10-09)

The provisioning path symlinked the checkout's `node_modules` into every
fresh worktree (`#shareNodeModules`) — fail-silent, and with no architecture
record. Inside that one shared install bun writes the `@moh/*` workspace
links **relative to the physical install directory** while pointing them at
*the installing lane's* packages; a relative path resolves identically for
every consumer, so one `bun install` inside one lane silently repointed the
checkout and every other lane at that lane's sources. A missing share was
invisible too (a lane with no `node_modules` at all, observed 2026-10-08).
The "Consequences / Positive" line above — *concurrent sessions cannot
corrupt one another through shared uncommitted files* — was therefore false
as written: the shared install was exactly such a channel.

**Decision: no lane shares the checkout's install.** The symlink mechanism
is removed entirely; a lane resolves its own packages, or none. The cost
already accepted above ("multiple worktrees may duplicate dependency
installations") applies as written.

**The install command belongs to the project**, resolved from the lane's
own files in this order — a lane installs what its branch declares:

1. the `lanes.setup` user-config key (`string | false`) — the last word;
   `false` declares that a project has nothing to install (the user's own
   statement: recorded, never reported);
2. `packageManager` in `package.json`;
3. the lockfile table, for ecosystems whose store is the project directory
   (`bun.lock`/`bun.lockb`, `package-lock.json`, `yarn.lock`,
   `pnpm-lock.yaml`, `uv.lock`, `composer.lock`, `mix.lock`, `poetry.lock`,
   `Gemfile.lock`);
4. a user-level store (`Cargo.lock`, `go.sum`, `packages.lock.json`,
   `pom.xml`, `build.gradle`/`.kts`) is not a lane-scoped install —
   nothing to run, nothing to report;
5. nothing recognized **with** a manifest present (`package.json`,
   `pyproject.toml`, …): the lane is created without its own dependencies
   and the reason is visible once. moh never invents a command. No
   manifest at all is silent.

**The install runs at provisioning**, as the last step before the lane is
reported ready — lanes stay lazy, so the cost is paid only once parallelism
already exists. It is **free, not frozen** on the lockfile (a frozen install
fails exactly when a lane is adding a dependency), so it may update the
lane's own lockfile. **Failure creates the lane and is visible**: the lane
exists with no or a partial install, the reason is reported like every other
provisioning result, and the next open retries. A `node_modules` that is not
a real directory the lane owns — the old symlink, foreign links, a missing
store — is replaced by the lane's own install on the next open; the runtime
check refuses to use a foreign store rather than trusting it.

**The registry row records the outcome** (command used, nothing-to-install
with its once-only reason, or failure with its reason) and the lockfile
fingerprint the install was made from — **never a marker file inside the
worktree** (an untracked file there is one `git add -A` away from the #1223
accident class). `lanes.setup` is read where `lanes.auto` is read today
(clients), and passed to the lane service.

**The checkout is never mutated automatically.** A read-only check surfaces
its drift in the lane-facing surfaces (`moh lanes list`, `/lanes`); the
repair runs only on request, through a door shaped like `moh lanes cleanup`
— dry run by default, applying on request — and it states the correct
method (remove the workspace links, then reinstall; a plain install does not
repair a satisfied foreign link).

## Follow-up

Implementation starts with the isolated lane lifecycle, then adds feature-group metadata and explicit relationships, followed by integration and resumable conflict state. A later decision may add a shared-runtime mode only if real workloads demonstrate that isolated worktrees are insufficient.

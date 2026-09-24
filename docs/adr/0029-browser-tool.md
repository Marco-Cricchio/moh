# ADR-0029: browser tool — native headless Chromium driver

Status: accepted · Date: 2026-09-17 · Parent: issue #770 (wayfinder map), feature #769

## Context

moh's only web access is the raw `fetch` tool: it retrieves HTML/text but cannot render
JavaScript, interact with pages, or see pixels. The three use cases the owner ratified for
the browser tool — reading rendered content (SPAs), UI debugging (screenshots vs DOM),
and full automation (click/fill flows) — are all unreachable. Prior art survey and a
dependency research ticket (#771) plus a page-view prototype (#772) settled the design
inputs; the security posture was grilled with the owner (#773).

## Decision

**Go.** A native `browser` tool in the core: one tool, action-dispatched, driving a
headless Chromium via **playwright-core as an optional, lazily-imported dependency**.

Key decisions, each with its rationale:

1. **Native core tool, not MCP.** The browser is a first-class capability, not an external
   service: it rides the standard tool path (schema, `timeoutMs` resolver #300, permission
   gate, tool_result events) with zero new seams.
2. **playwright-core, optional peer; CDP-native rejected.** Stable element refs are the
   make-or-break and Playwright has solved them (in-page expando cache keyed on role+name,
   monotonic ids, stale-ref translation, shadow/slot/iframe coverage). CDP-native would
   trade ~13 MiB of bundle for owning accname computation, ref diffing, hit-target
   verification and OOPIF session management forever — under **unpinned** protocol variance
   (any user Chrome version), versus Playwright's pinned Chrome-for-Testing build.
   Chromium binaries are never bundled: user-level install on demand
   (`bunx playwright-core install chromium`, global cache). Missing toolchain → tool not
   registered with a visible diagnostic, never silent.
3. **View model: a11y-refs only.** The model's sole textual view is
   `ariaSnapshot({ mode: "ai" })` with `[ref=eN]` refs; no `get_html`, no CSS selectors
   from the model. Prototype evidence (#772): refs ~99.8% stable across DOM mutations on
   six real sites; actions resolve via the `aria-ref=eN` selector; raw HTML adds nothing
   where ai-mode works. Screenshots are first-class for the canvas blind spot (excalidraw:
   0.4 KiB of a11y content).
4. **Hard token budget + depth refinement.** Snapshots are budgeted (~20k tokens) with a
   visible truncation marker; `depth` is the refinement lever when the budget trips
   (depth prunes vertically, cost grows horizontally — the hybrid uses each where it
   works). Navigation auto re-snapshots (refs die with the document).
5. **Security posture: tiered permissions, session-scoped trust, loopback-only default.**
   Read tier allow, act tier ask (full element description in the prompt). URL-glob
   argspec (`browser:click https://app.example.com/**`) as a third ADR-0007 semantic.
   "Always for this site" is a session-scoped runtime rule, explicit opt-in only, never
   persisted. Loopback allowed by default (dev debugging is the primary use case); all
   other private/metadata ranges blocked (the prompt-injection SSRF vector). eval_js is
   honest: full page context, ask. Downloads staged, uploads root-anchored.
6. **Opt-in.** `browser.enabled` defaults to **false** — moh's zero-config posture and
   blast radius stay untouched; enabling is a deliberate act.

## Consequences

- ADR-0007 gains the URL-glob argspec semantic (amendment recorded in the spec).
- `@moh/core` exports nothing new beyond the tool's standard registration; config keys
  join `SessionConfig` per ADR-0004 (the tool is a builtin, config a documented surface).
- Missing-Playwright degradation follows the visible-diagnostic rule (like a broken MCP
  server): diagnosed, never silent, never a turn error on session start. The diagnostic
  rides a dedicated `browser_unavailable` chrome event in the event log (an explicit,
  recorded amendment to the spec's "no new chrome events" note: a visible warning in
  every surface is the point, and the log stays the one projection).
- Spec: the spec lives at `docs/spec/browser-tool.md` (local-only per repo policy —
  `docs/spec/` is gitignored planning space; the spec text is preserved in the
  wayfinder map #770's resolution trail). The ADR summarizes every normative decision;
  the implementation PRs are the source of truth for fine detail. Manual page updates
  ship with the implementation PRs.

## Amendment — 2026-09-23, #935: the toolchain is moh-managed

Decision 2 assumed the user installs the toolchain themselves
(`bunx playwright-core install chromium`, global cache). That assumption
was wrong for the artifact moh actually ships: a compiled Bun binary
cannot resolve a package installed by `npm i -g` unless the environment
happens to expose it through `NODE_PATH`, so "install it yourself" was a
broken contract for the audience that has no npm and no system Bun. The
core now owns one browser-toolchain seam
(`core/src/browser-toolchain.ts`, ADR-0004 amendment) that both clients
consume.

- **Resolution** — the project's own installation first (the nearest
  `node_modules` walking up from the project root, so a hoisted workspace
  install still counts), then the user-owned
  `<home>/.moh/browser-toolchain/node_modules`. Existence-gated absolute
  paths only, never a lookup: `require("playwright-core")` with no local
  install answers from Bun's global install cache, so a compiled binary
  could silently load a copy nobody installed for it. Nothing is resolved
  through `NODE_PATH` or a global npm root.
- **Ownership split** — the package lives in the moh-owned root; Chromium
  stays in Playwright's normal per-user cache, so the OS-specific
  canonical location and `XDG_CACHE_HOME` behavior remain Playwright's.
  moh invents no cache path and detects no platform.
- **Compatibility policy** — "latest compatible" is `playwright-core@latest`,
  recorded in the install result so a client can show what it got. moh
  drives Playwright's stable public surface (persistent-context launch, the
  a11y snapshot, `aria-ref` addressing), and Playwright ships each release
  with the browser revisions it expects — so the version and the builds
  cannot drift apart as long as they come from the same install.
- **Setup** — headless-first: the Chromium *headless shell* (~200 MB) is
  what a `headless: true` launch actually needs (Playwright resolves
  `chromium-headless-shell` for it), and the pre-#935 probe could not tell
  the two builds apart — it checked only the full build, so an enabled
  tool could be registered on a machine where every headless launch would
  fail. The probe now reads Playwright's own registry (its declared
  `lib/coreBundle` export) for both paths and versions, and falls back to
  the public `executablePath()` if that shape ever moves: a *probe* must
  never block a toolchain that would work. The full Chromium build (~500 MB, headful) and
  Playwright's system dependencies (`install-deps`, which may ask for the
  system administrator password) are explicit options. No sudo, no system
  packages, no npm: `BUN_BE_BUN=1` makes the compiled moh binary behave as
  the Bun CLI it embeds.
- **Safety** — installation is staged beside the root and promoted by one
  atomic rename of a symlink over the previous one, under the shared
  content-based lock (`memory-lock.ts`, #399). The canonical root path is
  therefore never absent — not even for the instant between two renames —
  so a failed, interrupted, or killed install leaves a previously working
  toolchain exactly as it was, and a concurrent moh process is refused
  (and told to retry) instead of raced. The lock's staleness is decided by
  ownership (machine, boot, pid), never by age: a 500 MB download on a
  slow line is a live install, not an abandoned one. The browser cache
  itself stays Playwright's: a build left half-downloaded there is
  re-fetched by the next install, and moh neither inspects nor repairs it.

Unchanged: opt-in activation (`browser.enabled` defaults to false), the
security posture of decisions 3–5, the lazy-loading of the browser
session, and the missing-toolchain rule — diagnosed in every surface,
never a turn error and never a session failure. The client surfaces that
project this seam (Settings setup, #934; transcript and CLI diagnostics,
#936) render and ask; they never probe or resolve on their own.

## Amendment — 2026-09-23, #936: the diagnostic is visible, and it has a door

Decision 6's diagnostic existed but was invisible: the TUI dropped the
event and `moh run` printed nothing, so an enabled-but-unavailable browser
tool looked like a tool that simply never ran. Two consequences, both
decided here:

- **The diagnostic is rendered, not consumed.** The TUI projects
  `browser_unavailable` as a warning block (the core's own reason sentence
  plus the TUI action) and states the present with a footer alarm — the
  alarm reads the diagnostic of the *current open* (after the last
  `session_start`/`session_resumed`), so a session resumed after the
  toolchain was installed does not keep offering setup, while the log keeps
  every diagnostic as history. `moh run` prints one line on stderr.
  Unchanged: chrome only — never provider context, never a turn error,
  never a permission rule, and stdout stays pure JSONL in headless runs.
- **The action is one flow, and it has a CLI door.** The TUI's `install
  now` (ctrl+b, `/browser`) opens the guided setup modal — the surface
  #934's Settings Browser row is meant to open as well, built here because
  the transcript must not grow a second installer path, and because #934
  is not a dependency of #936. And because the core's
  own hint (`BROWSER_SETUP_HINT`, #935) and the manual already named `moh
  browser install`, the CLI gained `moh browser status|install`: a thin
  client that renders the probe, decides which optional pieces to fetch
  (the full build and the system dependencies stay explicit) and calls the
  installer. #934 declared a separate CLI browser command out of its scope
  and left headless setup/status to #935+#936; this is that door.

## Amendment — 2026-09-24, #934: activation is configured from Settings

Decision 6 made the browser opt-in; #935 made the toolchain moh-owned; #936
made the missing toolchain visible. What was still missing is the door the
user actually walks through: turning the tool **on** meant editing
`browser.enabled` in `moh.json` by hand, and the toolchain had one flow
(the transcript warning) that only appeared *after* a session had already
failed to register the tool. This amendment adds the Settings row and
settles the three questions it forces.

- **Activation stays per project; the toolchain stays user-level.** The
  Settings row writes `browser.enabled` into *that project's* `moh.json` —
  project A can have the tool while project B does not — while
  `playwright-core` and the Chromium builds live once under
  `~/.moh/browser-toolchain` (and Playwright's own cache). The row states
  both halves (`off (this project) · toolchain ready`), because they answer
  different questions and a single "browser: off" would hide which one is
  the obstacle. The project file is written the way the rest of the panel
  writes it (`loadMohConfig` + `writeMohConfig`, read-modify-write), so
  unrelated keys survive; a file that does not validate is reported and
  never rewritten blind — the row says `moh.json is invalid — fix the file`
  rather than claiming the default it never managed to read. `enabled` is
  always written (a deliberate off must be durable, not the absence of a
  key); the two optional shapes follow the defaults: `headless: false` only
  when headful is chosen, `allowedHosts` only when non-empty.
- **One modal, three planes.** The Settings row opens the *same*
  `BrowserSetupModal` that the transcript warning's `install now`,
  `/browser` and ctrl+b already open (built in #936 with this row in
  mind): the TUI does not grow a second installer path, nor a second place
  that decides what the three keys mean. The modal separates what is
  separate — the **project** setting, the **user-level** toolchain (with
  the headless shell as the plan's floor, the full build and the system
  dependencies explicit, and headful-without-the-full-build stated before
  a 500 MB download starts), and the **effect** — and reports what it did
  exactly once, through a single `onDone` outcome. Two exit behaviours,
  deliberately different: a successful install closes the modal by itself
  (the download is over; the next act is to use the browser), while a pure
  setting change waits for esc, so several toggles cost one re-assembly
  instead of one each.
- **The effect is the session's, and the client's to apply.** The tool is
  registered — and `headless` read — when a session is *assembled*, so no
  setting change can matter to the running one on its own. A change made
  with a session open re-assembles it (the same `/reload` path, carrying
  the modal's own sentence in the toast); a change made from Home applies
  to the next session, and the modal says which of the two it is showing.
  Opened from Settings, the modal returns to Settings — remounted, so the
  row states what was just written; opened from the warning, it returns to
  the chat.

Unchanged: `browser.enabled` defaults to false, decisions 3–5's security
posture (the allowed-host list is the same exact-host escape hatch, now
editable where the tool is turned on), the missing-toolchain rule, the
per-project/per-user split of decision 6 and the #935 amendment, and the
clients' rule that they render and ask while the core probes and installs.

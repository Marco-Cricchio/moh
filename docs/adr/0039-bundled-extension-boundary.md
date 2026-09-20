# ADR-0039: the bundled-extension boundary — the core hosts, the client mounts

Status: accepted · Date: 2026-09-19 · Parent: issue #826 (follows #834)

## Context

Issue #826 recorded that `@moh/core` had a build-time dependency on the bundled vendor
package (`"@moh/jev-guard": "workspace:*"`), imported and called the vendor's factory
inside `sessionFromConfig`, and — the sharpest form of the coupling — read two
*vendor-defined* `state` keys (`"mpmGate"`, `"rerank"`) and wired them into
`mpm.turnGate` / `mpm.rerank`. That was recorded as a deviation from a ratified decision:
the infra spec §3 and the grilling decision Q1 both said *"`@moh/core` keeps no Jev code
and no Jev knowledge"*.

The investigation that preceded this ADR found the requirement was inverted: the core was
not wired to Jev because someone chose to; it was wired that way because **no client
loaded extensions at all**. `moh.json "extensions"` was declared and documented but read
by nobody, and `ExtensionRuntime.registerFile()` had no client caller. Jev was the only
extension moh had ever loaded, through a private door, because there was no public one.

The repo's own rule applies: a change that departs from a ratified decision needs an
explicit ADR saying why. #834 built the missing public door (a declared source, the
content-bound consent, headless fail-closed). This ADR records the boundary that the
inversion restored. The one residue of the first cut — the core asking a vendor predicate
over the user's config — was removed in a follow-up the same week (see "Deviation,
eliminated" below).

## Decision

**Go.** The core hosts bundled extensions; it does not know any of them.

```ts
// @moh/core — the whole contract
export interface BundledExtensionSource {
  readonly name: string;
  evaluateActive?(readConfig: (file: string) => string, configFile: string): boolean;
  activate(context: BundledActivationContext): unknown;
  wire?(read: BundledInstanceReader, wiring: BundledWiring): void;
}
/** A source plus the client's activation answer. */
export interface MountedBundledExtension { source: BundledExtensionSource; active: boolean }
// SessionFromConfigOptions
bundledExtensions?: readonly MountedBundledExtension[];
```

The vendor package (`@moh/jev-guard`) exports `jevBundledSource` and owns its config
surface (`typesafe.ts` moved there). Clients mount the sources through one list
(`packages/tui/src/bundled-extensions.ts`), consumed by the TUI factory and the CLI's
`run`/`serve`/`compact`.

Key decisions, each with its rationale:

1. **Two doors, two trust postures.** File sources (#834) are arbitrary code the user
   declared, gated by the content-bound consent. Bundled sources are code the host
   shipped, registered with `{ bundled: true }` — consent and dependency authorization do
   not apply, because consent is a question about the user's *disk* and there is no user
   file involved. A bundled extension is never editable, so it is never a path the user
   could tamper with; making it a file on disk would create exactly the consent and path
   problems `{ bundled: true }` exists to avoid (and a future extension gallery will
   produce *files*, which #834 already loads).

2. **Activation is the client's answer.** `evaluateActive` (the vendor's own, effect-free)
   receives the path and a reader; the **client** calls it and mounts
   `{ source, active }`. The core consumes the boolean and never runs a predicate over the
   user's config. This is what replaced the core's knowledge of `typesafe.apiKey`.

3. **The wiring step keeps the core's capabilities generic.** `wire` fills named slots
   (`turnGate`, `rerank`) whose signatures the core owns. The core does the plumbing —
   locate the instance by name, guard the shape — and the extension supplies the key and
   the meaning. `wire` receives a **lazy instance reader**, not a snapshot: registration
   is fire-and-forget (the session awaits `ready()` before its first turn), so at wiring
   time the instance does not exist yet. The reader is called when the capability is
   *used*. A test caught this; the contract now says it.

4. **A malformed vendor config never fails an assembly.** The pre-inversion code returned
   `assemblyError("config")` on a broken `typesafe` block. With the block owned by the
   extension, a broken optional config is the extension's business: the descriptor
   reports "not active" and the session proceeds. The loud error moves to the surface
   that reports it (`moh jev status` exits 2).

5. **An inactive extension describes itself.** The pre-inversion assembly pushed the
   literal line `jev: inactive (no api key)` from the core. The generic core cannot write
   it — it does not know that a missing API key is what "inactive" means — so the source
   contract carries `inactiveNote?()`: the extension supplies its own words for the log,
   or nothing. This follows the same rule as the offline chip's text (ADR-0032): the core
   owns the slot, the extension owns the sentence, and the manual's documented line stays
   true.

6. **The manual page stays in the core — a deliberate deviation from #826, which
   listed it.** The issue listed `core/src/manual/jev.md` among the couplings to remove,
   and `manual.ts`'s static import plus the `gen-manual-docs.ts` entry with it. The page
   was evaluated against the same criterion as the code and did not meet it: it is
   *platform content*, describing an optional integration for the user (`ctrl+h`,
   `moh manual jev`), naming no core API, no core type and no core symbol. #834 put
   `manual/extensions.md` in the core on exactly that basis, and moh has no mechanism for
   an extension to contribute a manual page — building one to relocate a single file
   would be scope the issue did not ask for. The deviation is recorded here rather than
   silently dropped, and the option stays open: if moh ever grows contributed pages, the
   Jev page moves then, with the import and generator entry it needs.

## Deviation, eliminated (2026-09-20)

The inversion recorded above left one residue: **the core read a boolean from the
extension's config.** `isActive(readConfig, configFile)` meant `sessionFromConfig` called a
predicate — implemented by the vendor — that read `~/.moh/config`. The core knew no key and
no schema, but it did ask the question, and its assembly depended on a function whose body
lives in the vendor package.

It was removed rather than accepted. The insight that made it cheap: **the client already
owns that config surface** — the TUI ships the Settings entry that writes the key — and all
four mount points (the TUI factory, `run`, `serve`, `compact`) already go through a single
list. So the answer moved one layer out, where the knowledge already was:

```ts
interface MountedBundledExtension { source: BundledExtensionSource; active: boolean }
```

The client reads the config it owns, asks the descriptor (`evaluateActive`, still the
vendor's own code and still effect-free), and mounts the source with the answer. The core
consumes a boolean: it no longer runs an extension-provided predicate, and it reads no
config on an extension's behalf. The activation model the owner ratified is untouched — the
API key is still the switch, still one gesture, still readable at assembly time; only *who
evaluates* it changed. Also gone with it: `resolveBundledExtensions` no longer takes a
`readConfig` seam at all.

Confirmed clean, and untouched by this deviation: the core imports no vendor package, its
public surface (`@moh/core`) exports no vendor configuration (the 16 `typesafe` symbols
moved to the vendor), it names no vendor in its code, and the eight generic extension
seams (ADR-0031→0038) remain moh capabilities that survive the vendor disappearing.

## Consequences

- `packages/core/src/bundled-extensions.ts` (new): the descriptor contract and
  `resolveBundledExtensions`.
- `packages/core/src/session/from-config.ts`: `bundledExtensions` option; the vendor
  import, the factory call and the two `state` reads are gone.
- `packages/jev-guard/src/integration.ts` (new) and `packages/jev-guard/src/typesafe.ts`
  (moved from the core): the vendor owns its activation, its factory arguments and the
  two capability keys.
- `packages/tui/src/bundled-extensions.ts` (new): the first-party source list both
  clients mount.
- `packages/core/package.json`: the `@moh/jev-guard` dependency is removed. A library
  user embedding the core assembles a session with no bundled extension unless they
  mount one — the isolation #826 asked for, now the default.
- Tests: the vendor's config block and activation path in
  `packages/jev-guard/test/integration.test.ts`; the generic seam, with a synthetic
  descriptor, in `packages/core/test/bundled-extensions.test.ts`.
- Rejected: a fixed key→extension mapping inside the core (it would keep a vendor name in
  the core, the exact coupling recorded here); a required declaration key in the user
  config (a second gesture for the user, and the ratified model is one); teaching the core
  to read `typesafe` generically via a generic config schema (the core would own a vendor
  block's grammar).

## Amendment (2026-09-20): the consent precedes the import

Found while reviewing the release candidate, and fixed in the same change: the #834 door
evaluated a file **before** asking about it. `#registerFileNow` imported the module (which
runs it) and only then resolved the consent inside `#instantiate` — so a declined file, and
above all a *never-asked* one (every headless run, and any `moh.json` declaration in a
cloned repository), executed its top-level code while the session reported
`extension_failed { reason: "consent" }`. Verified by probe, both paths.

The invariant this ADR's #834 half claims — "a cloned repository cannot run code on your
machine" — therefore held for *registration* but not for *execution*, which is the part
that matters.

The fix moves the question to where the identity is computable without running anything:
the content identity (resolved path + SHA-256, a `readFileSync`) is derived first, the
stored grant or the consent seam is consulted, and only a granted file is imported. The
same correction applies to the hot-reload path (an edited file was imported before its
re-ask). The identity is re-derived inside `#instantiate`, so a file swapped between the
ask and the import is caught rather than trusted.

Consequence for the contract: `ExtensionRuntimeOptions.consent` now takes an
`ExtensionConsentRequest` instead of positional `(name, version, file)`, and
`ExtensionConsentRequest` carries the file and its `hash`, with `name`/`version` optional —
they are the module's self-declared claims, which do not exist at ask time on a first load
and are not the trusted part in any case. `#834`'s trust model is unchanged in every other
respect: content-bound consent, the persisted grant, `bundled` skipping it, headless
failing closed.

Regression coverage: `packages/core/test/extensions.test.ts` ("consent precedes
execution") asserts that a declined file, a headless file and an edited file are never
imported — the probe is a top-level side effect, since a `setup()` side effect would be
gated by registration and would hide exactly this bug.

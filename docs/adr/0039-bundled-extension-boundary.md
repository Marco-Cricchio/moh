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
inversion restored, and the one residue it did not remove.

## Decision

**Go.** The core hosts bundled extensions; it does not know any of them.

```ts
// @moh/core — the whole contract
export interface BundledExtensionSource {
  readonly name: string;
  isActive(readConfig: (file: string) => string, configFile: string): boolean;
  activate(context: BundledActivationContext): unknown;
  wire?(read: BundledInstanceReader, wiring: BundledWiring): void;
}
// SessionFromConfigOptions
bundledExtensions?: readonly BundledExtensionSource[];
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

2. **Activation is a predicate over an injected reader.** `isActive` receives the path
   and a reader; the descriptor itself calls nothing. The core reads the *shape* "should
   this run?" and never the semantics. This is what replaced the core's knowledge of
   `typesafe.apiKey`.

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

5. **The manual page stays in the core — a deliberate deviation from #826, which
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

## Deviation that remains

Not eliminated, and recorded explicitly: **the core still reads a boolean from the
extension's config.** `isActive(readConfig, configFile)` means `sessionFromConfig` calls
a predicate that reads `~/.moh/config`. The core does not know the key, the schema, or
the meaning — but it does know that a bundled extension may have a say in whether it
runs.

That residue is the price of the activation model the owner ratified: the API key in the
Settings entry *is* the switch, and the switch must be readable at assembly time, before
any client seam could supply an extension-provided value. A second requirement in the
same direction was accepted rather than designed away: activation must stay **one user
gesture** (paste the key → Jev is active), so no separate declaration key was introduced.

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

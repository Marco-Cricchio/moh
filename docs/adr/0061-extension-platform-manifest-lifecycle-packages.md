# ADR-0061: Extension platform — manifest declaration, authoritative lifecycle, package registry, client surfaces

Status: accepted · Date: 2026-10-02 · Issue: #1000 · Amended: ADR-0062 (extension UI contributions — the read-only client v1 below is superseded) · Related: ADR-0031 (restrict-only), ADR-0039 (bundled source), ADR-0053 (capability slots), ADR-0054 (prompt section replacement), ADR-0055 (orchestration), ADR-0056 (hook ceilings)

## Context

#998 settled what capabilities are and how they are consented; ADR-0054/0055/0056 settled prompt replacement, orchestration and hook ceilings. What remained open was the architecture that carries them: where the consent reads the capability declaration from, which lifecycle contract wins (three versions coexisted in #996, #998 and the runtime), how the 5 s replacement window composes with the 30 s hook ceiling, how packages are distributed, and how much of the client surface opens in v1.

**Declaration before execution.** ADR-0053 placed `capabilities` on `defineExtension`, inside the consented bytes. But consent must be decidable *without executing* the artifact: today consent precedes import, so declined code never runs even at top level. Reading the default export after import would execute unconsented top-level code and weaken that boundary. We amend ADR-0053: capabilities, version and entry point are declared in a **static manifest** (`moh.extension.json` next to the entry point). Consent reads and signs the manifest (path + SHA-256 of manifest and code); at import the runtime verifies the code's declared capabilities are a **subset** of the manifest's — a capability used but not declared is a loud refusal, not a crash. Nothing is executed to decide consent.

**Lifecycle.** Three contracts coexisted: #996 promised optional trusted auto-updates and dev hot-reload without re-consent; #998 chose no auto-update, per-byte identity, watch-without-mid-session-re-ask; the runtime re-asked on changed bytes and could swap the live instance. The authoritative contract is **#998**, and #996's body is amended accordingly (as its mandatory-checks bullet already was): an update is an edit, an edit is a new hash and a new question; the dev watch *notices* the change but the previous instance serves until restart or `/reload`; there is no auto-update, ever.

**Deadline composition.** The replacement of a prompt section rides the return value of `beforeModelCall` (ADR-0054: 5 s window), while ADR-0056 gives every turn-path hook a configurable 30 s ceiling. Two clocks, two roles: the **30 s ceiling covers the whole hook**; the **5 s window applies only to the replacement contribution** — a return past 5 s yields the core's own text for that section with the visible record ADR-0054 already requires, while the hook's other work (observation, status) continues to the ceiling. Expired or thrown, the hook contributes nothing, per ADR-0056.

**Packages and registry.** A package is a directory with a manifest; distribution in v1 is real: `moh extension add` installs from exactly two immutable sources — **npm scoped** (`@moh-ext/*`) and **GitHub releases** (repo + tag) — because the consent binds to the SHA-256 of what was installed, and only an immutable source makes that binding meaningful. Raw URLs and tarballs are excluded for the same reason. `add` performs static checks only: manifest present and well-formed, checksum verified (npm integrity / release SHA-256), unknown capability slots are a **warning** not a refusal (the slot vocabulary grows), declared npm dependencies noted. **Installation never authorizes**: the capability consent happens at load, always. When the same package identity is installed in multiple source paths, the existing discovery rule decides — project wins over user dotdir — and the ignored copy is reported as one visible line in `/extensions`, not a blocking error.

**Client surfaces.** v1 is read-only: the `/extensions` screen (enabled extensions, version, source path, declared capabilities and scopes, sections in force and their authors, last failure with reason) and the orchestration stop control, both from #999. Extension-contributed commands and TUI panels are **out of scope for v1** — the resumption note lives in `docs/vision/` — because a client contribution contract is the largest public door in this design and deserves its own ADR when a real use case arrives.

## Consequences

- `defineExtension` keeps `capabilities` in code, but the manifest is the authority the consent signs; code ⊄ manifest is a loud refusal at load. Existing bundled extensions (in-repo, ADR-0039) gain manifests without behavioral change.
- No migration burden outside the repo: no third-party extensions depend on the old code-only declaration yet.
- ADR-0054's 5 s and ADR-0056's 30 s both stand unamended; this ADR only fixes their composition.
- The registry adds one CLI surface (`moh extension add`, and `list`/`remove` follow the same seam) and a verify step that never executes package code.
- The hook ceiling's config key and the exact `subagent_spawn` requester/envelope field shapes remain implementation decisions for the spec derived from this ADR (#1000).

## Considered Options

- Parsing `defineExtension` out of the source statically: no extra file, but wrappers, renames and generated code hide capabilities from the parse.
- Import-in-a-stub sandbox to capture metadata: faithful to the code, but it executes unconsented top-level code — precisely what the pre-import boundary forbids.
- Trusted-directory auto-update (#996's original promise): rejected — a permanent trust escalation would let today's code authorize tomorrow's without a question.
- Unknown capability slot = hard refusal at `add`: more severe, but it makes every runtime-behind-extension upgrade a hard stop; a warning keeps the vocabulary extensible while the load-time consent still decides.
- Blocking error on duplicate package identity: turned an ordinary overlap (shared + local copy) into a failure; discovery precedence with a visible line is enough.

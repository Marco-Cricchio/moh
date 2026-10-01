# Extension capability slots and absolute prohibitions

Extensions today are restrict-only (ADR-0031/0032): they can veto, ask, observe — but #998 needs extensions with broad powers (e.g. spawning subagents) without letting them self-grant authority. We decided that any power beyond restrict-only is a named **capability slot** the extension declares in its own code (`capabilities` on `defineExtension`, inside the consented bytes) and the user grants as part of the single enable-consent answer — one package-level consent, deliberately low-friction, still bound to path + SHA-256. Enforcement is by absence: without a grant the capability's API does not exist on the extension's context at all, so an ungranted power cannot even be attempted. Because the single-consent answer is coarse, two backstops accompany it: the core enforces a short list of **absolute prohibitions** in code, not configuration (grant or alter permissions/capabilities; read or write `extensions.json` or consent files; disable another extension; bypass another extension's veto; mask or alter log events — no consent can ever authorize these), and the client announces at startup which capabilities each enabled extension holds. A changed file re-asks with the capability diff shown in the question; per-byte consent remains the whole boundary.

## Consequences

- Delegation is a capability: `spawn-subagent` lets an extension spawn child sessions configurable only within what the user consented (no escalation), capped at 10 per extension per session; exceeding the cap fails loudly (`extension_failed`), never silently. `requestTurn` (ADR-0037) stays the core-mediated synthetic turn.
- Revocation takes effect at the next session; a live session keeps its powers.
- No automatic update mechanism, deliberately: an update is an edit, and an edit is a new hash and a new question. Development uses the existing watch flow: an edit during a watched session does not re-ask mid-session — the previous instance keeps serving until restart.
- Headless inherits existing consent from `extensions.json`; unconsented extensions stay fail-closed as in #834.

## Considered Options

- Per-capability independent consent: finer-grained but too much friction for the typical one-extension-one-power case.
- Hash-only widening check vs. separate manifest diff check: chose diff *in* the consent question — with per-byte identity a manifest cannot grow on an unchanged file, so a separate check is dead weight.
- A permanently trusted dev directory: rejected — any file placed there would execute silently; the per-hash boundary plus watch-without-re-ask gives the same fluidity without the hole.

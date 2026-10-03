# ADR-0063: The development-watch lifecycle is the shipped one — re-ask on changed bytes, swap the live instance

Status: accepted · Date: 2026-10-03 · Issue: #998, #1000 · Amends: ADR-0053 (development watch), ADR-0061 (lifecycle) · Related: ADR-0053 (per-byte consent), #834 (consent precedes import)

## Context

Three documents described the development-watch lifecycle identically, and the shipped code did something else.

**The stated contract** (ADR-0053 and, following it, ADR-0061): "an edit during a watched session does not re-ask mid-session — the previous instance keeps serving until restart"; "an edit during a watched session does not re-ask mid-session — the previous instance keeps serving until restart. Development uses the existing watch flow"; ADR-0061 restated it as "the dev watch *notices* the change but the previous instance serves until restart or `/reload`".

**The shipped contract** (packages/core/src/extensions.ts, `#hotReload`): a watched file that changes re-reads its manifest, **re-asks consent** when the bytes differ, and on a grant **replaces the live instance in place**, seeding the previous `ctx.state` into the fresh `setup()`. Any refusal — declined consent, a missing or malformed manifest, an import failure, a capability superset — keeps the previous instance serving and records `reload_failed` on both channels (the log event and the host's warning line). A panel-capacity test pins the swap across a hot-reload (#1132).

Found by verification against `develop` after the #1000 series merged: code and the authoring documentation (`docs/extending/extensions.md`) agree with each other, and **the two ADRs were the outlier**. The divergence was never a bug report — it was two contracts written at different times, one of them never implemented, and the shipped one is the safer of the two.

## Decision

**The shipped lifecycle is authoritative.** Amending ADR-0053 and ADR-0061:

- A watched file that changes is **re-consented before it is imported**, mid-session. The per-byte boundary of ADR-0053 and the pre-import boundary of #834 both hold: an edit the user has not answered for never runs, not even its top-level code.
- On a grant, the live instance is **replaced in place**, with the previous `ctx.state` seeded into the fresh `setup()`. This is what makes a development loop usable without a restart, and it is what the tests pin.
- On any refusal or failure the **previous instance keeps serving**, and the reason is visible on both channels (`reload_failed` in the log, plus the host's warning line where it has one). A reload that silently kept the old instance would let an edited file look applied; it does not.
- The **no-auto-update** rule of ADR-0053/0061 is untouched and stays authoritative: nothing re-consents on its own, and an install-time update is still "an edit, a new hash, a new question". What changes is only *when* a watched edit is asked about — at the edit, mid-session, rather than never until restart.

ADR-0053's rationale for the old behaviour — a permanently trusted dev directory is a hole, so the stored-hash boundary plus "watch without re-ask" buys fluidity without the hole — was the right instinct about the hole and the wrong conclusion about the fluidity. The hole is already closed by the re-ask: the boundary is per byte and consent precedes import, so an edit cannot execute unasked. The intended fluidity ("developer edits, keeps working") is delivered by the in-place swap, which the old contract forbade outright.

## Consequences

- ADR-0053's "does not re-ask mid-session", "previous instance keeps serving until restart" and "watch-without-re-ask" are corrected by the amendment header; ADR-0061's lifecycle paragraph likewise.
- `docs/extending/extensions.md` already documents the shipped behaviour and needs no change — it was the authority all along.
- The development-trust question #998 raised ("the owner may authorize a specific development folder whose edits hot-reload without repeated code consent") stays **unimplemented and undecided**: this ADR does not add a trusted folder, it only states which of the two written contracts the shipped one is. A trusted-folder mode would still need its own decision, and it would still have to preserve the pre-import boundary.
- No code change follows from this ADR: it makes the documents describe what runs. A future change that moves the lifecycle in the other direction is a new decision, not a reading of these two.

## Considered Options

- **Make the ADRs authoritative and change the code** (drop the mid-session re-ask, keep the previous instance until restart): rejected. It weakens the development loop for no security gain — the pre-import boundary already prevents unconsented execution — and it would contradict both the shipped tests and the authoring documentation.
- **Leave the divergence unrecorded**: rejected. Two ADRs stating a contract the code does not implement is how a "silent behaviour" is born: the next reader trusts the ADR and finds the opposite, exactly as this investigation did.

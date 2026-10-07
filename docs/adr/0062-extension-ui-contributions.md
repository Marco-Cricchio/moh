# ADR-0062: Extension UI contributions — commands, panels, overlays

Status: accepted · Date: 2026-10-02 · Issue: #1000 · Amends: ADR-0061 (client surfaces) · Related: ADR-0053 (capability slots), ADR-0054 (one author per section), ADR-0055 (orchestration), ADR-0061 (extension platform)

## Context

ADR-0061 scoped client surfaces v1 to read-only (`/extensions` + orchestration stop) and explicitly deferred extension-contributed commands and UI, waiting for a real use case. The owner has now decided to bring that contract forward, with the expressiveness goal stated up front: come as close as possible to letting an extension customize the interface. The design question was how much of the Claude-Mods-style surface (slash commands, rendered panels, interactive components, and the onion model's ability to wrap native UI) moh should adopt without giving up its own commitments: authority from consent, never from position; collision is a loud refusal, never silent nesting; the log reconstructs what is in force.

## Decision

**Four capability slots** (declared in the ADR-0061 manifest, named in the consent question, enforced by absence — without a grant the registration API does not exist on the extension's context):

- `contribute-commands` — the extension registers slash commands (`/<name>`) executable like native commands.
- `contribute-panels` — one panel in the extensions rail: arbitrary Ink rendering owned by the extension, with a declared max-height.
- `contribute-overlays` — a full-screen mode opened by the extension's command and closed with `Esc`; while open, it owns the screen like any modal.

**Composition: dedicated area, never wrapping.** Extensions do not touch native components, props, or each other's output. The rail is an optional zone — closed by default (the UI is byte-identical to today for anyone who does not use extensions), toggled by the user, collapsing to the footer on narrow terminals. A panel that needs more space than the rail allows is an overlay, not a bigger panel. This keeps the two properties the owner probed directly: deactivating or uninstalling an extension removes its zone and nothing else — no chain to re-link; and a moh update that redesigns its own UI never breaks an extension, because the contract is the zone and a channel, not internal component structure.

**Interaction is real but never a second authorization path.** Panels may carry buttons and interactive elements with callbacks into the extension. A click that would trigger a permission-gated action (tools, file writes, anything the permission gate covers) always flows through the existing gate — the same ask/veto/denial as any extension-initiated action, recorded in the log. The click invokes; it never grants.

**Capacity is explicit, not automatic.** At most 4 panels visible; a fifth extension asking for a panel is refused visibly at load (`panel slot exhausted (4/4) — disable a panel in /extensions`). Collapsing and reopening panels is manual, from `/extensions`. No LRU, no hidden priority: an automatic eviction policy would reintroduce authority-by-position through the back door.

**Name collisions**: native commands > skills > extension commands; a colliding extension command is refused visibly and reported in `/extensions` — the same shape as a contested prompt section (ADR-0054).

**Headless/CLI**: commands degrade to real headless invocation (same action, text/JSON output — prior art: `moh jev status`); panels and overlays contribute nothing — visible absence in `/extensions`, never a simulated textual rendering. No second, non-design behavior is invented where no surface exists.

**Registration is recorded**: `/extensions` lists each extension's commands, panels and overlays, plus refused registrations with their reason, so the UI surface is inspectable like everything else.

## Consequences

- ADR-0061's "client v1 read-only" remains historically true and gains an amendment pointer to this ADR; the vision note that deferred this contract is superseded.
- The TUI overlay union gains extension overlay entries; the extensions rail is a new TUI zone. Both are client-owned; the core exposes only registration and capability enforcement.
- The consent question for an extension declaring any of these slots names them explicitly; adding `contribute-overlays` to an extension that had only `contribute-panels` is a visible widening.
- The interaction-through-gate rule is the security-critical property: the implementation must make the gated path the *only* path from a UI callback to a permission-gated action, and tests must pin it.
- Deferred, not decided here: focus management between the permission modal and extension overlays competing for input, and whether extension overlays may nest. When a real case arrives, it gets its own decision.

## Amendment (#1225, apiVersion 1.17): the focused-key seam

The team panel (#1225) is the real case the panel-key question waited
for: a roster whose members a user selects and opens inside the panel.
The decision stays inside this ADR's commitments — the client owns the
rail, the extension answers within it. `ExtensionPanel` gains an
optional `onKey(input, key): boolean`: while the rail holds focus
(`ctrl+p`), the client forwards the keys it does not consume itself —
`esc` and `tab` always stay the client's, `j`/`k` and the arrows keep
scrolling the panel's window — and a consumed key (`true`) costs one
re-render. Outside focus mode a panel receives nothing; a panel without
`onKey` is unchanged and purely read-only. Overlays keep their own
`Esc`-owned modal focus; the modal-vs-overlay focus question above stays
deferred.

## Amendment (#1226, apiVersion 1.18): the scroll keys compose

The team steering draft (#1226) is the case the 1.17 precedence waited
for: a panel that composes text must be able to consume `j`/`k` — a
message with a letter in it is not a scroll request. The fallback order
flips; the ownership rule holds. While the rail holds focus the client
hands each key to the focused panel's `onKey` first and scrolls only
what the panel ignores; `esc` and `tab` never reach the panel. A panel
without `onKey` sees no difference: its `j`/`k` still scroll, exactly
as before.

## Considered Options

- **Onion wrapping of native components** (the Claude-Mods `ui.render` model): maximum expressiveness — badges inside the status line, redecorated transcript — but it couples the extension to moh's internal component structure (every moh update potentially breaking), makes deactivation a chain re-linking problem, reintroduces authority by registration position, makes the UI non-reconstructible, and contradicts one-author-per-section and consent-only authority. Rejected after the owner weighed the trade-off explicitly; revisitable only with its own ADR if a real deep-integration use case materializes.
- **A single `contribute-ui` slot** covering panels and overlays: shorter consent, but a "small rectangle" grant would silently include "the whole screen"; separate slots keep the widening diff honest.
- **Automatic panel eviction (LRU/priority)** when the rail is full: removes a manual chore, but hidden priority is authority-by-position in disguise. Manual collapse chosen instead.
- **Headless textual mock of panels**: rejected — inventing a second rendering where no surface exists is exactly the non-design behavior moh refuses elsewhere.

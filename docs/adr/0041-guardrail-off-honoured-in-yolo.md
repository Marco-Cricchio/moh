# ADR-0041: the guardrail `off` is honoured in yolo

Status: accepted · Date: 2026-09-20 · Parent: issue #850 · Reverses: the ADR-0031-era refusal

## Context

The Jev control surface refused `guardrail off` whenever the live permission
mode was `yolo`: the command was answered with a distinct `"yolo"` refusal
("off refused — yolo keeps the lethal checks on"), rendered identically in the
transcript and the `/jev` modal, and the manual stated it as a promise — *"The
guardrail cannot be switched off in yolo."*

The rationale (ADR-0031) was sound on paper: in yolo an extension `ask` is
ignored, so the guardrail's veto is the only remaining stop, and a filter that
can be switched off in the mode that needs it most is not a filter.

In practice the rule created a trap. A yolo session whose guardrail produces a
false positive — the trigger was a legitimate tracker write judged as
exfiltration (0.92) — is stuck: the veto is a hard block that cannot be
self-approved and names no way out, and the one documented escape (`guardrail
off`) is refused precisely in the mode where the veto bites hardest. The only
exit was relaunching moh without the flag.

## Decision

**Go — `off` for the guardrail is honoured in yolo, as a session-warm flip
like every other.**

- `guardrail off` in yolo is applied, recorded (`jev_usecase` in the log,
  with its usual session-only marker and note) and visible (transcript line +
  `/jev` modal state). Nothing is written to any configuration file; a new
  session starts from the config again — for the guardrail, that means armed.
- The flip is reversible in the same session: `guardrail on` restores the
  yolo narrowing (lethal checks only, still able to veto), and the restored
  state says so ("yolo — the lethal checks only").
- **Full off, no floor.** A disarmable-but-floored state ("lethal checks
  only", irremovable) would reproduce today's trap in a new guise: a
  false-positive veto is lethal-class by definition. `off` means off.
- **No confirmation modal.** The project's precedent for destructive-ish
  flips is a visible line, not a two-key modal; the `⚠ YOLO` banner stays
  untouched, and the flip itself is loud (record + transcript line).
- **Mode changes never silently re-arm.** The warm flag is independent of the
  permission mode: leaving yolo does not re-arm a disarmed guardrail, and
  re-entering yolo does not disarm a fresh one. The state at any moment is
  the last command's — visible in the modal and the log.
- The `"yolo"` refusal leaves the `JevUseCaseRefusal` vocabulary; whatever
  remains refused (`unavailable`, `unknown-action`, `unsupported`), "you are
  in yolo" is no longer a reason.

## Consequences

- Yolo users own the risk they opt into: the mode's promise ("no permission
  prompts, unrestricted tools") is already absolute about everything else;
  the guardrail is now disarmable like any other tool-level check, with the
  same visibility.
- The manual's rule is rewritten (guardrail switchable in yolo, session-only,
  visible), and `docs/manual/` is regenerated from the source page.
- ADR-0031's ask-ignored-in-yolo semantics are unchanged; this decision is
  only about the on/off switch.

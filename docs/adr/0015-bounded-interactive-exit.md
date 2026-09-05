# ADR-0015: Bounded interactive exit

Status: accepted · Date: 2026-08-30 · Issue: #341

## Context

The TUI's only exit is deliberate (double `Ctrl+C`), yet after the UI disappeared the
process survived for ~3s on Linux/Kitty and macOS Terminal.app alike: Bun's HTTP client
keeps provider keep-alive sockets open, and those event-loop handles — not the terminal —
decided when the shell prompt came back. `App`'s unmount cleanup also fired
`session.dispose()` without awaiting it, so the entry point had no way to know when
session cleanup was done.

## Decision

1. **Exit-work seam** (`packages/tui/src/exit.ts`): components register in-flight
   cleanup promises with `trackExitWork`; the CLI entry point settles them through
   `finishExit`, which awaits tracked work with a budget and then terminates the
   process explicitly.
2. **Policy: the interactive exit path is bounded.** After the user exits the TUI,
   tracked cleanup gets a fixed budget (2.5s at the entry point, of which the memory
   flush owns its own 2s per #315), then the process exits regardless of lingering
   handles. A deliberate exit must never wait for idle keep-alive sockets, background
   fetches, or any other handle the exit didn't ask about.
3. Durable session work is protected by the existing bounded flush inside
   `AgentSession.dispose()` (#315): the fix bounds *when the process leaves*, not what
   the flush is allowed to finish.

## Consequences

- Force-exit is handle-agnostic: no per-handle diagnosis (which socket, which fetch)
  is required to keep exits prompt, now or after future handle sources are added.
- Anything that must complete before exit must be registered via `trackExitWork` (or
  awaited inside `dispose()` within its own budget) — fire-and-forget cleanup is
  invisible to the budget and may be cut off.
- Regression seam: `packages/cli/test/exit-quiescence.test.ts` measures real process
  quiescence of a spawned child with an open keep-alive socket and never-settling
  tracked work.

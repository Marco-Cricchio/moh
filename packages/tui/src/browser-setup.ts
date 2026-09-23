/**
 * #936: the browser-toolchain diagnostic as the TUI reads it.
 *
 * The core appends one `browser_unavailable` chrome event at session open
 * when the browser tool is enabled but its toolchain is missing (#774,
 * #935). Two different questions are asked of that event, and they must
 * not be conflated:
 *
 *  - **the transcript** renders *history*: every diagnostic in the log is
 *    a block, including the ones an earlier open produced (a resumed
 *    session keeps its warning).
 *  - **the action chip** states the *present*: whether this open observed
 *    a missing toolchain, which is what `currentBrowserDiagnostic` answers.
 *    A resumed session whose toolchain has since been installed must not
 *    keep offering setup.
 *
 * The rule is the log's own grammar: the diagnostic belongs to the current
 * open when it is appended after the last `session_start` (a fresh open) or
 * `session_resumed` (a resume) — both of which the core appends *before*
 * the startup chrome. Everything older is history.
 */
import type { AgentEvent } from "@moh/core";

/** The TUI's action line under the transcript warning. The core's reason
 * already names the CLI command and the Settings path; this names the door
 * that always exists in the TUI — the block is history, so it must not
 * advertise a key that only works while the warning is current (the footer
 * alarm and the `install` chip carry that one). */
export const BROWSER_SETUP_ACTION = "install now: /browser";

/**
 * The `browser_unavailable` reason this open observed, or null when the
 * current open has none (nothing enabled, a working toolchain, or only an
 * older diagnostic in the log).
 */
export function currentBrowserDiagnostic(events: readonly AgentEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    // The open marker is the boundary: a diagnostic above it belongs to an
    // earlier open and describes an environment this session never saw.
    if (event.type === "session_start" || event.type === "session_resumed") return null;
    if (event.type === "browser_unavailable") return event.reason;
  }
  return null;
}

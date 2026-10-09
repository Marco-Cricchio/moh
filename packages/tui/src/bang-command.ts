/**
 * ADR-0076: the chat composer's bang-command grammar — pure parsing, no
 * React. `!cmd` runs the command; `!!cmd` runs it and auto-sends the
 * (tool-truncated) output to the model when it finishes; `\!` escapes a
 * literal leading `!`. Anything else is not a bang command. Home's
 * composer never sees this module: the grammar lives in the chat submit
 * path only.
 */
export interface BangCommand {
  /** `!!` auto-sends the output to the model; `!` does not. */
  autoSend: boolean;
  command: string;
}

/** Parses a submitted composer draft into a bang command, or null. */
export function parseBangCommand(text: string): BangCommand | null {
  if (text.startsWith("\\!")) return null;
  if (text.startsWith("!!")) {
    const command = text.slice(2).trim();
    return command ? { autoSend: true, command } : null;
  }
  if (text.startsWith("!")) {
    const command = text.slice(1).trim();
    return command ? { autoSend: false, command } : null;
  }
  return null;
}

/** ADR-0076: the escape's payload — a `\!` draft sends the text with the
 * backslash consumed, so the user gets the literal leading `!` they asked
 * for. Anything else passes through untouched. */
export function stripBangEscape(text: string): string {
  return text.startsWith("\\!") ? text.slice(1) : text;
}

/** The active-turn refusal line: the grammar exists, the moment is wrong. */
export function bangActiveTurnRefusal(): string {
  return "! is unavailable while a turn runs — press esc to interrupt, or wait for it to finish.";
}

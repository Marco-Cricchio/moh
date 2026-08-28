import React from "react";
import { render } from "ink";
import { App, type AppProps } from "./App";

/** Clears the terminal once before the first frame (#292): the home screen
 * opens on a clean viewport instead of below the shell's scrollback. Plain
 * `2J` (no alternate screen) so the shell history stays intact on exit.
 * Non-TTY hosts (tests, pipes) are left untouched. Returns whether a clear
 * was written. */
export function startupClear(out: { isTTY?: boolean; write: (s: string) => unknown }): boolean {
  if (!out.isTTY) return false;
  out.write("\x1b[2J\x1b[H");
  return true;
}

/** Renders the TUI. Returns Ink's instance (with `unmount()`).
 *
 * `kittyKeyboard: auto` negotiates the kitty keyboard protocol on supporting
 * terminals (kitty/WezTerm/Ghostty): that is what makes shift+enter arrive as
 * `key.shift` instead of a plain `\r` identical to Enter (the multiline
 * input's shift+enter newline). On every other terminal nothing changes —
 * ctrl+j remains the newline fallback everywhere. */
export function renderTui(options: AppProps) {
  startupClear(process.stdout);
  return render(React.createElement(App, options), {
    // Exit is the deliberate double ctrl+c handled in App: a single stray
    // ctrl+c only arms ("press ctrl+c again") and never kills the session.
    exitOnCtrlC: false,
    kittyKeyboard: { mode: "auto" },
  });
}

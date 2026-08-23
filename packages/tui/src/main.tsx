import React from "react";
import { render } from "ink";
import { App, type AppProps } from "./App";

/** Renders the TUI. Returns Ink's instance (with `unmount()`).
 *
 * `kittyKeyboard: auto` negotiates the kitty keyboard protocol on supporting
 * terminals (kitty/WezTerm/Ghostty): that is what makes shift+enter arrive as
 * `key.shift` instead of a plain `\r` identical to Enter (the multiline
 * input's shift+enter newline). On every other terminal nothing changes —
 * ctrl+j remains the newline fallback everywhere. */
export function renderTui(options: AppProps) {
  return render(React.createElement(App, options), {
    exitOnCtrlC: true,
    kittyKeyboard: { mode: "auto" },
  });
}

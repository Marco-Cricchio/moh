import React from "react";
import { render } from "ink";
import { App, type AppProps } from "./App";

/** Renders the TUI. Returns Ink's instance (with `unmount()`). */
export function renderTui(options: AppProps) {
  return render(React.createElement(App, options), { exitOnCtrlC: true });
}

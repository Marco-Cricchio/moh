import React from "react";
import { render } from "ink";
import { App, type AppProps } from "./App";
import { installAiSdkWarningSink } from "./ai-sdk-warnings";
import { prepareProjectIdentityNow, resolveTrackerSync } from "@moh/core";
import { homedir } from "node:os";
import { loadUserConfig, userConfigFile } from "./user-config";

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

/** Kitty identifies itself with KITTY_WINDOW_ID, so no capability query is
 * needed. Avoiding Ink's auto-mode query prevents a late CSI ? u reply from
 * reaching the first Home input frame on Linux (#315). Other terminals keep
 * Ink's conservative auto-negotiation. */
export function kittyKeyboardOptions(env: Record<string, string | undefined> = process.env) {
  return { mode: env.KITTY_WINDOW_ID ? "enabled" as const : "auto" as const };
}

/** Renders the TUI. Returns Ink's instance (with `unmount()`).
 *
 * `kittyKeyboard: auto` negotiates the kitty keyboard protocol on supporting
 * terminals (kitty/WezTerm/Ghostty): that is what makes shift+enter arrive as
 * `key.shift` instead of a plain `\r` identical to Enter (the multiline
 * input's shift+enter newline). On every other terminal nothing changes —
 * ctrl+j remains the newline fallback everywhere. */
export function renderTui(options: AppProps) {
  // #939: project identity resolves through a synchronous `git remote
  // get-url`, and under bun a synchronous spawn runs the event loop inside
  // the call — from React's render/commit window that re-enters the
  // reconciler and crashes Ink ("Should not already be working.", ADR-0024).
  // This entry point runs outside React, so it prepares and pins the
  // identity here: App's own gate then finds it ready and paints the real
  // first frame instead of its boot state. Failure falls through — the
  // resolver is fail-soft by design.
  try {
    prepareProjectIdentityNow(options.cwd, options.home ?? homedir());
  } catch {
    // Nothing to do: identity resolution keeps its own fallbacks.
  }
  try {
    const cfgFile = userConfigFile(options.home ?? homedir());
    if (loadUserConfig(cfgFile).workflow.enabled) {
      resolveTrackerSync({ cwd: options.cwd });
    }
  } catch {
    // Same: resolveTrackerSync already degrades to null.
  }
  // #347: capture AI SDK warnings before the first provider call can
  // print them — the sink routes them to the App's toast channel instead
  // of the SDK's raw `process.emitWarning` output.
  installAiSdkWarningSink();
  startupClear(process.stdout);
  return render(React.createElement(App, options), {
    // Exit is the deliberate double ctrl+c handled in App: a single stray
    // ctrl+c only arms ("press ctrl+c again") and never kills the session.
    exitOnCtrlC: false,
    // #329: `incrementalRendering` was validated and REJECTED: ink's
    // incremental log-update assumes its previous frame sits directly above
    // the cursor, but moh's native-scrollback design interleaves Static
    // writes (log.clear + write(static) + log(output)) — the cursorUp-based
    // rewrite then lands on the freshly promoted rows and erases them
    // (reproduced in the PTY suite). The flicker fix is the Static head
    // promotion in Chat; this option stays off.
    kittyKeyboard: kittyKeyboardOptions(),
  });
}

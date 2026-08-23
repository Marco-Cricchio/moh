/**
 * The focus state machine (issue #116, spec decision 7): `tab` cycles only
 * between the chat input and the left menu (2 zones). While the menu has
 * focus it owns the keyboard — `↑↓` move the selection, `⏎` activates —
 * and every other key is inert. Pure: App maps `activated` (a menu index)
 * to its own screens/overlays.
 */

/** The two focusable zones of the dashboard. */
export type Focus = "input" | "menu";

export interface FocusState {
  focus: Focus;
  /** Index of the `❯` selection within the menu entries. */
  menuSel: number;
}

/** The slice of ink's key report the machine cares about. */
export interface FocusKey {
  tab?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

export interface FocusResult {
  state: FocusState;
  /** Menu index activated by `⏎` in menu mode; null otherwise. */
  activated: number | null;
}

export const INITIAL_FOCUS: FocusState = { focus: "input", menuSel: 0 };

/**
 * One keypress: returns the next focus state and, when the user pressed
 * `⏎` on a menu entry, the activated entry index (focus returns to the
 * input so an overlay or screen takes over cleanly).
 */
export function handleFocusKey(state: FocusState, input: string, key: FocusKey, entryCount: number): FocusResult {
  const inert: FocusResult = { state, activated: null };
  if (key.tab && !key.ctrl && !key.meta) {
    return { state: { ...state, focus: state.focus === "input" ? "menu" : "input" }, activated: null };
  }
  if (state.focus !== "menu" || key.ctrl || key.meta) return inert;

  const n = Math.max(1, entryCount);
  const sel = ((state.menuSel % n) + n) % n;
  if (key.upArrow) return { state: { focus: "menu", menuSel: (sel - 1 + n) % n }, activated: null };
  if (key.downArrow) return { state: { focus: "menu", menuSel: (sel + 1) % n }, activated: null };
  if (key.return || input === "\n" || input === "\r") {
    return { state: { focus: "input", menuSel: sel }, activated: sel };
  }
  return inert; // menu-focused: everything else is inert (no key leaks)
}

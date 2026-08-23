import { describe, expect, test } from "bun:test";
import { handleFocusKey, type FocusState } from "../src/focus";

const N = 5; // MENU_ENTRIES.length
const input: FocusState = { focus: "input", menuSel: 0 };

describe("focus state machine (issue #116)", () => {
  test("tab toggles between the two zones; no activation", () => {
    expect(handleFocusKey(input, "\t", { tab: true }, N)).toEqual({
      state: { focus: "menu", menuSel: 0 },
      activated: null,
    });
    expect(handleFocusKey({ focus: "menu", menuSel: 3 }, "\t", { tab: true }, N)).toEqual({
      state: { focus: "input", menuSel: 3 },
      activated: null,
    });
  });

  test("arrows in menu mode move with wrap-around", () => {
    const menu: FocusState = { focus: "menu", menuSel: 0 };
    expect(handleFocusKey(menu, "", { downArrow: true }, N).state).toEqual({ focus: "menu", menuSel: 1 });
    expect(handleFocusKey({ focus: "menu", menuSel: N - 1 }, "", { downArrow: true }, N).state).toEqual({
      focus: "menu",
      menuSel: 0,
    });
    expect(handleFocusKey({ focus: "menu", menuSel: 0 }, "", { upArrow: true }, N).state).toEqual({
      focus: "menu",
      menuSel: N - 1,
    });
  });

  test("return in menu mode activates the entry and returns focus to the input", () => {
    const r = handleFocusKey({ focus: "menu", menuSel: 1 }, "\r", { return: true }, N);
    expect(r).toEqual({ state: { focus: "input", menuSel: 1 }, activated: 1 });
  });

  test("while menu-focused every other key is inert (no leaks)", () => {
    const menu: FocusState = { focus: "menu", menuSel: 2 };
    for (const [ch, key] of [
      ["s", {}],
      ["x", {}],
      ["\x1b", { escape: true }],
      ["m", { ctrl: true }],
      ["t", { ctrl: true }],
      ["\x7f", { backspace: true }],
      ["", { leftArrow: true }],
    ] as const) {
      expect(handleFocusKey(menu, ch, key, N)).toEqual({ state: menu, activated: null });
    }
  });

  test("in input mode non-tab keys pass through untouched", () => {
    expect(handleFocusKey(input, "s", {}, N)).toEqual({ state: input, activated: null });
    expect(handleFocusKey(input, "", { upArrow: true }, N)).toEqual({ state: input, activated: null });
  });
});

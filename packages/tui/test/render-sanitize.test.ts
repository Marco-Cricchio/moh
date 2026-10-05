import { describe, expect, test } from "bun:test";
import { sanitizeForDisplay } from "../src/render-sanitize";

/** Every class of terminal control the boundary must neutralize: C0
 * (except LF/TAB, which are layout), ESC CSI with parameters, ESC OSC
 * (both terminators), C1 CSI, and all other C1 controls. */
const HOSTILE = [
  "\u001B[2J", // CSI clear screen
  "\u001B[31;1mred", // CSI SGR with parameters
  "\u001B]0;pwned\u0007", // OSC title, BEL-terminated
  "\u001B]8;;http://x\u001B\\link\u001B]8;;\u001B\\", // OSC hyperlink, ST-terminated
  "\u009B31m", // C1 CSI
  "\u0007", // BEL
  "\u0000\u0001\u001F", // C0 controls
  "\u007F", // DEL
  "\u0085\u009C", // C1 NEL, ST
];

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

describe("render-sanitize (issue #1200 boundary pin)", () => {
  test("output carries no CSI/OSC/C1 or C0 controls (layout chars survive)", () => {
    for (const hostile of HOSTILE) {
      const out = sanitizeForDisplay(`a${hostile}b`);
      expect(out).not.toMatch(CONTROL);
      expect(out).not.toContain("\u001B");
    }
    // Controls vanish; visible payload text survives where it is not part
    // of the sequence itself (the OSC-8 URL is payload, the link text is not).
    expect(sanitizeForDisplay("a\u001B[2Jb")).toBe("ab");
    expect(sanitizeForDisplay("a\u001B]0;pwned\u0007b")).toBe("ab");
    expect(sanitizeForDisplay("a\u001B]8;;http://x\u001B\\link\u001B]8;;\u001B\\b")).toBe("alinkb");
    expect(sanitizeForDisplay("keep\nlines\tand  spaces")).toBe("keep\nlines\tand  spaces");
  });
});

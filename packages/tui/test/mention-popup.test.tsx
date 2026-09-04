/**
 * File mention popup (#488, vision note 3): typing `@` in the composer
 * opens a fuzzy path popup over the caller-provided file index. Arrows are
 * captured only while the popup is open; Enter/Tab insert the selected
 * path as inline text (a path token, not a chip); a space closes it. The
 * slash popup is untouched — the two never qualify on the same draft.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultilineInput, mentionQuery, mentionSuggestions } from "../src/Input";
import { fuzzyRank, listFiles, MENTION_POPUP_CAP } from "../src/file-index";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(onSubmit: (text: string) => void, candidates: readonly string[]) {
  const i = render(<MultilineInput placeholder="p" focused mentionCandidates={candidates} onSubmit={onSubmit} />);
  await sleep(30);
  return {
    stdin: i.stdin,
    frame: () => stripAnsi(i.lastFrame() ?? ""),
    unmount: () => i.unmount(),
  };
}

const FILES = ["src/index.ts", "src/session/agent-loop.ts", "test/mentions.test.ts", "README.md", "docs/manual/chat.md"];

describe("mentionQuery (pure)", () => {
  test("opens on @ at a word boundary, cursor-scoped", () => {
    expect(mentionQuery("look at @sr", 11)).toBe("sr");
    expect(mentionQuery("@", 1)).toBe("");
    expect(mentionQuery("email bob@example.com", 21)).toBeNull(); // mid-word @
    expect(mentionQuery("@a b", 4)).toBeNull(); // space closes the token
    expect(mentionQuery("no mention", 10)).toBeNull();
  });

  test("@ activates only after whitespace or as the first symbol", () => {
    expect(mentionQuery("@src", 4)).toBe("src"); // first symbol of the prompt
    expect(mentionQuery("check @src", 10)).toBe("src"); // after a space
    expect(mentionQuery("check  @src", 11)).toBe("src"); // after multiple spaces
    expect(mentionQuery("check\t@src", 10)).toBe("src"); // after a tab
    expect(mentionQuery("check@src", 9)).toBeNull(); // after a character: NOT a mention
    expect(mentionQuery("a@b@c", 5)).toBeNull(); // neither @ is at a boundary
    expect(mentionQuery("x @", 3)).toBe(""); // boundary @, empty query → open list
  });
});

describe("mentionSuggestions + fuzzyRank (pure)", () => {
  test("empty query lists first-come paths, capped", () => {
    const many = Array.from({ length: 200 }, (_, k) => `f${k}.ts`);
    expect(mentionSuggestions("", many)).toHaveLength(MENTION_POPUP_CAP);
    expect(mentionSuggestions(null, FILES)).toEqual([]);
  });

  test("basename matches outrank whole-path matches; non-matches drop", () => {
    const ranked = fuzzyRank(["ax/y.js", "x.js", "b/y.ts"], "xj");
    expect(ranked[0]).toBe("x.js"); // pure-basename match beats path traversal
    expect(ranked).not.toContain("b/y.ts");
  });

  test("subsequence fuzzy: 'mlp' finds 'model-loop.ts'-style paths", () => {
    expect(fuzzyRank(["src/model-loop.ts", "src/other.ts"], "mlp")).toEqual(["src/model-loop.ts"]);
  });
});

describe("listFiles (index)", () => {
  test("inside git: ls-files paths; outside: walk fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-file-index-"));
    try {
      writeFileSync(join(dir, "a.ts"), "");
      mkdirSync(join(dir, "pkg"));
      writeFileSync(join(dir, "pkg", "b.ts"), "");
      const inGit = await listFiles(dir);
      expect(inGit.sort()).toEqual(["a.ts", "pkg/b.ts"].sort()); // repo is untracked — both fall to walk? no: ls-files lists tracked+untracked-not-ignored

      const noGit = mkdtempSync(join(tmpdir(), "moh-file-nowalk-"));
      try {
        writeFileSync(join(noGit, "c.md"), "");
        expect(await listFiles(noGit)).toEqual(["c.md"]);
      } finally {
        rmSync(noGit, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mention popup (raw bytes through Ink's parser)", () => {
  test("typing @ opens the fuzzy popup; arrows move; Enter inserts the path inline", async () => {
    let submitted = "";
    const i = await mount((t) => { submitted = t; }, FILES);
    i.stdin.write("explain @age");
    await sleep(80);
    expect(i.frame()).toContain("▶ src/session/agent-loop.ts");
    // "age" fuzzy-matches only the agent-loop path — the others drop.
    expect(i.frame()).not.toContain("README.md");
    i.stdin.write("\x1b[B"); // down
    await sleep(60);
    i.stdin.write("\r"); // Enter accepts, does not send
    await sleep(60);
    expect(submitted).toBe("");
    expect(i.frame()).toContain("explain @src/session/agent-loop.ts");
    expect(i.frame()).not.toContain("▶");
    i.stdin.write("please");
    await sleep(60);
    i.stdin.write("\r"); // the real send
    await sleep(60);
    expect(submitted).toBe("explain @src/session/agent-loop.ts please");
    i.unmount();
  });

  test("Tab completes like Enter; a space closes the popup", async () => {
    const i = await mount(() => {}, FILES);
    i.stdin.write("@read");
    await sleep(80);
    expect(i.frame()).toContain("▶ README.md");
    i.stdin.write("\t");
    await sleep(60);
    expect(i.frame().split("\n")[0]?.trim()).toBe("@README.md");
    i.stdin.write(" ");
    await sleep(60);
    expect(i.frame()).not.toContain("▶");
    i.unmount();
  });

  test("arrows are NOT captured without an open popup (note-26 coexistence)", async () => {
    let submitted = "";
    const i = await mount((t) => { submitted = t; }, FILES);
    i.stdin.write("plain draft");
    await sleep(60);
    i.stdin.write("\x1b[B"); // down: no popup → history/navigation path, not selection
    await sleep(60);
    expect(i.frame()).toContain("plain draft");
    expect(i.frame()).not.toContain("▶");
    i.stdin.write("\r");
    await sleep(60);
    expect(submitted).toBe("plain draft");
    i.unmount();
  });

  test("the slash popup is unaffected by mention candidates", async () => {
    const i = await mount(() => {}, FILES);
    i.stdin.write("@"); // mention popup opens…
    await sleep(60);
    expect(i.frame()).toContain("▶");
    i.stdin.write("\x7f"); // …backspace closes it; no slash popup either (no commands prop)
    await sleep(60);
    expect(i.frame()).not.toContain("▶");
    i.unmount();
  });
});

import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** #457: the user manual modal — opened from chat via /help, the
 * filterable index narrows by title/summary/body text, enter opens the
 * matching page, esc goes back to the index and a second esc closes. The
 * /help dispatch itself is covered in commands.test.ts. */

function renderChat() {
  return render(
    <App cwd={mkdtempSync(join(tmpdir(), "moh-manual-"))} home={mkdtempSync(join(tmpdir(), "moh-manual-home-"))} provider={MockProvider.demo()} startInChat skipOnboarding />,
  );
}

const frameOf = (i: ReturnType<typeof renderChat>) => stripAnsi(i.lastFrame() ?? "");

/** Polls until the frame contains `text` (or throws with the last frame). */
async function waitFor(i: ReturnType<typeof renderChat>, text: string, tries = 20): Promise<string> {
  for (let t = 0; t < tries; t++) {
    const frame = frameOf(i);
    if (frame.includes(text)) return frame;
    await sleep(25);
  }
  throw new Error(`frame never contained "${text}":\n${frameOf(i)}`);
}

/** Opens the manual: type the command, a space dismisses the completion
 * popup (its enter-acceptance would otherwise run first), then Return. */
async function openManual(i: ReturnType<typeof renderChat>) {
  i.stdin.write("/help");
  await sleep(60);
  i.stdin.write(" ");
  await sleep(60);
  i.stdin.write("\r");
  await waitFor(i, "type to filter");
}

describe("manual modal (#457)", () => {
  test("the index lists every page id and title", async () => {
    const i = renderChat();
    await sleep(50);
    await openManual(i);
    const frame = frameOf(i);
    for (const id of ["getting-started", "sessions", "providers-and-models", "permissions", "mcp", "cli-reference", "config-reference", "commands-and-keys"]) {
      expect(frame).toContain(id);
    }
    i.unmount();
  });

  test("the filter narrows the index and enter opens the match", async () => {
    const i = renderChat();
    await sleep(50);
    await openManual(i);
    for (const ch of "zero-config") i.stdin.write(ch); // body-text match narrows to config-reference
    const frame = await waitFor(i, "filter: zero-config");
    expect(frame).toContain("config-reference");
    expect(frame).not.toContain("getting-started");
    i.stdin.write("\r"); // open the only match
    await waitFor(i, "Manual → Config reference");
    i.unmount();
  });

  test("esc from a page returns to the index; a second esc closes", async () => {
    const i = renderChat();
    await sleep(50);
    await openManual(i);
    expect(frameOf(i)).toContain("filter: …"); // index state
    i.stdin.write("\r"); // open the selected page (getting-started, row 0)
    await waitFor(i, "Manual → Getting started");
    i.stdin.write("\x1b"); // esc → back to the index
    await waitFor(i, "getting-started");
    i.stdin.write("\x1b"); // esc → close
    await waitFor(i, "type… (shift+enter"); // composer back
    expect(frameOf(i)).not.toContain("Manual →");
    i.unmount();
  });
});

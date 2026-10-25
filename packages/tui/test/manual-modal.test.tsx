import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";
import { COMPOSER_READY, pressCommitted, pressSettled, stripAnsi, waitText } from "./helpers";

/** #457: the user manual modal — opened from chat via /help, the
 * filterable index narrows by title/summary/body text, enter opens the
 * matching page, esc goes back to the index and a second esc closes. The
 * /help dispatch itself is covered in commands.test.ts. */

function renderChat() {
  return render(
    <App intro={false} cwd={mkdtempSync(join(tmpdir(), "moh-manual-"))} home={mkdtempSync(join(tmpdir(), "moh-manual-home-"))} provider={MockProvider.demo()} startInChat skipOnboarding />,
  );
}

const frameOf = (i: ReturnType<typeof renderChat>) => stripAnsi(i.lastFrame() ?? "");

/** Waits (state, not time) until the frame contains `text`, then returns it. */
async function waitFor(i: ReturnType<typeof renderChat>, text: string): Promise<string> {
  await waitText(i, text, `the frame shows ${JSON.stringify(text)}`);
  return frameOf(i);
}

/** Opens the manual: type the command once the composer is up, a space
 * dismisses the completion popup (its enter-acceptance would otherwise run
 * first), then Return once the index-bound handler is attached. */
async function openManual(i: ReturnType<typeof renderChat>) {
  await waitText(i, COMPOSER_READY, "the composer mounted");
  i.stdin.write("/help");
  await waitText(i, "/help", "the command echoed in the composer");
  await pressCommitted(i, " ", "the space dismissing the completion popup");
  await pressSettled(i, "\r");
  await waitFor(i, "type to filter");
}

describe("manual modal (#457)", () => {
  test("the index lists every page id and title", async () => {
    const i = renderChat();
    await openManual(i);
    const frame = frameOf(i);
    for (const id of ["getting-started", "what-moh-offers", "sessions", "providers-and-models", "permissions", "mcp", "cli-reference", "config-reference", "commands-and-keys"]) {
      expect(frame).toContain(id);
    }
    i.unmount();
  });

  test("the filter narrows the index and enter opens the match", async () => {
    const i = renderChat();
    await openManual(i);
    for (const ch of "zero-config") i.stdin.write(ch); // body-text match narrows to config-reference
    const frame = await waitFor(i, "filter: zero-config");
    expect(frame).toContain("config-reference");
    expect(frame).not.toContain("getting-started");
    await pressSettled(i, "\r"); // open the only match
    await waitFor(i, "Manual → Config reference");
    i.unmount();
  });

  test("renders page Markdown instead of displaying source markers", async () => {
    const i = renderChat();
    await openManual(i);
    await pressSettled(i, "\r");
    const frame = await waitFor(i, "Manual → Getting started");
    expect(frame).toContain("moh is a coding agent");
    expect(frame).not.toContain("# Getting started");
    expect(frame).toContain("command starts it:");
    expect(frame).toContain("no configuration. moh opens with the");
    i.unmount();
  });

  test("reserves rows for page chrome when a long page is scrolled", async () => {
    const i = renderChat();
    await openManual(i);
    await pressSettled(i, "\r");
    await waitFor(i, "Manual → Getting started");
    for (let step = 0; step < 20; step++) i.stdin.write("\x1b[B");
    const frame = await waitFor(i, "↑");
    expect(frame).toContain("↓");
    expect(frame).toContain("↑↓ scroll · esc back");
    i.unmount();
  });

  test("esc from a page returns to the index; a second esc closes", async () => {
    const i = renderChat();
    await openManual(i);
    expect(frameOf(i)).toContain("filter: …"); // index state
    await pressSettled(i, "\r"); // open the selected page (getting-started, row 0)
    await waitFor(i, "Manual → Getting started");
    await pressSettled(i, "\x1b"); // esc → back to the index
    await waitFor(i, "getting-started");
    await pressSettled(i, "\x1b"); // esc → close
    await waitFor(i, COMPOSER_READY); // composer back
    expect(frameOf(i)).not.toContain("Manual →");
    i.unmount();
  });
});

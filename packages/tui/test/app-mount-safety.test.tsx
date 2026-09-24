/**
 * #939: mounting `App` outside `renderTui` must not be able to kill Ink.
 *
 * The session assembly, Home's session listing, the handoff offer and the
 * workflow tracker all resolve the project identity, and resolving it spawns
 * `git` synchronously. Under bun a synchronous spawn runs the event loop
 * inside the call, so any React work already queued (a scheduler task from an
 * earlier keystroke, another root's pending update) re-enters
 * `performWorkOnRoot` mid-commit and React aborts with "Should not already be
 * working." — taking down the Ink instance and every later mount in the file.
 *
 * These tests mount `App` with no warm-up at all (that is the point: the
 * warm-up used to be the safety argument, and nothing enforced it) and cover
 * the two shapes that reproduce it: a live root with a queued update at the
 * moment of the next mount, and mounts in sequence.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";
import { stripAnsi, waitForFrame } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tempHome = () => mkdtempSync(join(tmpdir(), "moh-mount-safety-home-"));
const tempCwd = () => mkdtempSync(join(tmpdir(), "moh-mount-safety-cwd-"));

/** A plain mount: no identity warm-up, no helper, exactly what a test or an
 * embed does. */
function mount() {
  return render(
    <App intro={false} cwd={tempCwd()} home={tempHome()} provider={MockProvider.demo()} startInChat skipOnboarding />,
  );
}

const frameOf = (i: { lastFrame(): string | undefined }) => () => stripAnsi(i.lastFrame() ?? "");

describe("mounting App outside renderTui (#939)", () => {
  test("a queued update on a live root cannot turn the next mount into a reconciler crash", async () => {
    const first = mount();
    await waitForFrame(frameOf(first), "type…");
    // An update scheduled from outside React: a scheduler task, queued and
    // not yet flushed. This is the pending work the identity spawn used to
    // run from inside its own call.
    first.stdin.write("hello");
    const second = mount();
    const third = mount();
    await waitForFrame(frameOf(second), "type…");
    await waitForFrame(frameOf(third), "type…");
    // The first instance is still alive and still owns its typed text: a
    // crash inside the second mount would have taken it — and the rest of
    // the file — down with it.
    expect(frameOf(first)()).toContain("hello");
    first.unmount();
    second.unmount();
    third.unmount();
  }, 20000);

  test("two mounts in sequence, the first disposed, both render", async () => {
    const first = mount();
    await waitForFrame(frameOf(first), "type…");
    first.unmount();
    const second = mount();
    await waitForFrame(frameOf(second), "type…");
    expect(frameOf(second)()).toContain("type…");
    second.unmount();
    await sleep(20);
  }, 20000);

  test("a prepared mount performs no synchronous spawn at all (the gate's contract)", async () => {
    const { prepareProjectIdentityNow } = await import("@moh/core");
    const cwd = tempCwd();
    const home = tempHome();
    // What renderTui does before the first frame, and what the gate does for
    // every other mount: after this, resolving the identity is memory-served.
    prepareProjectIdentityNow(cwd, home);

    const real = Bun.spawnSync;
    let spawns = 0;
    (Bun as { spawnSync: unknown }).spawnSync = ((...args: unknown[]) => {
      spawns++;
      return (real as (...a: unknown[]) => unknown)(...args);
    }) as never;
    let i: ReturnType<typeof render> | null = null;
    try {
      i = render(<App intro={false} cwd={cwd} home={home} provider={MockProvider.demo()} startInChat skipOnboarding />);
      await waitForFrame(frameOf(i), "type…");
    } finally {
      (Bun as { spawnSync: unknown }).spawnSync = real;
    }
    // Mount, session assembly, prompt composition, Home's listing and the
    // tracker initializer all ran: none of them may spawn. That is the
    // invariant the warm-up used to carry by convention.
    expect(spawns).toBe(0);
    i?.unmount();
  }, 20000);
});

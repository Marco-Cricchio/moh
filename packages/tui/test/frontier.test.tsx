import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Frontier } from "../src/Frontier";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi } from "./helpers";
import type { TrackerBackend, TrackerIssue } from "@moh/core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const issue = (id: string, over: Partial<TrackerIssue> = {}): TrackerIssue => ({
  id,
  title: `Issue ${id}`,
  state: "open",
  labels: [],
  assignees: [],
  blockedBy: [],
  ...over,
});

function backendOf(issues: TrackerIssue[]): TrackerBackend & { claimed: string[] } {
  const claimed: string[] = [];
  return {
    kind: "local-markdown",
    claimed,
    async list() {
      return issues.map((i) => (claimed.includes(i.id) ? { ...i, assignees: ["@me"] } : i));
    },
    async claim(id) {
      if (!issues.some((i) => i.id === id)) throw new Error("unknown");
      claimed.push(id);
    },
    async unclaim(id) {
      const at = claimed.indexOf(id);
      if (at >= 0) claimed.splice(at, 1);
    },
  };
}

function mount(backend: TrackerBackend | null, onToast = (_: string) => {}) {
  const i = render(
    <ThemeProvider value={THEMES[DEFAULT_THEME]}>
      <Frontier backend={backend} onToast={onToast} onClose={() => {}} />
    </ThemeProvider>,
  );
  return i;
}

describe("Frontier panel", () => {
  test("renders the tracker state: claimed, ready, blocked", async () => {
    const i = mount(
      backendOf([
        issue("1", { assignees: ["alice"] }),
        issue("2"),
        issue("3", { blockedBy: ["2"] }),
      ]),
    );
    await sleep(50);
    const text = stripAnsi(i.lastFrame() ?? "");
    expect(text).toContain("in progress");
    expect(text).toContain("ready");
    expect(text).toContain("blocked");
    expect(text).toContain("Issue 2");
    expect(text).toContain("blocked by #2");
    i.unmount();
  });

  test("degrades to a flat list without dependency data", async () => {
    const i = mount(backendOf([issue("1", { assignees: ["me"] }), issue("2")]));
    await sleep(50);
    const text = stripAnsi(i.lastFrame() ?? "");
    expect(text).toContain("no dependency data");
    expect(text).not.toContain("[blocked]");
    i.unmount();
  });

  test("claim action works: c claims the selected issue", async () => {
    const backend = backendOf([issue("1"), issue("2")]);
    const toasts: string[] = [];
    const i = mount(backend, (t) => toasts.push(t));
    await sleep(50);
    i.stdin.write("c");
    await sleep(50);
    expect(toasts).toContain("claimed #1");
    expect(backend.claimed).toEqual(["1"]);
    i.unmount();
  });

  test("claims before handing the claimed issue to the chooser", async () => {
    const backend = backendOf([issue("1", { labels: ["enhancement"] })]);
    const handedOff: string[] = [];
    const i = render(
      <ThemeProvider value={THEMES[DEFAULT_THEME]}>
        <Frontier
          backend={backend}
          onToast={() => {}}
          onClose={() => {}}
          onClaimed={(claimed) => handedOff.push(`${claimed.id}:${backend.claimed.join(",")}`)}
        />
      </ThemeProvider>,
    );
    await sleep(50);
    i.stdin.write("c");
    await sleep(50);
    expect(handedOff).toEqual(["1:1"]);
    i.unmount();
  });

  test("already-claimed issues are not re-claimable", async () => {
    const toasts: string[] = [];
    const i = mount(backendOf([issue("1", { assignees: ["bob"] })]), (t) => toasts.push(t));
    await sleep(50);
    i.stdin.write("c");
    await sleep(30);
    expect(toasts[0]).toContain("already claimed");
    i.unmount();
  });

  test("the claim action goes through the permission seam", async () => {
    const backend = backendOf([issue("1")]);
    const asked: string[] = [];
    const i = render(
      <ThemeProvider value={THEMES[DEFAULT_THEME]}>
        <Frontier
          backend={backend}
          onToast={() => {}}
          onClose={() => {}}
          requestClaim={(iss) => {
            asked.push(iss.id);
            return false; // denied
          }}
        />
      </ThemeProvider>,
    );
    await sleep(50);
    i.stdin.write("c");
    await sleep(30);
    expect(asked).toEqual(["1"]);
    expect(backend.claimed).toEqual([]); // denied: no mutation
    i.unmount();
  });

  test("a failed claim does not hand off to the chooser", async () => {
    let handedOff = 0;
    const i = render(
      <ThemeProvider value={THEMES[DEFAULT_THEME]}>
        <Frontier
          backend={{ kind: "gh", list: async () => [issue("1")], claim: async () => { throw new Error("race"); }, unclaim: async () => {} }}
          onToast={() => {}}
          onClose={() => {}}
          onClaimed={() => handedOff++}
        />
      </ThemeProvider>,
    );
    await sleep(50);
    i.stdin.write("c");
    await sleep(50);
    expect(handedOff).toBe(0);
    i.unmount();
  });

  test("u unclaims the selected claimed issue without a permission prompt", async () => {
    const backend = backendOf([issue("1", { assignees: ["@me"] })]);
    const toasts: string[] = [];
    const i = mount(backend, (t) => toasts.push(t));
    await sleep(50);
    i.stdin.write("u");
    await sleep(50);
    expect(toasts).toContain("unclaimed #1");
    expect(backend.claimed).toEqual([]);
    i.unmount();
  });

  test("u on an unclaimed issue explains and does not mutate", async () => {
    const backend = backendOf([issue("1")]);
    const toasts: string[] = [];
    const i = mount(backend, (t) => toasts.push(t));
    await sleep(50);
    i.stdin.write("u");
    await sleep(30);
    expect(toasts[0]).toContain("#1 not claimed");
    i.unmount();
  });

  test("a failing tracker shows an error, not a crash", async () => {
    const i = mount({
      kind: "gh",
      list: async () => {
        throw new Error("no gh auth");
      },
      claim: async () => {},
      unclaim: async () => {},
    });
    await sleep(50);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("tracker unavailable");
    i.unmount();
  });

  test("null backend renders an error line", async () => {
    const i = mount(null);
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("tracker unavailable");
    i.unmount();
  });
});

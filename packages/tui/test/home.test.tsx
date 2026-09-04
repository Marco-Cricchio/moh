import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, createSession, MockProvider, listSessionSummaries } from "@moh/core";
import { Home } from "../src/Home";
import { homeBannerFits } from "../src/viewport";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** n sessions titled s1…sn (oldest first, so sN is the newest). */
async function homeWithSessions(n: number): Promise<{ cwd: string; home: string }> {
  const home = mkdtempSync(join(tmpdir(), "moh-tui-home-list-"));
  const cwd = process.cwd();
  for (let i = 1; i <= n; i++) {
    const store = SessionStore.create(cwd, home);
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    // Await the send: a fire-and-forget send races the Home read on slow CI (#361 flake).
    await session.send(`title s${i}`);
    // #478: release the open-session registration so delete tests can trash it.
    store.dispose();
  }
  return { cwd, home };
}

const DOWN = "\x1b[B";

describe("home session list", () => {
  test("the first row is always New session, even with no sessions", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-tui-home-list-"));
    const i = render(<Home cwd={process.cwd()} home={home} mode="vibe" onOpen={() => {}} />);
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("New session");
    i.unmount();
  });

  test("caps the list at 5 visible sessions with a more-below hint", async () => {
    const { cwd, home } = await homeWithSessions(8);
    const i = render(<Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await sleep(60);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("New session");
    expect(frame).toContain("s8"); // newest session first under New session
    expect(frame).toContain("s4"); // 5th visible session
    expect(frame).not.toContain("s3"); // 6th is below the fold
    expect(frame).toContain("↓"); // hidden-below hint
    i.unmount();
  });

  test("scrolling follows the cursor to the tail and back up", async () => {
    const { cwd, home } = await homeWithSessions(8);
    const i = render(<Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await sleep(60);
    for (const _ of Array.from({ length: 10 })) {
      i.stdin.write(DOWN);
      await sleep(10);
    }
    const tail = stripAnsi(i.lastFrame() ?? "");
    expect(tail).toContain("s1"); // oldest reached by scrolling
    expect(tail).not.toContain("s7"); // scrolled out of the window (s8 is the banner row, always visible)
    expect(tail).toContain("↑"); // hidden-above hint
    i.unmount();
  });
});

describe("home session list — configurable cap", () => {
  test("listMax prop raises the visible window", async () => {
    const { cwd, home } = await homeWithSessions(8);
    const i = render(
      <Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} listMax={9} />,
    );
    await sleep(60);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("s1"); // every session fits
    expect(frame).not.toContain("↓"); // nothing below the fold
    i.unmount();
  });
});

describe("home chrome (#292)", () => {
  test("no static hint line; the footer carries new/settings/keys", async () => {
    const { lastFrame } = render(<Home cwd={process.cwd()} mode="vibe" onOpen={() => {}} />);
    await sleep(30);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("type to filter or start new");
    expect(frame).not.toContain("n new session");
    expect(frame).toContain("new (n) · settings (s) · keys (?)");
  });

  test("active-query hint appears while filtering", async () => {
    const i = render(<Home cwd={process.cwd()} mode="vibe" onOpen={() => {}} />);
    await sleep(30);
    i.stdin.write("x");
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("enter open · esc clear · ↑↓ select");
    i.unmount();
  });

  test("shows the version (number only) under the logo", async () => {
    const { lastFrame } = render(
      <Home cwd={process.cwd()} mode="vibe" onOpen={() => {}} version="0.1.0" />,
    );
    await sleep(30);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("v0.1.0");
    expect(frame).not.toContain("moh v0.1.0");
  });

  test("short terminals (test viewport 100×24) use the inline logo and move the version to the footer", async () => {
    const { lastFrame } = render(
      <Home cwd={process.cwd()} mode="vibe" onOpen={() => {}} version="0.1.0" />,
    );
    await sleep(30);
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("moh > — My Own Harness");
    expect(frame).toContain("v0.1.0 · "); // footer prefix in fallback mode
  });
});

describe("home banner decision (#292)", () => {
  test("the banner fits only on tall, non-compact terminals", () => {
    expect(homeBannerFits({ columns: 100, rows: 40 })).toBe(true);
    expect(homeBannerFits({ columns: 100, rows: 24 })).toBe(false);
    expect(homeBannerFits({ columns: 60, rows: 60 })).toBe(false); // compact
  });
});

describe("home update notice (#273)", () => {
  // Isolated home: the negative assertion below must not see real user
  // session titles (any live project can contain "moh update" in one).
  const home = mkdtempSync(join(tmpdir(), "moh-tui-home-notice-"));
  test("shows the fixed line when a newer stable is cached", async () => {
    const { lastFrame } = render(
      <Home cwd={process.cwd()} home={home} mode="vibe" onOpen={() => {}} updateNotice={{ kind: "available", latestVersion: "0.2.0" }} />,
    );
    await sleep(30);
    expect(stripAnsi(lastFrame() ?? "")).toContain("moh 0.2.0 available — run `moh update`");
  });

  test("nonstable build shows the dev notice", async () => {
    const { lastFrame } = render(
      <Home cwd={process.cwd()} home={home} mode="vibe" onOpen={() => {}} updateNotice={{ kind: "nonstable", latestVersion: "0.2.0" }} />,
    );
    await sleep(30);
    expect(stripAnsi(lastFrame() ?? "")).toContain("non-stable (dev) version");
  });

  test("no line without a notice", async () => {
    const { lastFrame } = render(<Home cwd={process.cwd()} home={home} mode="vibe" onOpen={() => {}} />);
    await sleep(30);
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("moh update");
  });
});

describe("pertinent session banner (#470, ADR-0021)", () => {
  test("the most recent unconsumed session renders as a pre-selected banner row", async () => {
    const { cwd, home } = await homeWithSessions(3);
    const i = render(<Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await sleep(60);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("▸"); // banner marker
    expect(frame).toContain("title s3"); // the newest (unconsumed) session
    i.unmount();
  });

  test("Enter opens the banner session", async () => {
    const { cwd, home } = await homeWithSessions(2);
    let opened: string | null | undefined;
    const i = render(
      <Home cwd={cwd} home={home} mode="vibe" onOpen={(s) => { opened = s?.title ?? null; }} />,
    );
    await sleep(60);
    i.stdin.write("\r");
    await sleep(30);
    expect(opened).toBe("title s2"); // banner is pre-selected: enter resumes the pertinent session
    i.unmount();
  });

  test("arrow-down from the banner moves into the list (banner is row 1)", async () => {
    const { cwd, home } = await homeWithSessions(3);
    let opened: string | null | undefined;
    const i = render(
      <Home cwd={cwd} home={home} mode="vibe" onOpen={(s) => { opened = s?.title ?? null; }} />,
    );
    await sleep(60);
    i.stdin.write("\x1b[B"); // down: banner row → first hit
    await sleep(10);
    i.stdin.write("\r");
    await sleep(30);
    expect(opened).toBe("title s3"); // first hit is the newest session
    i.unmount();
  });

  test("no banner when every session is consumed", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-tui-home-banner-"));
    const cwd = process.cwd();
    const store = SessionStore.create(cwd, home);
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    await session.send("consumed one");
    store.append({ type: "session_resumed" }); // closed after a resume → consumed
    const i = render(<Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await sleep(60);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).not.toContain("▸");
    expect(frame).toContain("consumed one"); // still listed, just not suggested
    i.unmount();
  });

  test("filtering hides the banner (query mode)", async () => {
    const { cwd, home } = await homeWithSessions(2);
    const i = render(<Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await sleep(60);
    i.stdin.write("s1");
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).not.toContain("▸");
    i.unmount();
  });
});

describe("session rename (#477)", () => {
  test("r enters the inline edit, enter confirms, the name persists to disk", async () => {
    const { cwd, home } = await homeWithSessions(1);
    const i = render(<Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await sleep(60);
    i.stdin.write("r");
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("rename:");
    // Prefilled with the derived title; append a suffix and confirm.
    for (const ch of "X") i.stdin.write(ch);
    await sleep(20);
    i.stdin.write("\r");
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("title s1X");
    i.unmount();
    const summaries = listSessionSummaries(cwd, home);
    expect(summaries[0].title).toBe("title s1X");
    expect(summaries[0].derivedTitle).toBe("title s1");
  });

  test("esc cancels the rename; enter on an empty buffer resets the name", async () => {
    const { cwd, home } = await homeWithSessions(1);
    const i = render(<Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await sleep(60);
    // Rename to "ZZ".
    i.stdin.write("r");
    await sleep(20);
    for (const ch of "\x7f".repeat(20) + "ZZ") i.stdin.write(ch); // clear prefill, type ZZ
    await sleep(20);
    i.stdin.write("\r");
    await sleep(30);
    expect(listSessionSummaries(cwd, home)[0].title).toBe("ZZ");
    // Esc cancels without writing.
    i.stdin.write("r");
    await sleep(20);
    i.stdin.write("\x1b");
    await sleep(20);
    expect(listSessionSummaries(cwd, home)[0].title).toBe("ZZ");
    // Enter on the emptied prefill (the current name "ZZ") resets.
    i.stdin.write("r");
    await sleep(20);
    for (const _ of Array.from({ length: 10 })) i.stdin.write("\x7f");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(30);
    expect(listSessionSummaries(cwd, home)[0].title).toBe("title s1");
    i.unmount();
  });

  test("the filter double-matches display name and derived title", async () => {
    const { cwd, home } = await homeWithSessions(2);
    const i = render(<Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await sleep(60);
    // Rename the newest (s2, banner row) to "banana".
    i.stdin.write("r");
    await sleep(20);
    for (const _ of Array.from({ length: 20 })) i.stdin.write("\x7f");
    i.stdin.write("banana");
    await sleep(40);
    i.stdin.write("\r");
    await sleep(30);
    // Searching by the DISPLAY name hits it…
    i.stdin.write("banana");
    await sleep(80);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("banana");
    // …and searching by the DERIVED title still finds the same session row.
    for (const _ of Array.from({ length: 10 })) i.stdin.write("\x7f");
    i.stdin.write("s2");
    await sleep(80);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("banana");
    i.unmount();
  });
});

describe("session rename (#477) — edges", () => {
  test("right-arrow enters the rename edit", async () => {
    const { cwd, home } = await homeWithSessions(1);
    const i = render(<Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await sleep(60);
    i.stdin.write("\x1b[C"); // right arrow
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("rename:");
    i.unmount();
  });

  test("the handoff row never enters the rename edit (r falls through)", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-tui-home-handoff-"));
    const offer: any = {
      status: "offer",
      source: { machine: "other", project: "p" },
      payload: { slug: "p", sessionId: "s", updatedAt: new Date().toISOString(), synthesis: "syn", transcript: [] },
      path: "/tmp/x.json",
      stale: false,
    };
    const i = render(
      <Home cwd={process.cwd()} home={home} mode="vibe" onOpen={() => {}} handoff={offer} onOpenHandoff={() => {}} />,
    );
    await sleep(60);
    // Cursor sits on the handoff row (row 1, pre-selected as first special row? no:
    // pertinent banner absent, so effective cursor is 0 → New session). Move down once.
    i.stdin.write("\x1b[B");
    await sleep(20);
    i.stdin.write("r");
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).not.toContain("rename:");
    i.unmount();
  });
});

describe("session delete (#478)", () => {
  test("d enters the confirm, default No (enter/n), y deletes and refreshes", async () => {
    const { cwd, home } = await homeWithSessions(1);
    const i = render(<Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await sleep(60);
    i.stdin.write("d");
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Delete?");
    // Default No: enter cancels, the row stays.
    i.stdin.write("\r");
    await sleep(30);
    expect(listSessionSummaries(cwd, home).length).toBe(1);
    // Confirm with y.
    i.stdin.write("d");
    await sleep(30);
    i.stdin.write("y");
    await sleep(30);
    expect(listSessionSummaries(cwd, home).length).toBe(0);
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("title s1");
    i.unmount();
  });

  test("esc cancels the delete", async () => {
    const { cwd, home } = await homeWithSessions(1);
    const i = render(<Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await sleep(60);
    i.stdin.write("d");
    await sleep(30);
    i.stdin.write("\x1b");
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("Delete?");
    expect(listSessionSummaries(cwd, home).length).toBe(1);
    i.unmount();
  });

  test("the deleted pertinent banner row disappears on refresh", async () => {
    const { cwd, home } = await homeWithSessions(1);
    const i = render(<Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await sleep(60);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("▸"); // pertinent banner
    i.stdin.write("d"); // cursor pre-selects the banner row
    await sleep(30);
    i.stdin.write("y");
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("▸");
    i.unmount();
  });

  test("the handoff row never enters the delete confirm", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-tui-home-handoff-del-"));
    const offer: any = {
      status: "offer",
      source: { machine: "other", project: "p" },
      payload: { slug: "p", sessionId: "s", updatedAt: new Date().toISOString(), synthesis: "syn", transcript: [] },
      path: "/tmp/x.json",
      stale: false,
    };
    const i = render(
      <Home cwd={process.cwd()} home={home} mode="vibe" onOpen={() => {}} handoff={offer} onOpenHandoff={() => {}} />,
    );
    await sleep(60);
    i.stdin.write("\x1b[B"); // down to the handoff row
    await sleep(20);
    i.stdin.write("d");
    await sleep(30);
    // falls through: the query buffer absorbs "d", no confirm opens
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("Delete?");
    i.unmount();
  });
});

describe("session delete (#478) — refusal", () => {
  test("deleting an open session shows the refusal error line and keeps the row", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-tui-home-open-"));
    const cwd = process.cwd();
    const store = SessionStore.create(cwd, home);
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    await session.send("title open");
    // NB: no store.dispose() — the session stays open in this process.
    const i = render(<Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await sleep(60);
    i.stdin.write("d");
    await sleep(30);
    i.stdin.write("y");
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("currently open");
    expect(listSessionSummaries(cwd, home).length).toBe(1);
    i.unmount();
    store.dispose(); // teardown: release the registry entry
  });
});

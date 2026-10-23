import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, createSession, MockProvider, listSessionSummaries, setSessionPinned, projectSlug, projectSessionsDir } from "@moh/core";
import { Home } from "../src/Home";
import { StrandedModal } from "../src/StrandedModal";

import { homeBannerFits } from "../src/viewport";
import { effectsFlushed, pressCommitted, stripAnsi, waitForCondition, waitForFrame, waitStep, waitText } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until the frame matches (bounded); runner-speed-proof replacement
 * for fixed sleeps around keystroke effects (#491 flake). */
async function untilFrame(getFrame: () => string, predicate: (frame: string) => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate(getFrame())) return;
    if (Date.now() > deadline) throw new Error(`untilFrame timed out; last frame: ${JSON.stringify(getFrame())}`);
    await sleep(20);
  }
}

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

type View = ReturnType<typeof render>;

/** The row under the cursor (Home marks it with a leading `› `). */
const cursorRow = (i: View) => stripAnsi(i.lastFrame() ?? "").split("\n").find((l) => l.includes("› ")) ?? "";

/** Presses a cursor key and waits until another row carries the cursor (#1473). */
async function move(i: View, key: string, step: string): Promise<void> {
  const before = cursorRow(i);
  i.stdin.write(key);
  await waitStep(i, () => cursorRow(i) !== before, `${step} (cursor leaving ${JSON.stringify(before.trim())})`);
}

/** Types into the query or rename buffer one key at a time, waiting for each
 * echo: a burst can reach a handler still closed over the previous buffer
 * (the lost-keystroke race, #637). `echo` renders the buffer as the frame
 * shows it. */
async function typeEach(i: View, text: string, echo: (typed: string) => string, step: string): Promise<void> {
  let typed = "";
  for (const ch of text) {
    typed += ch;
    i.stdin.write(ch);
    await waitText(i, echo(typed), `${step} (${JSON.stringify(typed)})`);
  }
}

describe("home session list", () => {
  test("the first row is always New session, even with no sessions", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-tui-home-list-"));
    const i = render(<Home intro={false} cwd={process.cwd()} home={home} mode="vibe" onOpen={() => {}} />);
    await waitText(i, "New session", "the home list");
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("New session");
    i.unmount();
  });

  test("caps the list at 5 visible sessions with a more-below hint", async () => {
    const { cwd, home } = await homeWithSessions(8);
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await waitText(i, "title s4", "the session list");
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
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await waitText(i, "title s4", "the session list");
    // Walk to the oldest session one confirmed press at a time.
    for (let k = 0; k < 12 && !cursorRow(i).includes("title s1"); k++) await move(i, DOWN, "scrolling down the list");
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
      <Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} listMax={9} />,
    );
    await waitText(i, "title s1", "the full session list");
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("s1"); // every session fits
    expect(frame).not.toContain("↓"); // nothing below the fold
    i.unmount();
  });
});

describe("home chrome (#292)", () => {
  // An isolated home: the chrome under test does not depend on the session
  // list, and reading the developer's real ~/.moh made these four tests
  // time out on a machine whose store had grown large.
  const isolatedHome = () => mkdtempSync(join(tmpdir(), "moh-tui-home-chrome-"));

  test("no static hint line; the footer carries new/settings/keys", async () => {
    const view = render(<Home intro={false} cwd={process.cwd()} home={isolatedHome()} mode="vibe" onOpen={() => {}} />);
    const { lastFrame } = view;
    await waitText(view, "New session", "the home list");
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("type to filter or start new");
    expect(frame).not.toContain("n new session");
    expect(frame).toContain("new (n) · settings (s) · keys (?)");
  });

  test("active-query hint appears while filtering", async () => {
    const i = render(<Home intro={false} cwd={process.cwd()} home={isolatedHome()} mode="vibe" onOpen={() => {}} />);
    await waitText(i, "New session", "the home list");
    i.stdin.write("x");
    await waitText(i, "esc clear", "the active-query hint");
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("enter open · esc clear · ↑↓ select");
    i.unmount();
  });

  test("shows the version (number only) under the logo", async () => {
    const view = render(
      <Home intro={false} cwd={process.cwd()} home={isolatedHome()} mode="vibe" onOpen={() => {}} version="0.1.0" />,
    );
    const { lastFrame } = view;
    await waitText(view, "New session", "the home list");
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("v0.1.0");
    expect(frame).not.toContain("moh v0.1.0");
  });

  test("short terminals (test viewport 100×24) use the inline logo and move the version to the footer", async () => {
    const view = render(
      <Home intro={false} cwd={process.cwd()} home={isolatedHome()} mode="vibe" onOpen={() => {}} version="0.1.0" />,
    );
    const { lastFrame } = view;
    await waitText(view, "New session", "the home list");
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
    const view = render(
      <Home intro={false} cwd={process.cwd()} home={home} mode="vibe" onOpen={() => {}} updateNotice={{ kind: "available", latestVersion: "0.2.0" }} />,
    );
    const { lastFrame } = view;
    await waitText(view, "New session", "the home list");
    expect(stripAnsi(lastFrame() ?? "")).toContain("moh 0.2.0 available — run `moh update`");
  });

  test("nonstable build shows the dev notice", async () => {
    const view = render(
      <Home intro={false} cwd={process.cwd()} home={home} mode="vibe" onOpen={() => {}} updateNotice={{ kind: "nonstable", latestVersion: "0.2.0" }} />,
    );
    const { lastFrame } = view;
    await waitText(view, "New session", "the home list");
    expect(stripAnsi(lastFrame() ?? "")).toContain("non-stable (dev) version");
  });

  test("no line without a notice", async () => {
    const view = render(<Home intro={false} cwd={process.cwd()} home={home} mode="vibe" onOpen={() => {}} />);
    const { lastFrame } = view;
    await waitText(view, "New session", "the home list");
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("moh update");
  });
});

describe("pertinent session banner (#470, ADR-0021)", () => {
  test("the most recent unconsumed session renders as a pre-selected banner row", async () => {
    const { cwd, home } = await homeWithSessions(3);
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await waitText(i, "title s1", "the session list");
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("▸"); // banner marker
    expect(frame).toContain("title s3"); // the newest (unconsumed) session
    i.unmount();
  });

  test("Enter opens the banner session", async () => {
    const { cwd, home } = await homeWithSessions(2);
    let opened: string | null | undefined;
    const i = render(
      <Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={(s) => { opened = s?.title ?? null; }} />,
    );
    await waitText(i, "› ▸", "the pre-selected banner row");
    i.stdin.write("\r");
    await waitStep(i, () => opened !== undefined, "the open callback");
    expect(opened).toBe("title s2"); // banner is pre-selected: enter resumes the pertinent session
    i.unmount();
  });

  test("arrow-down from the banner moves into the list (banner is row 1)", async () => {
    const { cwd, home } = await homeWithSessions(3);
    let opened: string | null | undefined;
    const i = render(
      <Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={(s) => { opened = s?.title ?? null; }} />,
    );
    await waitText(i, "› ▸", "the pre-selected banner row");
    await move(i, "\x1b[B", "down from the banner"); // down: banner row → first hit
    i.stdin.write("\r");
    await waitStep(i, () => opened !== undefined, "the open callback");
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
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await waitText(i, "consumed one", "the session list");
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).not.toContain("▸");
    expect(frame).toContain("consumed one"); // still listed, just not suggested
    i.unmount();
  });

  test("filtering hides the banner (query mode)", async () => {
    const { cwd, home } = await homeWithSessions(2);
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await waitText(i, "› ▸", "the pre-selected banner row");
    await typeEach(i, "s1", (typed) => `start “${typed}”`, "the query");
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).not.toContain("▸");
    i.unmount();
  });
});

describe("session rename (#477)", () => {
  test("ctrl+r enters the inline edit, enter confirms, the name persists to disk", async () => {
    const { cwd, home } = await homeWithSessions(1);
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await waitText(i, "› ▸", "the pre-selected banner row");
    i.stdin.write("\x12");
    await waitText(i, "rename:", "the rename edit");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("rename:");
    // Prefilled with the derived title; append a suffix and confirm.
    await typeEach(i, "X", (typed) => `rename: title s1${typed}`, "the suffix");
    i.stdin.write("\r");
    await waitText(i, "rename:", "the rename confirmed", { absent: true });
    await waitText(i, "title s1X", "the renamed row");
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("title s1X");
    i.unmount();
    const summaries = listSessionSummaries(cwd, home);
    expect(summaries[0].title).toBe("title s1X");
    expect(summaries[0].derivedTitle).toBe("title s1");
  });

  test("esc cancels the rename; enter on an empty buffer resets the name", async () => {
    const { cwd, home } = await homeWithSessions(1);
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await waitText(i, "› ▸", "the pre-selected banner row");
    // Rename to "ZZ".
    i.stdin.write("\x12");
    await waitText(i, "rename:", "the rename edit");
    // Clear the prefill one confirmed key at a time, then type ZZ.
    for (let k = 0; k < 20 && !stripAnsi(i.lastFrame() ?? "").includes("rename: ▊"); k++) {
      await pressCommitted(i, "\x7f", "clearing the prefill");
    }
    await waitText(i, "rename: ▊", "the prefill cleared");
    await typeEach(i, "ZZ", (typed) => `rename: ${typed}`, "the new name");
    i.stdin.write("\r");
    await waitStep(i, () => listSessionSummaries(cwd, home)[0].title === "ZZ", "the rename saved");
    await waitText(i, "rename:", "the rename edit closed", { absent: true });
    // Home reloads its session list after a rename (asynchronously): the next
    // ctrl+r must act on the reloaded row, not on the pre-rename summary.
    await waitText(i, "ZZ", "the reloaded list showing the new name");
    expect(listSessionSummaries(cwd, home)[0].title).toBe("ZZ");
    // Esc cancels without writing.
    i.stdin.write("\x12");
    await waitText(i, "rename:", "the rename edit");
    i.stdin.write("\x1b");
    await waitText(i, "rename:", "the rename cancelled", { absent: true });
    expect(listSessionSummaries(cwd, home)[0].title).toBe("ZZ");
    // Enter on the emptied prefill (the current name "ZZ") resets.
    i.stdin.write("\x12");
    await waitText(i, "rename:", "the rename edit");
    for (let k = 0; k < 10 && !stripAnsi(i.lastFrame() ?? "").includes("rename: ▊"); k++) {
      await pressCommitted(i, "\x7f", "clearing the prefill");
    }
    await waitText(i, "rename: ▊", "the prefill cleared");
    i.stdin.write("\r");
    await waitStep(i, () => listSessionSummaries(cwd, home)[0].title === "title s1", "the name reset");
    expect(listSessionSummaries(cwd, home)[0].title).toBe("title s1");
    i.unmount();
  });

  test("the filter double-matches display name and derived title", async () => {
    const { cwd, home } = await homeWithSessions(2);
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await waitText(i, "› ▸", "the pre-selected banner row");
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    // Rename the newest (s2, banner row) to "banana".
    i.stdin.write("\x12");
    await waitText(i, "rename:", "the rename edit");
    for (let k = 0; k < 20 && !frame().includes("rename: ▊"); k++) await pressCommitted(i, "\x7f", "clearing the prefill");
    await waitText(i, "rename: ▊", "the prefill cleared");
    await typeEach(i, "banana", (typed) => `rename: ${typed}`, "the new name");
    i.stdin.write("\r");
    await waitText(i, "rename:", "the rename confirmed", { absent: true });
    // Searching by the DISPLAY name hits it… (one confirmed key at a time:
    // the lost-keystroke race (#637) eats burst input under CI load)
    await typeEach(i, "banana", (typed) => `start “${typed}”`, "the display-name query");
    // …and searching by the DERIVED title still finds the same session row.
    for (let k = 0; k < 10 && frame().includes("start “"); k++) await pressCommitted(i, "\x7f", "clearing the query");
    await waitText(i, "start “", "the query cleared", { absent: true });
    await typeEach(i, "s2", (typed) => `start “${typed}”`, "the derived-title query");
    expect(frame()).toContain("banana");
    i.unmount();
  });
});

describe("session rename (#477) — edges", () => {
  test("right-arrow enters the rename edit", async () => {
    const { cwd, home } = await homeWithSessions(1);
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await waitText(i, "› ▸", "the pre-selected banner row");
    i.stdin.write("\x1b[C"); // right arrow
    await waitText(i, "rename:", "the rename edit");
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
      <Home intro={false} cwd={process.cwd()} home={home} mode="vibe" onOpen={() => {}} handoff={offer} onOpenHandoff={() => {}} />,
    );
    await waitText(i, "› New session", "the cursor on New session");
    // Cursor sits on the handoff row (row 1, pre-selected as first special row? no:
    // pertinent banner absent, so effective cursor is 0 → New session). Move down once.
    await move(i, "\x1b[B", "down to the handoff row");
    await waitText(i, "› ⤴ session handoff", "the cursor on the handoff row");
    // A key the row must ignore produces no commit to wait for. Ink renders
    // synchronously inside the write once the handler is attached (the waits
    // above ensured it), so the frame already shows any effect it had.
    i.stdin.write("\x12");
    await effectsFlushed();
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).not.toContain("rename:");
    i.unmount();
  });
});

describe("session delete (#478)", () => {
  test("ctrl+d enters the confirm, default No (enter/n), y deletes and refreshes", async () => {
    const { cwd, home } = await homeWithSessions(1);
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    // The list effect committed and its key handler attached (#637, #1473).
    await waitText(i, "title s1", "the session list");
    i.stdin.write("\x04");
    await waitText(i, "Delete?", "the delete confirm");
    // Default No: enter cancels, the row stays.
    i.stdin.write("\r");
    await waitText(i, "Delete?", "the delete cancelled", { absent: true });
    expect(listSessionSummaries(cwd, home).length).toBe(1);
    // Confirm with y.
    i.stdin.write("\x04");
    await waitText(i, "Delete?", "the delete confirm again");
    i.stdin.write("y");
    await waitForCondition(() => listSessionSummaries(cwd, home).length === 0, () => "confirmed delete never removed the session");
    await waitForFrame(frame, "title s1", { absent: true });
    i.unmount();
  });

  test("esc cancels the delete", async () => {
    const { cwd, home } = await homeWithSessions(1);
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await waitText(i, "title s1", "the session list");
    i.stdin.write("\x04");
    await waitText(i, "Delete?", "the delete confirm");
    i.stdin.write("\x1b");
    await waitForFrame(frame, "Delete?", { absent: true });
    expect(listSessionSummaries(cwd, home).length).toBe(1);
    i.unmount();
  });

  test("the deleted pertinent banner row disappears on refresh", async () => {
    const { cwd, home } = await homeWithSessions(1);
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await waitText(i, "› ▸", "the pre-selected banner row"); // pertinent banner
    i.stdin.write("\x04"); // cursor pre-selects the banner row
    await waitText(i, "Delete?", "the delete confirm");
    i.stdin.write("y");
    await waitForFrame(frame, "▸", { absent: true });
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
      <Home intro={false} cwd={process.cwd()} home={home} mode="vibe" onOpen={() => {}} handoff={offer} onOpenHandoff={() => {}} />,
    );
    await waitText(i, "› New session", "the cursor on New session");
    await move(i, "\x1b[B", "down to the handoff row"); // down to the handoff row
    await waitText(i, "› ⤴ session handoff", "the cursor on the handoff row");
    // No commit to wait for when the key is ignored (see the rename edge).
    i.stdin.write("\x04");
    await effectsFlushed();
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
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await waitText(i, "title open", "the session list");
    i.stdin.write("\x04");
    await waitText(i, "Delete?", "the delete confirm");
    i.stdin.write("y");
    await waitText(i, "currently open", "the refusal line");
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("currently open");
    expect(listSessionSummaries(cwd, home).length).toBe(1);
    i.unmount();
    store.dispose(); // teardown: release the registry entry
  });
});

describe("home row rendering (#480 regression)", () => {
  test("the selected session row never renders '[object Object]'", async () => {
    const { cwd, home } = await homeWithSessions(1);
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await waitText(i, "› ▸", "the pre-selected banner row");
    // The pertinent banner row (pre-selected) and a list row after moving down.
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("[object Object]");
    await move(i, "\x1b[B", "down to the list row"); // down to the list row
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("[object Object]");
    i.unmount();
  });
});

describe("home logo intro", () => {
  test("the intro animation plays before the content and settles into the banner", async () => {
    const { cwd, home } = await homeWithSessions(1);
    const i = render(<Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    // During the intro the settled banner's acronym line is absent — the
    // whole content area below it too: the animation is the ONLY thing on
    // screen (footer and update notice included).
    await sleep(80);
    expect(frame()).not.toContain("My Own Harness");
    expect(frame()).not.toContain("title s1");
    expect(frame()).not.toContain("ctrl+t theme");
    expect(frame()).not.toContain("settings (s)");
    // After ~3s (2.8s animation + settle delay) the banner appears with
    // the list below it.
    await waitForCondition(() => frame().includes("My Own Harness"), () => "intro never settled into the banner", { timeoutMs: 6000 });
    await waitForFrame(frame, "title s1", { timeoutMs: 6000 });
    // The chrome returns with the settled home.
    expect(frame()).toContain("ctrl+t theme");
    i.unmount();
  }, 10000);

  test("the update notice is hidden during the intro and shows on the settled home", async () => {
    const { cwd, home } = await homeWithSessions(1);
    const i = render(
      <Home
        cwd={cwd}
        home={home}
        mode="vibe"
        onOpen={() => {}}
        updateNotice={{ kind: "available", latestVersion: "9.9.9" }}
      />,
    );
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await sleep(80);
    expect(frame()).not.toContain("moh 9.9.9 available");
    await waitForCondition(() => frame().includes("My Own Harness"), () => "intro never settled", { timeoutMs: 6000 });
    await waitForFrame(frame, "moh 9.9.9 available", { timeoutMs: 6000 });
    i.unmount();
  }, 10000);

  test("any keystroke skips the intro straight to the settled home", async () => {
    const { cwd, home } = await homeWithSessions(1);
    const i = render(<Home cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await sleep(80);
    expect(frame()).not.toContain("My Own Harness");
    i.stdin.write(" "); // skip
    await waitForCondition(() => frame().includes("My Own Harness"), () => "keystroke never skipped the intro", { timeoutMs: 6000 });
    await waitForFrame(frame, "title s1", { timeoutMs: 6000 });
    i.unmount();
  }, 10000);

  test("intro={false} renders the settled home immediately (tests, scripted surfaces)", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-tui-home-intro-"));
    const i = render(<Home intro={false} cwd={process.cwd()} home={home} mode="vibe" onOpen={() => {}} />);
    // The first committed frame: with intro={false} it is already the settled home.
    await waitStep(i, () => (i.lastFrame() ?? "") !== "", "the first frame");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("My Own Harness");
    i.unmount();
  });
});

describe("home pins (ctrl+p)", () => {
  const PIN = "\x10"; // ctrl+p
  test("ctrl+p toggles the pinned state on disk; the pinned row gets the 📌 prefix", async () => {
    const { cwd, home } = await homeWithSessions(1);
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    // Lost-first-keystroke race (#637): the list committed and its key
    // handler attached before the first keystroke.
    await waitText(i, "title s1", "the session list");
    i.stdin.write(PIN);
    await waitForCondition(() => listSessionSummaries(cwd, home)[0].pinned === true, () => "pin never persisted");
    // The summaries re-read repaints the row with its 📌 prefix before the
    // second toggle.
    await waitText(i, "📌", "the pinned row");
    i.stdin.write(PIN);
    await waitForCondition(() => listSessionSummaries(cwd, home)[0].pinned === false, () => "unpin never persisted");
    i.unmount();
  });

  test("pinned sessions float to the top of the list (then by mtime)", async () => {
    const { cwd, home } = await homeWithSessions(4);
    // Pin the oldest (s1, list tail).
    const summaries = listSessionSummaries(cwd, home);
    setSessionPinned(summaries.find((s) => s.title === "title s1")!.file, true);
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await waitText(i, "title s4", "the session list");
    const text = stripAnsi(i.lastFrame() ?? "");
    const s1At = text.indexOf("title s1");
    const s4At = text.indexOf("title s4");
    expect(s1At).toBeGreaterThanOrEqual(0);
    expect(s1At).toBeLessThan(s4At); // pinned oldest floats above the newest
    i.unmount();
  });

  test("the handoff row never enters the pin toggle", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-tui-home-handoff-pin-"));
    const offer: any = {
      status: "offer",
      source: { machine: "other", project: "p" },
      payload: { slug: "p", sessionId: "s", updatedAt: new Date().toISOString(), synthesis: "syn", transcript: [] },
      path: "/tmp/x.json",
      stale: false,
    };
    const i = render(
      <Home intro={false} cwd={process.cwd()} home={home} mode="vibe" onOpen={() => {}} handoff={offer} onOpenHandoff={() => {}} />,
    );
    await waitText(i, "› New session", "the cursor on New session");
    await move(i, "\x1b[B", "down to the handoff row"); // down to the handoff row
    i.stdin.write(PIN);
    await effectsFlushed();
    // falls through harmlessly: nothing to pin, no crash
    i.unmount();
  });
});

describe("home row chip alignment (#480)", () => {
  test("the chip is right-aligned and fully visible on a short title", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-tui-home-chip-"));
    const cwd = process.cwd();
    const store = SessionStore.create(cwd, home);
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      sink: (e) => store.append(e),
    });
    await session.send("hi"); // short title
    store.dispose();
    void cwd;
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await waitText(i, "› ▸", "the pre-selected banner row");
    await move(i, "\x1b[B", "down to the list row"); // select the list row → chip appears
    await waitText(i, "rename · del", "the row chip");
    const lines = stripAnsi(i.lastFrame() ?? "").split("\n");
    // The chip may wrap in narrow test terminals; assert both parts render
    // and the second part closes the row's right edge (right-aligned).
    // The chip sits on the same line, right-aligned: the row ends with the
    // chip's last token and no wrap continuation follows.
    const row = lines.find((l) => l.includes("rename · del"));
    expect(row).toBeDefined();
    expect(row!.trimEnd().endsWith("del")).toBe(true);
    const next = lines[lines.indexOf(row!) + 1] ?? "";
    expect(next.trim()).not.toBe("(d)");
        i.unmount();
  });
});

describe("home chrome — no usage/model row (#718 removed)", () => {
  test("the session list carries no usage line and no model name", async () => {
    const { cwd, home } = await homeWithSessions(2);
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await untilFrame(frame, (f) => f.includes("title s1"));
    // The usage rollup ("last 7 days: N tok · top <model>") was removed: it
    // was the only place a model name appeared on Home.
    expect(frame()).not.toContain("last 7 days");
    expect(frame()).not.toContain("tok · top");
    i.unmount();
  });
});

// #1243: the stranded-data warning is a cursor-selectable row whose enter
// opens the resolution overlay (move logs / delete / keep).
function strandedFixture(): { cwd: string; home: string; live: string; source: string } {
  const home = mkdtempSync(join(tmpdir(), "moh-tui-stranded-"));
  const cwd = process.cwd();
  const live = join(home, ".moh", "projects", projectSlug(cwd, home));
  const source = join(home, ".moh", "projects", "project-0123456789abcdef");
  mkdirSync(live, { recursive: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "20260101T000000000Z-deadbeef.jsonl"), "old");
  writeFileSync(join(live, "stranded-data.json"), `${JSON.stringify({ source, destination: live, recordedAt: new Date().toISOString() })}\n`);
  return { cwd, home, live, source };
}

describe("stranded-data warning row (#1243)", () => {
  test("the warning row is selectable and enter opens the overlay", async () => {
    const { cwd, home } = strandedFixture();
    let opened = 0;
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} onOpenStranded={() => { opened++; }} />);
    await waitText(i, "› New session", "the cursor on New session");
    await waitText(i, "older data kept", "the stranded row");
    await move(i, DOWN, "down to the stranded row"); // row 1 = the stranded row (no handoff, no sessions)
    await waitText(i, "› ⚠ older data kept", "the cursor on the stranded row");
    i.stdin.write("\r");
    await untilFrame(() => String(opened), (n) => n === "1");
    i.unmount();
  });

  test("k acknowledges and the row is gone after a remount", async () => {
    const { cwd, home, live } = strandedFixture();
    const i = render(<StrandedModal dir={projectSessionsDir(cwd, home)} home={home} onClose={() => {}} />);
    await waitStep(i, () => (i.lastFrame() ?? "") !== "", "the stranded overlay");
    i.stdin.write("k");
    const recordFile = join(live, "stranded-data.json");
    await waitStep(
      i,
      () => typeof (JSON.parse(readFileSync(recordFile, "utf8")) as { acknowledgedAt?: string }).acknowledgedAt === "string",
      "the acknowledgement written",
    );
    i.unmount();
    const record = JSON.parse(readFileSync(recordFile, "utf8")) as { acknowledgedAt?: string };
    expect(typeof record.acknowledgedAt).toBe("string");
    const j = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    const frame = () => stripAnsi(j.lastFrame() ?? "");
    await waitText(j, "New session", "the remounted home list");
    expect(frame()).not.toContain("older data kept");
    j.unmount();
  });

  test("d + y removes the directory, trashes the logs and the row", async () => {
    const { cwd, home, live, source } = strandedFixture();
    const i = render(<StrandedModal dir={projectSessionsDir(cwd, home)} home={home} onClose={() => {}} />);
    await waitStep(i, () => (i.lastFrame() ?? "") !== "", "the stranded overlay");
    // `d` arms the confirm: wait for its commit before answering it.
    await pressCommitted(i, "d", "the delete confirm");
    i.stdin.write("y");
    await waitStep(i, () => !existsSync(source) && !existsSync(join(live, "stranded-data.json")), "the stranded data removed");
    i.unmount();
    expect(existsSync(source)).toBe(false);
    expect(existsSync(join(live, "stranded-data.json"))).toBe(false);
    const trash = join(home, ".moh", "trash");
    expect(execFileSync("find", [trash, "-name", "*deadbeef*"]).toString()).toContain("deadbeef");
  });

  test("no record, no warning row (layout unchanged)", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-tui-nostranded-"));
    const i = render(<Home intro={false} cwd={process.cwd()} home={home} mode="vibe" onOpen={() => {}} />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await waitText(i, "New session", "the home list");
    expect(frame()).not.toContain("older data kept");
    expect(frame()).toContain("New session");
    i.unmount();
  });
});

describe("pertinent banner relative time (characterization, #1437)", () => {
  /** Ages the only session file by `ms` and renders Home over it. */
  async function bannerAged(ms: number | null) {
    const { cwd, home } = await homeWithSessions(1);
    if (ms !== null) {
      const dir = projectSessionsDir(cwd, home);
      const when = new Date(Date.now() - ms);
      for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) utimesSync(join(dir, f), when, when);
    }
    const i = render(<Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={() => {}} />);
    await waitText(i, "title s1", "the banner title");
    const frame = stripAnsi(i.lastFrame() ?? "");
    i.unmount();
    return frame;
  }

  test("a fresh session reads 'adesso'", async () => {
    expect(await bannerAged(null)).toContain("adesso · title s1");
  });

  test("minutes, hours and days use their own units", async () => {
    expect(await bannerAged(5 * 60_000 + 5_000)).toMatch(/\b5 min · title s1/);
    expect(await bannerAged(3 * 3_600_000 + 5_000)).toContain("3h · title s1");
    expect(await bannerAged(2 * 86_400_000 + 5_000)).toContain("2g · title s1");
  });

  test("a week or older shows the ISO date", async () => {
    const ms = 10 * 86_400_000;
    const expected = new Date(Date.now() - ms).toISOString().slice(0, 10);
    expect(await bannerAged(ms)).toContain(`${expected} · title s1`);
  });
});

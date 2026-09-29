/**
 * Frame guards, wipe guards and layout guards as deterministic in-process
 * assertions (#1058, T5 of the #1052 chain / ADR-0057). Each test cites the
 * PTY baseline assertion it ports (`research-1052/`): part-a =
 * streaming-persistence, part-b = home-compact (+nocolor idle churn),
 * part-c = ask-user-oversized (#622).
 *
 * Harness: `faketty/` (#1057 T4) — a real Ink render over FakeStdout, the
 * raw byte stream read through `rawBytes()`, the physical screen through
 * `VtScreen.lines()`. No PTY, no python, no fixed sleeps: waits poll the
 * screen model and `settle()` polls byte quiescence.
 *
 * Determinism note (documented): `renderOnFakeTty.settle()` and the screen
 * polls below use real timers (the harness itself is wall-clock-based by
 * design). The typewriter reveal pacing, the one timer Chat owns during a
 * turn, is injected deterministically through the `reveal` prop
 * (`tickMs: 5`); `App` does not forward that prop (it reads the legacy env
 * once at module load), so the two tests that need pacing use `Chat`
 * directly — same as the T5 ticket anticipated for T6/T7 follow-ups.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React, { useReducer, useSyncExternalStore } from "react";
import { MockProvider, createSession, SessionStore, builtinTools, type AskUserQuestionSet, type Tool } from "@moh/core";
import type { SessionSummary } from "../src/sessions";
import { App } from "../src/App";
import { Home } from "../src/Home";
import { Chat } from "../src/Chat";
import { makeSession } from "../src/factory";
import { AskUserGate } from "../src/ask-user-gate";
import { renderOnFakeTty } from "./faketty/render";
import { COMPOSER_READY, unwrap } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ink's clearTerminal cycle marker (ED2 + ED3 + cursor home). */
const CLEAR = "\x1b[2J\x1b[3J\x1b[H";
/** ED3 alone: scrollback wipe. */
const ED3 = "\x1b[3J";

/** Deterministic reveal pacing: 5 ms ticks with a huge chars/tick mean the
 * reveal drains in a handful of ticks — same math, no 60 ms wall pacing. */
const FAST_REVEAL = { tickMs: 5, charsPerTick: 400, catchupChars: 4000 };

const screenText = (term: ReturnType<typeof renderOnFakeTty>) => term.screen.lines().join("\n");

async function waitForScreen(
  term: ReturnType<typeof renderOnFakeTty>,
  needle: string,
  { timeoutMs = 5_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!screenText(term).includes(needle) && Date.now() < deadline) await sleep(20);
  expect(screenText(term)).toContain(needle);
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "moh-frame-guards-h-"));
}

/** Seeds one persisted session whose first user message is `title`. */
async function seedSession(cwd: string, home: string, title: string): Promise<void> {
  const store = SessionStore.create(cwd, home);
  const session = createSession({
    provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
    sink: (e) => store.append(e),
  });
  await session.send(title);
}

/** Seeds a Home with `n` sessions and renders it static (intro off). */
async function mountHome(n: number, cols: number, rows: number) {
  const cwd = mkdtempSync(join(tmpdir(), "moh-frame-guards-"));
  const home = tempHome();
  for (let i = 0; i < n; i++) await seedSession(cwd, home, `seeded session number ${i} about the login page`);
  const onOpenedSession: { current: SessionSummary | null } = { current: null };
  const term = renderOnFakeTty(
    <Home intro={false} cwd={cwd} home={home} mode="vibe" onOpen={(resume) => { onOpenedSession.current = resume; }} />,
    { cols, rows },
  );
  return { cwd, home, term, onOpenedSession };
}

/** Mounts a Chat over a scripted session (the tui.smoke pattern) with the
 * fast reveal, ready for a prompt through the fake stdin. */
function mountChat(
  providerTurns: Parameters<typeof MockProvider.scripted>[0],
  opts: { cols: number; rows: number; showReasoning?: boolean; gate?: AskUserGate; tools?: Record<string, Tool> },
) {
  const cwd = mkdtempSync(join(tmpdir(), "moh-frame-guards-chat-"));
  const home = tempHome();
  const { session } = unwrap(makeSession({
    cwd,
    home,
    provider: MockProvider.scripted(providerTurns),
    ...(opts.gate ? { onAskUser: (set: AskUserQuestionSet) => opts.gate!.ask(set) } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
    permissionMode: "auto-accept",
  }));
  const term = renderOnFakeTty(
    <Chat
      session={session}
      cwd={cwd}
      mode="dev"
      modelLabel="mock"
      width={opts.cols}
      showReasoning={opts.showReasoning}
      reveal={FAST_REVEAL}
      askGate={opts.gate}
    />,
    { cols: opts.cols, rows: opts.rows },
  );
  return { term, session, cwd };
}

/** Types a prompt and starts the turn through the fake stdin. */
async function sendPrompt(term: ReturnType<typeof renderOnFakeTty>, text: string): Promise<void> {
  await waitForScreen(term, COMPOSER_READY);
  term.write(text);
  await sleep(20);
  term.write("\r");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// 1. Zero clearTerminal on Home at tight windows (part-b §3.1/§3.2/§3.3)
// ---------------------------------------------------------------------------

describe("home frame guards (part-b §3)", () => {
  for (const rows of [14, 18]) {
    test(`rows=${rows}: zero clearTerminal while sitting on Home (part-b §3.${rows === 14 ? 1 : 2})`, async () => {
      // Baseline part-b §3.1/§3.2: `readFileSync(rawDump).split(CLEAR).length - 1 === 0`.
      const { term } = await mountHome(2, 80, rows);
      await waitForScreen(term, "New session");
      await term.settle();
      expect(screenText(term)).toContain("My Own Harness");
      expect(countOccurrences(term.rawBytes().toString("utf8"), CLEAR)).toBe(0);
      await term.unmount();
  }, 60_000);
  }

  test("rows=12 with a long list: banner, actionable row and hint survive (part-b §3.3)", async () => {
    const { term } = await mountHome(12, 80, 12);
    await waitForScreen(term, "New session");
    await term.settle();
    const text = screenText(term);
    expect(text).toContain("My Own Harness");
    expect(text).toContain("New session");
    expect(text).toContain("ctrl+o mode");
    expect(text.length).toBeGreaterThan(50);
    await term.unmount();
  }, 60_000);

  test("rows=14: arrows, typing, esc and enter still open a session (part-b §3.4)", async () => {
    // Baseline part-b §3.4: after ↓ x esc ↓ \r the screen no longer
    // contains "New session" — navigation works in the compact layout.
    const { term, onOpenedSession } = await mountHome(3, 80, 14);
    await waitForScreen(term, "New session");
    // The seeded row is truncated at 80 cols ("seeded session n…"), so the
    // readiness needle is the shared prefix, not the full title.
    await waitForScreen(term, "seeded session n");
    await term.settle();
    term.write("\x1b[B");
    await term.settle();
    term.write("x"); // clears the search query
    await term.settle();
    term.write("\x1b"); // esc — same
    await term.settle();
    term.write("\x1b[B");
    await term.settle();
    term.write("\r"); // open
    await term.settle();
    const text = screenText(term);
    // The pty baseline asserts the screen no longer shows Home; in-process
    // the equivalent observable is the onOpen callback firing with a real
    // (non-null) resume target.
    expect(onOpenedSession.current).not.toBeNull();
    expect(text).not.toContain("seeded session number 0");
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 2. Dense paragraph never reaches Ink's fullscreen path (#950, part-a §5)
// ---------------------------------------------------------------------------

describe("dense paragraph fullscreen guard (part-a §5)", () => {
  test("an ~8000-char dense prose reply emits no clearTerminal and no ED3", async () => {
    // Baseline part-a §5 asserts (2) zero `\x1b[2J\x1b[3J\x1b[H` and
    // (3) the stronger `not.toContain("\x1b[3J")` on the whole run.
    const body = ("dense prose promotion boundary sentence repeated until the body crosses eight thousand characters of unbroken paragraph text. ").repeat(88).slice(0, 8_000) + " DENSE-DONE";
    const { term } = mountChat(
      [{ deltas: Array.from({ length: 9 }, (_, i) => body.slice(i * 900, (i + 1) * 900)).filter(Boolean), finish: "stop" }],
      { cols: 100, rows: 24 },
    );
    await sendPrompt(term, "dense");
    await waitForScreen(term, "DENSE-DONE");
    await term.settle();
    const raw = term.rawBytes().toString("utf8");
    expect(countOccurrences(raw, CLEAR)).toBe(0);
    expect(raw).not.toContain(ED3);
    expect(countOccurrences(raw, "DENSE-DONE")).toBeGreaterThanOrEqual(1);
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3. Oversized stream stays output-bounded (#203, part-a §10)
// ---------------------------------------------------------------------------

describe("oversized stream output bound (part-a §10)", () => {
  test("120 unbroken ~130-char chunks keep the byte volume bounded", async () => {
    // Baseline part-a §10 asserts `byteLength < 1_500_000` on the pty and
    // `TAIL-119` printed. The pty bound also covers the shell's own echo;
    // here the number is what Ink alone produces. Measured on this tree:
    // ~84 KB (see the assertion comment) — the bound below pins it with
    // ~10x headroom while still catching the quadratic full-transcript
    // rewrite the #203 clip prevents (that rewrite alone would add tens of
    // MB across 120 growing frames).
    const deltas = Array.from({ length: 120 }, (_, i) => `${"x".repeat(120)} TAIL-${i} `);
    const { term } = mountChat([{ deltas, finish: "stop" }], { cols: 120, rows: 40 });
    await sendPrompt(term, "long stream");
    await waitForScreen(term, "TAIL-119");
    await term.settle();
    const bytes = term.rawBytes().length;
    // eslint-disable-next-line no-console
    console.log(`[frame-guards] #203 measured bytes: ${bytes}`);
    expect(screenText(term)).toContain("TAIL-119");
    expect(bytes).toBeLessThan(800_000);
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4. Reasoning past the 64 KiB display cap repaints once (#950, part-a §6)
// ---------------------------------------------------------------------------

describe("reasoning cap rollover guard (part-a §6)", () => {
  test("early reasoning markers are not reprinted per frame; bytes stay bounded", async () => {
    // Baseline part-a §6's needle assertion is VACUOUS (it counts
    // `CAP-THINK-0000`, a string the fixture never emits — research-1052
    // README anomaly #1). Here the marker is one the stream really emits:
    // `PIECE-0001`, part of the first reasoning delta. The 64 KiB display
    // cap swaps the prefix for a moving window exactly once (Chat.tsx
    // nextReasoningHead), so the early marker may appear in its promoted
    // Static chunk and at most once more in the rollover transition.
    const piece = (i: number) =>
      `reasoning through the window boundary. `.repeat(28) + `PIECE-${String(i).padStart(4, "0")}\n`;
    const reasoningDeltas = Array.from({ length: 70 }, (_, i) => piece(i + 1)); // ~77 KiB > 64 KiB cap
    const { term } = mountChat(
      [{ reasoning: { deltas: reasoningDeltas }, deltas: ["CAP-REPLY-DONE the capped reasoning turn has settled"], finish: "stop" }],
      { cols: 120, rows: 24, showReasoning: true },
    );
    await sendPrompt(term, "cap rollover");
    // At 24 rows the ~77 KiB reasoning pushes the reply into the
    // scrollback: wait on the terminal history (scrollback ∪ screen), the
    // same "screen or scrollback" reading the pty harness uses.
    const historyText = () => [...term.screen.scrollback(), ...term.screen.lines()].join("\n");
    const capDeadline = Date.now() + 5_000;
    while (!historyText().includes("CAP-REPLY-DONE") && Date.now() < capDeadline) await sleep(20);
    expect(historyText()).toContain("CAP-REPLY-DONE");
    await term.settle();
    const raw = term.rawBytes().toString("utf8");
    // The 64 KiB cap swaps the prefix for a moving window: the history
    // keeps the windowed tail only (measured: 60 of 70 PIECE rows), so the
    // per-frame-reprint claim is asserted as "no marker appears more than
    // once in the surviving history" — the honest model-level translation
    // of the baseline's intent (whose own needle was vacuous, README
    // anomaly #1).
    const pieceRows = countOccurrences(historyText(), "PIECE-");
    // eslint-disable-next-line no-console
    console.log(`[frame-guards] cap rollover: PIECE rows in history ${pieceRows}, bytes ${term.rawBytes().length}`);
    expect(pieceRows).toBeGreaterThan(0);
    expect(pieceRows).toBeLessThanOrEqual(reasoningDeltas.length);
    const duplicated = [...historyText().matchAll(/PIECE-\d+/g)].map((m) => m[0]);
    expect(new Set(duplicated).size).toBe(duplicated.length); // no marker twice
    expect(countOccurrences(raw, CLEAR)).toBe(0);
    // Baseline bound 1_500_000 on the pty; measured here far below (see log).
    expect(term.rawBytes().length).toBeLessThan(800_000);
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5. Oversized ask_user gate: no idle churn (#622, part-b §4.3 / part-c §4.3)
// ---------------------------------------------------------------------------

const TALL_ASK = {
  questions: [
    {
      question:
        "tall box question — pick one route among many; this box is intentionally very tall so its rendered height must exceed the terminal viewport:",
      header: "Route",
      options: Array.from({ length: 4 }, (_, i) => ({
        label: `route-${i}`,
        description: Array.from(
          { length: 12 },
          (_, j) => `option ${i} description line ${j}: padded descriptive prose to consume viewport rows`,
        ).join(" "),
      })),
    },
  ],
} satisfies AskUserQuestionSet;

function askUserTools(seen: string[]): Record<string, Tool> {
  const base = builtinTools();
  return {
    ask_user: {
      ...base.ask_user,
      execute: async (args: any, ctx: any) => {
        const out = await base.ask_user.execute(args, ctx);
        seen.push(out);
        return out;
      },
    },
  };
}

/** Reproduces the App-side subscription for a bare Chat mount: App holds
 * the gate behind useSyncExternalStore and passes `blocked` down, which is
 * what stops the reveal tick while a question is open (#622). Chat reads
 * `askGate.current` at render time only. */
function GateHost(props: { gate: AskUserGate; chatProps: Record<string, unknown> }) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useSyncExternalStore(props.gate.subscribe, () => props.gate.version);
  React.useEffect(() => props.gate.subscribe(force), []);
  return (
    <Chat
      {...(props.chatProps as any)}
      blocked={props.gate.current !== null}
      askGate={props.gate}
    />
  );
}

describe("oversized ask gate idle guard (#622, part-c §4.3)", () => {
  test("after the tall gate opens, an idle window emits no clearTerminal churn", async () => {
    // Baseline part-c §4.3 allows `churn <= 4` across the gate-open
    // transition, then requires none during the 8 s idle window. Here the
    // window starts after the transition settled (byte quiescence), so the
    // allowed churn in the idle window itself is 0.
    const gate = new AskUserGate();
    const seen: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "moh-frame-guards-chat-"));
    const home = tempHome();
    const { session } = unwrap(makeSession({
      cwd,
      home,
      provider: MockProvider.scripted([
        { deltas: [""], finish: "tool_calls" as const, toolCalls: [{ name: "ask_user", args: TALL_ASK }] },
        { deltas: ["all set"], finish: "stop" as const },
      ]),
      onAskUser: (set: AskUserQuestionSet) => gate.ask(set),
      tools: askUserTools(seen),
      permissionMode: "auto-accept",
    }));
    const chatProps = { session, cwd, mode: "dev" as const, modelLabel: "mock", width: 100, reveal: FAST_REVEAL };
    const term = renderOnFakeTty(<GateHost gate={gate} chatProps={chatProps} />, { cols: 100, rows: 20 });
    await sendPrompt(term, "hello");
    // GateHost re-renders on the gate change and passes `blocked`, exactly
    // like App; no manual render forcing is needed.
    await waitForScreen(term, "tall box question");
    await term.settle(); // the gate-open transition drains fully
    const before = term.rawBytes().length;
    await term.settle(); // one idle window (~80 ms of quiescence polling)
    await term.settle();
    const after = term.rawBytes();
    const churnWindow = after.toString("utf8").slice(before);
    expect(countOccurrences(after.toString("utf8"), "tall box question")).toBeGreaterThanOrEqual(1);
    // eslint-disable-next-line no-console
    console.log(`[frame-guards] #622 idle-window bytes: ${after.length - before}, churn clears: ${countOccurrences(churnWindow, CLEAR)}`);
    expect(countOccurrences(churnWindow, CLEAR)).toBe(0);
    gate.resolve({ answers: [], cancelled: true });
    await sleep(50);
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 6. Resize (part-b §3.6 via faketty)
// ---------------------------------------------------------------------------

describe("resize guard (part-b §3.6)", () => {
  test("content re-renders within the new 80-column geometry", async () => {
    const body = Array.from({ length: 12 }, (_, i) => `paragraph ${i} with a reasonably long sentence that wraps across several columns at either width.`).join("\n\n") + " RESIZE-DONE";
    const { term } = mountChat([{ deltas: [body], finish: "stop" }], { cols: 100, rows: 30 });
    await sendPrompt(term, "resize me");
    await waitForScreen(term, "RESIZE-DONE");
    await term.settle();
    term.resize(80, 24);
    await term.settle();
    // Documented VtScreen semantics (render.ts): a resize swaps in a fresh
    // screen model of the new geometry, and Ink repaints the volatile frame
    // (footer, status) there — the printed transcript is NOT re-emitted
    // (ink treats static output as already printed; a real terminal keeps
    // it in native scrollback, which is exactly the part-b §3.6 claim
    // "printed scrollback remains native" — a level-2 property). The raw
    // byte stream stays the source of truth: RESIZE-DONE was painted and
    // must be in it; the repainted live area must fit the new width.
    const lines = term.screen.lines();
    expect(lines.length).toBe(24);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    expect(term.rawBytes().toString("utf8")).toContain("RESIZE-DONE");
    expect(screenText(term)).toContain("✓ done");
    expect(screenText(term)).toContain("⏎ send");
    await term.unmount();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// App-level smoke guard: the real client still boots over the fake TTY.
// ---------------------------------------------------------------------------

describe("app over faketty", () => {
  test("App boots to Home through renderOnFakeTty without clearTerminal", async () => {
    const term = renderOnFakeTty(
      <App intro={false} cwd={process.cwd()} home={tempHome()} provider={MockProvider.demo()} env={{}} skipOnboarding />,
      { cols: 100, rows: 30 },
    );
    await waitForScreen(term, "New session");
    await term.settle();
    expect(countOccurrences(term.rawBytes().toString("utf8"), CLEAR)).toBe(0);
    await term.unmount();
  }, 60_000);
});

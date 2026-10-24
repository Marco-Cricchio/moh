import "./faketty/ci-mask"; // BEFORE any ink-loading import: is-in-ci snapshots the env at module load
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";
import { userConfigFile } from "../src/user-config";
import { renderOnFakeTty, type FakeTerminal } from "./faketty/render";
import { grantTeamExtension, pressSettled, sendPrompt, stripAnsi, useFileCredentialStore, waitStep } from "./helpers";

useFileCredentialStore();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type View = ReturnType<typeof render>;
const last = (i: View) => stripAnsi(i.frames.at(-1) ?? "");
/** The settings cursor row, read inside the dialog box only: the overlay is
 * transparent, so a dialog row shares its line with the transcript or the
 * composer, whose "› you" and "› /ask-moh" carry the same glyph. */
const cursorRow = (i: View) =>
  last(i).split("\n").map((l) => l.split("│")[1] ?? "").find((cell) => cell.includes("› ")) ?? "";

/** #1474: sends the prompt and waits for the settled turn (was fixed 50 + 150 + 300 ms). */
async function settledTurn(i: View): Promise<void> {
  await sendPrompt(i, "hello");
  await waitStep(i, () => (i.frames.at(-1) ?? "").includes("ANSWERMARKER"), "the turn answered");
}

/** The index of the last write that flips back to the main buffer, or -1. */
const lastFlip = (frames: readonly string[]) => frames.reduce((at, frame, index) => (frame.includes("\x1b[?1049l") ? index : at), -1);

/**
 * Waits for the close choreography to finish: a flip back to the main buffer
 * after `fromIndex`, then the transcript re-emitted after it (was a fixed
 * 200 ms "outlast the 40 ms flip + throttle"). The ordering assertions that
 * follow stay exactly as they were; a repaint that races the flip never
 * satisfies this wait either, so the test still fails, by name.
 */
async function closeChoreography(i: View, fromIndex: number, step: string): Promise<void> {
  await waitStep(i, () => {
    const flip = lastFlip(i.frames);
    return flip > fromIndex && i.frames.some((frame, index) => index > flip && frame.includes("ANSWERMARKER"));
  }, step);
}

/**
 * #330: toggling Provider reasoning in the Settings overlay arms a
 * whole-transcript repaint that stays pending while the modal owns the
 * alternate screen. On close it must fire only after the alternate→main
 * buffer flip completes — firing concurrently makes the re-emitted Static
 * blocks land in the dying alternate buffer, leaving the chat blank in a
 * real terminal (recovery only via /mode).
 *
 * Seam: a full App with a settled turn, exercised through the Settings
 * overlay (ctrl+s → navigate → enter → esc). The ink-testing-library
 * output stream cannot emulate real terminal buffers, so the regression
 * is asserted on write ordering: the post-close reprint of the settled
 * marker must come after the "\x1b[?1049l" buffer-flip write.
 */
/**
 * Opens Settings and walks the cursor onto the "Provider reasoning" row.
 * Tolerant by design: the panel's row order grows as entries are added
 * ("Fallback models" landed after Provider), and a fixed count ages into a
 * false failure — it drove the wrong row and the flip never fired.
 */
async function openProviderReasoning(i: ReturnType<typeof render>): Promise<void> {
  i.stdin.write("\x13"); // ctrl+s
  await waitStep(i, () => last(i).includes("Default permission mode"), "the settings overlay opened");
  for (let n = 0; n < 24; n++) {
    if (last(i).includes("› " + "Provider reasoning")) return;
    // One confirmed press at a time: wait for the cursor to reach another row.
    const before = cursorRow(i);
    i.stdin.write("\x1b[B");
    await waitStep(i, () => cursorRow(i) !== before, "walking down to Provider reasoning");
  }
  throw new Error("the Provider reasoning row was not reachable");
}

/** Toggles the selected Provider reasoning row and waits for its new value. */
async function toggleReasoning(i: View, to: "show" | "hide"): Promise<void> {
  i.stdin.write("\r");
  await waitStep(i, () => cursorRow(i).includes("Provider reasoning") && cursorRow(i).includes(to), `the reasoning row reading "${to}"`);
}

describe("deferred transcript repaint vs alternate-screen close (#330)", () => {
  test("the post-close reprint happens after the buffer flip", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    const provider = MockProvider.scripted([
      { reasoning: { deltas: ["HISTMARKER historical reasoning"] }, deltas: ["ANSWERMARKER turn done"], finish: "stop" },
    ]);
    const i = render(<App intro={false} cwd={cwd} home={home} provider={provider} startInChat skipOnboarding />);
    // The alternate-screen choreography is TTY-gated; the harness stdout
    // reports as non-TTY unless marked here.
    Object.defineProperty(i.stdout, "isTTY", { value: true });
    await settledTurn(i);
    expect((i.frames.at(-1) ?? "").includes("ANSWERMARKER")).toBe(true);

    // Settings → Provider reasoning row → toggle (default hide → show).
    // The walk is tolerant by design: the panel's row order grows as
    // entries are added (the Jev entry landed at 11, the ported MPM/
    // highlight entries shift it further), and a fixed count ages into a
    // false failure. Walk until the row is selected, then toggle.
    await openProviderReasoning(i);
    await toggleReasoning(i, "show"); // toggle show
    const frameBefore = i.frames.at(-1) ?? "";
    expect(frameBefore).toContain("show");
    const escAt = i.frames.length;
    i.stdin.write("\x1b"); // esc → close (arms the deferred repaint)
    await closeChoreography(i, escAt, "the close flip and the reprint after it");

    // The flip back to the main buffer must be written by the close
    // choreography (TTY path active in the harness).
    const frames = i.frames;
    const flipIndex = frames.reduce((last, frame, index) => (frame.includes("\x1b[?1049l") ? index : last), -1);
    expect(flipIndex).toBeGreaterThanOrEqual(0);

    // The pending whole-transcript repaint starts with a deterministic
    // clear-screen + scrollback write; it must fire only after the buffer
    // flip completes (with the bug it races the 40ms flip timer and its
    // Static re-emission lands in the dying alternate buffer).
    const clearIndex = frames.reduce((last, frame, index) => (index > escAt && frame.includes("\x1b[3J") ? index : last), -1);
    expect(clearIndex).toBeGreaterThan(flipIndex);

    // And the transcript is re-emitted under the new setting after the
    // flip — visible in the main buffer, not lost in the alternate one.
    const reprintIndex = frames.findIndex((frame, index) => index > flipIndex && frame.includes("ANSWERMARKER"));
    expect(reprintIndex).toBeGreaterThan(flipIndex);
    i.unmount();
  }, 15000);

  test("show→hide: the repaint drops historical reasoning and still fires after the flip", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    // Start with display on so the toggle direction is show→hide.
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(userConfigFile(home), JSON.stringify({ showReasoning: true }));
    const provider = MockProvider.scripted([
      { reasoning: { deltas: ["HISTMARKER historical reasoning"] }, deltas: ["ANSWERMARKER turn done"], finish: "stop" },
    ]);
    const i = render(<App intro={false} cwd={cwd} home={home} provider={provider} startInChat skipOnboarding />);
    Object.defineProperty(i.stdout, "isTTY", { value: true });
    await settledTurn(i);

    await openProviderReasoning(i);
    await toggleReasoning(i, "hide"); // toggle hide
    const escAt = i.frames.length;
    i.stdin.write("\x1b"); // esc → close
    await closeChoreography(i, escAt, "the close flip and the reprint after it");

    const frames = i.frames;
    const flipIndex = frames.reduce((last, frame, index) => (frame.includes("\x1b[?1049l") ? index : last), -1);
    expect(flipIndex).toBeGreaterThanOrEqual(0);
    const clearIndex = frames.reduce((last, frame, index) => (index > escAt && frame.includes("\x1b[3J") ? index : last), -1);
    expect(clearIndex).toBeGreaterThan(flipIndex);
    const reprintIndex = frames.findIndex((frame, index) => index > flipIndex && frame.includes("ANSWERMARKER"));
    expect(reprintIndex).toBeGreaterThan(flipIndex);
    // NOTE: the harness accumulates Static output and cannot emulate the
    // real clear-screen escape, so "reasoning gone" is not observable
    // here — that drop is asserted at the Chat seam in
    // reasoning-controls.test.tsx (#242).
    i.unmount();
  }, 15000);

  test("rapid close→reopen cancels the flip without reprinting into the modal", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    const provider = MockProvider.scripted([
      { reasoning: { deltas: ["HISTMARKER historical reasoning"] }, deltas: ["ANSWERMARKER turn done"], finish: "stop" },
    ]);
    const i = render(<App intro={false} cwd={cwd} home={home} provider={provider} startInChat skipOnboarding />);
    Object.defineProperty(i.stdout, "isTTY", { value: true });
    await settledTurn(i);

    await openProviderReasoning(i);
    await toggleReasoning(i, "show"); // toggle show → arms the deferred repaint
    // esc → close, flip timer armed. Written inside act(): the close's passive
    // effects (App's re-subscribed key handler) run before the reopen below,
    // or a loaded runner hands ctrl+s to the pre-close handler and drops it.
    // act() does not advance timers, so the 40 ms flip timer still races.
    await pressSettled(i, "\x1b");
    await sleep(10); // deliberate: still inside the 40ms flip window (scheduling
    // may still let the timer win — the invariant below tolerates both)
    i.stdin.write("\x13"); // ctrl+s → reopen, cancels any pending flip
    await waitStep(i, () => last(i).includes("Default permission mode"), "the settings overlay reopened");
    const finalEscAt = i.frames.length;
    i.stdin.write("\x1b"); // final close
    await closeChoreography(i, finalEscAt, "the final close flip and the reprint after it");

    // Invariant: a whole-transcript repaint clear (2J/3J) is never
    // written while the alternate buffer is active — track buffer state
    // from the flip escapes and check every clear write lands in the
    // main buffer, whatever the close→reopen interleaving turned out to
    // be. The final repaint must still follow the last flip. And the
    // switches alternate: a reopen inside the flip window is still in the
    // alternate buffer, where a second 1049h would re-save the cursor that
    // the final flip restores the session frame at (#1489).
    const frames = i.frames;
    let inAlternate = false;
    let lastFlipIndex = -1;
    frames.forEach((frame, index) => {
      if (frame.includes("\x1b[?1049h")) {
        expect(inAlternate).toBe(false);
        inAlternate = true;
      }
      if (frame.includes("\x1b[?1049l")) { inAlternate = false; lastFlipIndex = index; }
      if (frame.includes("\x1b[3J")) {
        expect(inAlternate).toBe(false);
        expect(index).toBeGreaterThan(lastFlipIndex);
      }
    });
    expect(lastFlipIndex).toBeGreaterThanOrEqual(0);
    const reprintIndex = frames.findIndex((frame, index) => index > lastFlipIndex && frame.includes("ANSWERMARKER"));
    expect(reprintIndex).toBeGreaterThan(lastFlipIndex);
    i.unmount();
  }, 15000);
});

/**
 * #1489: answering a tool permission closes the modal while the turn keeps
 * settling, and the flip back to the main buffer comes ALT_FLIP_DELAY_MS
 * after the close. What settled meanwhile — blocks that closed while the
 * modal was open, the tool result, the follow-up reply — used to print into
 * the dying alternate buffer, and ink's line count after the flip described
 * the last frame painted there rather than the one the main buffer shows.
 * Which rows survived the cycle therefore depended on whether the turn
 * settled before or after the flip. Here the order is the test's choice: the
 * same permission turn runs once free (on an idle machine it settles inside
 * the flip window) and once with the reply held until the flip is written.
 * The terminal history must be the same in both, with every block once and
 * in order below the history printed before the modal opened.
 *
 * Seam: the full App on the in-process fake terminal (ADR-0057 level 1),
 * whose screen model keeps the main and alternate buffers apart (DECSET
 * 1049) — what the ink-testing-library frames above cannot show.
 */
describe("blocks settling around the alternate-screen close (#1489)", () => {
  /** What the user can scroll back through: native scrollback, then the screen. */
  const historyOf = (term: FakeTerminal) => [...term.screen.scrollback(), ...term.screen.lines()];
  /** Per-run values: the prompt hash, the temp project path, the session id and the tool's wall-clock duration. */
  const normalized = (rows: readonly string[]) => rows.map((row) => row
    .replace(/prompt [0-9a-f]{8}/, "prompt <hash>")
    .replace(/▣ .* ◉/, "▣ <cwd> ◉")
    .replace(/session-[0-9a-f]{8}/, "<session>")
    .replace(/· \d+s$/, "· <duration>"));

  async function permissionTurn(replyAfterFlip: boolean): Promise<string[]> {
    const cwd = mkdtempSync(join(tmpdir(), "moh-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    grantTeamExtension(home);
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ permissions: { overrides: { tools: { bash: "ask" } } } }));
    writeFileSync(userConfigFile(home), JSON.stringify({ onboarded: true, workflowOffered: true, mode: "dev", updateCheck: false }));
    let flipped!: () => void;
    const flip = new Promise<void>((resolve) => { flipped = resolve; });
    const provider = MockProvider.scripted([
      { deltas: ["ASKMARKER asking\n"], finish: "tool_calls", toolCalls: [{ name: "bash", args: { command: "echo permissioned" } }] },
      { deltas: ["ALLOWEDMARKER"], finish: "stop", ...(replyAfterFlip ? { hold: { afterDeltas: 0, release: flip } } : {}) },
    ]);
    // Home, not startInChat: only a session opened from Home is wired to the App's permission gate.
    const term = renderOnFakeTty(<App intro={false} cwd={cwd} home={home} provider={provider} env={{}} skipOnboarding />, { cols: 100, rows: 30 });
    const view = { lastFrame: () => term.screen.lines().join("\n") };
    const onScreen = (text: string) => view.lastFrame().includes(text);
    try {
      await waitStep(view, () => onScreen("New session"), "home mounted", { timeoutMs: 10_000 });
      term.write("run it");
      await waitStep(view, () => onScreen("start “run it”"), "the prompt typed on home");
      term.write("\r");
      await waitStep(view, () => onScreen("a always"), "the permission modal opened", { timeoutMs: 10_000 });
      const answeredAt = term.rawBytes().length;
      const since = () => term.rawBytes().subarray(answeredAt).toString("utf8");
      // The held reply is released by the very write that flips back.
      term.stdout.on("write", (chunk: Buffer) => { if (chunk.includes("\x1b[?1049l")) flipped(); });
      term.write("y");
      await waitStep(view, () => since().includes("\x1b[?1049l") && since().includes("✓ done"), "the flip back and the finished turn", { timeoutMs: 10_000 });
      await term.settle();
      return normalized(historyOf(term));
    } finally {
      await term.unmount();
    }
  }

  test("the history is the same whether the turn settles before or after the flip", async () => {
    const free = await permissionTurn(false);
    const held = await permissionTurn(true);
    expect(held).toEqual(free);
    const text = free.join("\n");
    const count = (needle: string) => text.split(needle).length - 1;
    const blocks = ["run it", "ASKMARKER", "✓ bash echo permissioned", "◌ permission bash · requested", "✓ permission bash · allowed (user)", "ALLOWEDMARKER", "for everything you need"];
    expect(blocks.map((needle) => [needle, count(needle)])).toEqual(blocks.map((needle) => [needle, 1]));
    // In order, below what was printed before the modal opened, the session frame last…
    const rows = ["◈ extension loaded team", ...blocks].map((needle) => free.findIndex((row) => row.includes(needle)));
    expect(rows).not.toContain(-1);
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
    // …and no row left behind by a frame painted before the flip (a running glyph).
    expect(text).not.toMatch(/[◔◑◕●] (bash|permission)/);
  }, 60_000);
});

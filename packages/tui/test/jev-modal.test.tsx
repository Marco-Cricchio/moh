/**
 * #833: the `/jev` modal — the session-warm control surface for the seven
 * Jev use cases (#832). What these tests pin: the modal shows the live state
 * the extension reports (never a guess), a flip sends exactly one command
 * and re-reads the state, every change says it is session-only and what the
 * config still says, and a refusal is shown as a refusal. No extension, no
 * session, no network: the two seams are injected.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import type { JevUseCase, JevUseCaseAction, JevUseCaseSnapshot, JevUseCaseState } from "@moh/jev-guard";
import { JEV_USE_CASES } from "@moh/jev-guard";
import { JevModal, flipOutcome, sessionOnlyNote } from "../src/JevModal";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A full snapshot with everything off but the given overrides. */
function snapshot(overrides: Partial<Record<JevUseCase, JevUseCaseState>> = {}): JevUseCaseSnapshot {
  const out = {} as Record<JevUseCase, JevUseCaseState>;
  for (const usecase of JEV_USE_CASES) out[usecase] = { status: "off", config: false };
  return { ...out, ...overrides };
}

/**
 * A stand-in for the extension: it holds a snapshot, records the commands it
 * receives, and answers a re-read with whatever the test told it to answer
 * (that is how a refusal is expressed — the state simply did not move).
 */
function extension(initial: JevUseCaseSnapshot, after?: (usecase: JevUseCase, action: JevUseCaseAction) => JevUseCaseSnapshot | undefined) {
  let current = initial;
  const commands: { usecase: JevUseCase; action: JevUseCaseAction }[] = [];
  return {
    commands,
    read: (_extension: string, key: string) => (key === "jevState" ? () => current : undefined),
    send: (usecase: JevUseCase, action: JevUseCaseAction) => {
      commands.push({ usecase, action });
      const next = after?.(usecase, action);
      if (next) current = next;
    },
  };
}

function mount(props: { active?: boolean; read?: (extension: string, key: string) => unknown; send?: (u: JevUseCase, a: JevUseCaseAction) => void; onClose?: () => void } = {}) {
  let closed = 0;
  const i = render(
    <ThemeProvider value={THEMES[DEFAULT_THEME]}>
      <JevModal
        active={props.active ?? true}
        read={props.read as ((extension: string, key: string) => unknown) | undefined}
        send={props.send}
        onClose={() => {
          closed += 1;
          props.onClose?.();
        }}
      />
    </ThemeProvider>,
  );
  return { i, closed: () => closed };
}

const down = async (i: ReturnType<typeof render>, n: number) => {
  for (let k = 0; k < n; k++) {
    i.stdin.write("\x1b[B");
    await sleep(25);
  }
};

describe("the /jev modal (#833)", () => {
  test("renders all seven use cases with their live status", async () => {
    const ext = extension(
      snapshot({
        guardrail: { status: "on", config: true },
        routing: { status: "paused", config: true, note: "suspended — you picked the model by hand (auto hands it back)" },
        injection: { status: "off", config: false, note: "off in the config" },
        skills: { status: "inert", config: false, note: "not available in this session" },
      }),
    );
    const { i } = mount(ext);
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    for (const usecase of JEV_USE_CASES) expect(frame).toContain(usecase);
    expect(frame).toContain("guardrail");
    expect(frame).toContain("on");
    expect(frame).toContain("paused");
    expect(frame).toContain("inert");
    // The session-vs-config split is stated on the surface itself.
    expect(frame.replace(/[\s│]+/g, " ")).toContain("this session only");
    expect(frame).toContain("config on");
    expect(frame).toContain("config off");
    i.unmount();
  });

  test("enter flips the row under the cursor: one command, and the state it caused", async () => {
    const ext = extension(snapshot(), (usecase, action) =>
      snapshot({ [usecase]: { status: action === "on" ? "on" : "off", config: false, sessionOnly: true } }),
    );
    const { i } = mount(ext);
    await sleep(30);
    // Cursor starts on guardrail; two rows down is routing.
    await down(i, 1);
    i.stdin.write("\r");
    // The report is composed from the extension's answer, one dispatch later.
    await sleep(80);
    expect(ext.commands).toEqual([{ usecase: "routing", action: "on" }]);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame.replace(/[\s│]+/g, " ")).toContain("routing: on for this session");
    // The asymmetry, in the extension's own words.
    expect(frame.replace(/[\s│]+/g, " ")).toContain("the config still says off");
    i.unmount();
  });

  test("a use case that is on is flipped off; `paused` is resumed", async () => {
    const ext = extension(
      snapshot({ guardrail: { status: "on", config: true }, routing: { status: "paused", config: true } }),
      (usecase, action) => snapshot({ [usecase]: { status: action === "on" ? "on" : "off", config: true, sessionOnly: true } }),
    );
    const { i } = mount(ext);
    await sleep(30);
    i.stdin.write("\r"); // guardrail: on → off
    await sleep(30);
    await down(i, 1);
    i.stdin.write(" "); // routing: paused → on (space flips too)
    await sleep(30);
    expect(ext.commands).toEqual([
      { usecase: "guardrail", action: "off" },
      { usecase: "routing", action: "on" },
    ]);
    i.unmount();
  });

  test("a refused guardrail `off` (yolo) reads as a refusal, not as a change", async () => {
    // The extension refuses: the state simply does not move.
    const ext = extension(snapshot({ guardrail: { status: "on", config: true } }));
    const { i } = mount(ext);
    await sleep(30);
    i.stdin.write("\r");
    // A refusal is decided only once the state had its chance to move.
    await sleep(140);
    expect(ext.commands).toEqual([{ usecase: "guardrail", action: "off" }]);
    const frame = stripAnsi(i.lastFrame() ?? "").replace(/[\s│]+/g, " ");
    expect(frame).toContain("guardrail: off refused — yolo keeps the lethal checks on");
    i.unmount();
  });

  test("an unavailable use case is refused with its own line", async () => {
    const ext = extension(snapshot({ skills: { status: "inert", config: false, note: "not available in this session" } }));
    const { i } = mount(ext);
    await sleep(30);
    await down(i, 6); // skills
    i.stdin.write("\r");
    await sleep(140);
    const frame = stripAnsi(i.lastFrame() ?? "").replace(/[\s│]+/g, " ");
    expect(frame).toContain("skills: refused — not available in this session");
    i.unmount();
  });

  test("with no extension the modal points at the Settings entry, never an invented state", async () => {
    const { i } = mount({ active: false, read: () => undefined });
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("not active in this session");
    expect(frame.replace(/[\s│]+/g, " ")).toContain("settings (ctrl+s) → Jev (TypeSafe) → API key");
    // No use-case row is rendered: there is no state to report.
    expect(frame).not.toContain("guardrail");
    i.unmount();
  });

  test("an extension that has not answered yet says so instead of guessing", async () => {
    const { i } = mount({ read: () => undefined });
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("still starting");
    i.unmount();
  });

  test("esc closes; r re-reads the state", async () => {
    let current = snapshot();
    const ext = extension(current);
    const { i, closed } = mount({
      read: (_e, key) => (key === "jevState" ? () => current : undefined),
      send: ext.send,
    });
    await sleep(30);
    // The extension moved behind the modal's back (another client, a turn).
    current = snapshot({ injection: { status: "on", config: false, sessionOnly: true } });
    i.stdin.write("r");
    await sleep(30);
    // Per non-persistent state, the row says so — the whole point of the
    // modal being session-warm (#833).
    expect(stripAnsi(i.lastFrame() ?? "").replace(/[\s│]+/g, " ")).toContain(
      "on for this session — the config still says off",
    );
    i.stdin.write("\x1b");
    await sleep(30);
    expect(closed()).toBe(1);
    i.unmount();
  });
});

describe("the flip's one-line report (#833)", () => {
  const off: JevUseCaseState = { status: "off", config: false };
  const on: JevUseCaseState = { status: "on", config: true };

  test("a session-only change names the config's own value", () => {
    expect(flipOutcome("injection", "on", off, { status: "on", config: false, sessionOnly: true })).toBe(
      "injection: on for this session — the config still says off",
    );
    expect(flipOutcome("classification", "off", on, { status: "off", config: true, sessionOnly: true })).toBe(
      "classification: off for this session — the config still says on",
    );
  });

  test("a change that matches the config claims no asymmetry", () => {
    expect(flipOutcome("lint", "on", off, { status: "on", config: true })).toBe("lint: on for this session");
  });

  test("the extension's own note wins when it has one", () => {
    expect(
      flipOutcome("routing", "on", off, { status: "on", config: false, sessionOnly: true, note: "off in the config" }),
    ).toBe("routing: on for this session — off in the config");
  });

  test("a refusal is a state that did not move — and only then", () => {
    expect(flipOutcome("guardrail", "off", on, { status: "on", config: true })).toBe(
      "guardrail: off refused — yolo keeps the lethal checks on",
    );
    expect(
      flipOutcome("skills", "on", { status: "inert", config: false }, { status: "inert", config: false }),
    ).toBe("skills: refused — not available in this session");
    // A use case that simply did not move, for a reason this surface does
    // not know: say that, instead of inventing a cause.
    expect(flipOutcome("rerank", "on", off, { status: "off", config: false })).toBe(
      "rerank: not applied — the extension kept it off",
    );
  });

  test("a guardrail `off` that WAS applied reports the change, not a yolo refusal", () => {
    // The regression this guards: composing the sentence from a read taken
    // before the extension answered made every guardrail `off` look refused.
    expect(flipOutcome("guardrail", "off", on, { status: "off", config: true, sessionOnly: true })).toBe(
      "guardrail: off for this session — the config still says on",
    );
  });
});

describe("the flip's answer arrives with the extension's, not before it (#833)", () => {
  test("no sentence is composed while the state the command was sent against is still the current one", async () => {
    // The extension answers one dispatch later, so `read` keeps returning the
    // pre-command snapshot for a moment (this is the real timing, not a
    // stub's): nothing must be claimed until the answer is there.
    let current = snapshot({ injection: { status: "off", config: false } });
    let answered = false;
    const { i } = mount({
      read: (_e, key) => (key === "jevState" ? () => current : undefined),
      send: () => {
        // The answer lands after the modal's read beat, not before it.
        setTimeout(() => {
          current = snapshot({ injection: { status: "on", config: false, sessionOnly: true } });
          answered = true;
        }, 20);
      },
    });
    await sleep(30);
    await down(i, 3); // injection
    i.stdin.write("\r");
    await sleep(10); // the read beat (0ms) may already have run, the answer has not
    // Nothing was invented from the pre-command state.
    expect(stripAnsi(i.lastFrame() ?? "")).not.toContain("not applied");
    await sleep(60);
    expect(answered).toBe(true);
    const frame = stripAnsi(i.lastFrame() ?? "").replace(/[\s│]+/g, " ");
    expect(frame).toContain("injection: on for this session — the config still says off");
    i.unmount();
  });
});

describe("the session-only marker a row shows (#833)", () => {
  test("says the asymmetry only when the state is not the config's", () => {
    expect(sessionOnlyNote({ status: "on", config: false, sessionOnly: true })).toBe(
      "on for this session — the config still says off",
    );
    expect(sessionOnlyNote({ status: "off", config: true, sessionOnly: true })).toBe(
      "off for this session — the config still says on",
    );
    // Nothing session-only, or the extension gave its own note in the row.
    expect(sessionOnlyNote({ status: "on", config: true })).toBeNull();
    expect(sessionOnlyNote({ status: "on", config: false, sessionOnly: true, note: "off in the config" })).toBeNull();
  });
});

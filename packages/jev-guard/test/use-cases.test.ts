/**
 * #832: the uniform control surface, on its own — no ctx, no fetch. What
 * this pins is the vocabulary a client reads (the snapshot) and the
 * answers it gets (the outcome of one command), especially the cases that
 * must never be silent: an unavailable use case, an action that belongs to
 * routing only, an unknown name, and the guardrail in yolo.
 */
import { describe, expect, test } from "bun:test";
import {
  JEV_USE_CASES,
  createUseCaseControl,
  type JevUseCase,
  type UseCaseControlDeps,
} from "../src/use-cases";

/** Every use case on, every dependency present: the baseline a test tilts. */
const all = (value: boolean): Record<JevUseCase, boolean> =>
  Object.fromEntries(JEV_USE_CASES.map((u) => [u, value])) as Record<JevUseCase, boolean>;

function control(overrides: Partial<UseCaseControlDeps> = {}) {
  let mode = "normal";
  const router = {
    paused: false,
    override: false,
    inert: false,
    actions: [] as string[],
  };
  const ctl = createUseCaseControl({
    config: all(false),
    available: all(true),
    mode: () => mode,
    routing: {
      control: (action) => {
        router.actions.push(action);
        if (action === "off") router.paused = true;
        if (action === "on") {
          router.paused = false;
          router.override = false;
        }
        if (action === "auto") router.override = false;
      },
      state: () => ({ paused: router.paused, override: router.override }),
      inert: () => router.inert,
    },
    ...overrides,
  });
  return { ctl, router, setMode: (m: string) => (mode = m) };
}

describe("the uniform snapshot (#832)", () => {
  test("all seven use cases, in the canonical order, with the config contrast", () => {
    const { ctl } = control({ config: { ...all(false), classification: true } });
    const snapshot = ctl.snapshot();
    expect(Object.keys(snapshot)).toEqual([...JEV_USE_CASES]);
    expect(snapshot.classification).toEqual({ status: "on", config: true });
    expect(snapshot.injection).toEqual({ status: "off", config: false, note: "off in the config" });
  });

  test("a warm command marks the state session-only and says so", () => {
    const { ctl } = control();
    expect(ctl.command("injection", "on")?.refused).toBeUndefined();
    expect(ctl.state("injection")).toEqual({ status: "on", config: false, sessionOnly: true });
    // Flipping back to the config's own value removes the marker: nothing
    // session-only is left to report.
    ctl.command("injection", "off");
    expect(ctl.state("injection")).toEqual({ status: "off", config: false, note: "off in the config" });
  });

  test("a use case whose dependency the session lacks is inert, and says why", () => {
    const { ctl } = control({ available: { ...all(true), skills: false } });
    expect(ctl.state("skills")).toEqual({
      status: "inert",
      config: false,
      note: "not available in this session",
    });
    expect(ctl.isOn("skills")).toBe(false);
    expect(ctl.command("skills", "on")).toMatchObject({ refused: "unavailable" });
    // ...and the refusal left the state exactly where it was.
    expect(ctl.state("skills").status).toBe("inert");
  });

  test("routing reports its own pause, its manual override and its inert assignment", () => {
    const { ctl, router } = control({ config: { ...all(false), routing: true } });
    expect(ctl.state("routing")).toEqual({ status: "on", config: true });
    expect(ctl.isOn("routing")).toBe(true);

    router.paused = true;
    expect(ctl.state("routing")).toMatchObject({ status: "paused", note: "paused for this session" });
    expect(ctl.isOn("routing")).toBe(false);

    router.paused = false;
    router.override = true;
    expect(ctl.state("routing")).toMatchObject({ status: "paused" });
    expect(String(ctl.state("routing").note)).toContain("picked the model by hand");

    router.override = false;
    router.inert = true;
    expect(ctl.state("routing")).toMatchObject({ status: "inert" });
    expect(ctl.isOn("routing")).toBe(false);
  });
});

describe("commands (#832)", () => {
  test("on/off flip the live state without touching the config", () => {
    const { ctl } = control({ config: { ...all(false), injection: true } });
    expect(ctl.isOn("injection")).toBe(true);
    expect(ctl.command("injection", "off")).toMatchObject({ state: { status: "off", config: true, sessionOnly: true } });
    expect(ctl.isOn("injection")).toBe(false);
    expect(ctl.command("injection", "on")).toMatchObject({ state: { status: "on", config: true } });
    expect(ctl.isOn("injection")).toBe(true);
  });

  test("routing's actions reach the router and the live state follows", () => {
    const { ctl, router } = control({ config: { ...all(false), routing: false } });
    expect(ctl.isOn("routing")).toBe(false);
    expect(ctl.command("routing", "on")).toMatchObject({ state: { status: "on", config: false, sessionOnly: true } });
    expect(router.actions).toEqual(["on"]);
    expect(ctl.isOn("routing")).toBe(true);

    // `auto` releases an override without touching the on/off state.
    ctl.command("routing", "auto");
    expect(router.actions).toEqual(["on", "auto"]);
    expect(ctl.state("routing")).toMatchObject({ status: "on", sessionOnly: true });
  });

  test("a name that is not one of the seven is nobody's command", () => {
    const { ctl } = control();
    expect(ctl.command("teleport", "on")).toBeNull();
  });

  test("an unknown action is refused, and the state is read, not guessed", () => {
    const { ctl } = control({ config: { ...all(false), lint: true } });
    expect(ctl.command("lint", "maybe")).toEqual({
      usecase: "lint",
      action: "maybe",
      state: { status: "on", config: true },
      refused: "unknown-action",
    });
  });

  test("`auto` outside routing is refused as unsupported", () => {
    const { ctl } = control();
    expect(ctl.command("skills", "auto")).toMatchObject({ refused: "unsupported" });
    expect(ctl.state("skills").status).toBe("off");
  });
});

describe("the guardrail in yolo (#832, #850)", () => {
  // The guardrail has no config opt-in: the extension hands the controller
  // `config: { guardrail: true }` (a stored key *is* the switch).
  const guardrailOn = { ...all(false), guardrail: true };

  test("off is honoured in yolo: session-warm, visible, and reversible (#850)", () => {
    const { ctl, setMode } = control({ config: guardrailOn });
    setMode("yolo");
    expect(ctl.command("guardrail", "off")).toEqual({
      usecase: "guardrail",
      action: "off",
      state: { status: "off", config: true, sessionOnly: true, note: "off for this session" },
    });
    expect(ctl.isOn("guardrail")).toBe(false);

    // Back on: the yolo narrowing returns, visibly.
    expect(ctl.command("guardrail", "on")).toMatchObject({
      state: { status: "on", config: true, note: "yolo — the lethal checks only" },
    });
    expect(ctl.isOn("guardrail")).toBe(true);
  });

  test("off is honoured outside yolo, and the line says the switch is not persistent", () => {
    const { ctl } = control({ config: guardrailOn });
    expect(ctl.command("guardrail", "off")).toMatchObject({
      state: { status: "off", config: true, sessionOnly: true },
    });
    expect(ctl.isOn("guardrail")).toBe(false);
  });

  test("in yolo the armed state itself reports the narrowing", () => {
    const { ctl, setMode } = control({ config: guardrailOn });
    setMode("yolo");
    expect(ctl.state("guardrail")).toEqual({ status: "on", config: true, note: "yolo — the lethal checks only" });
  });

  test("a mode rotation never silently re-arms a disarmed guardrail (#850)", () => {
    const { ctl, setMode } = control({ config: guardrailOn });
    setMode("yolo");
    ctl.command("guardrail", "off");
    setMode("normal");
    expect(ctl.isOn("guardrail")).toBe(false);
    expect(ctl.state("guardrail")).toMatchObject({ status: "off", sessionOnly: true });
    setMode("yolo");
    expect(ctl.isOn("guardrail")).toBe(false);
  });
});

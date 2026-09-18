import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMohConfig, readUserProviderConfig, upsertUserEndpoint } from "@moh/core";
import { SettingsPanel } from "../src/SettingsPanel";
import { DEFAULT_USER_CONFIG, type UserConfig } from "../src/user-config";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { actUntilFrame, stripAnsi, waitForCondition, waitForFrame } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setupCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "moh-set-"));
  writeFileSync(
    join(cwd, "moh.json"),
    JSON.stringify({
      provider: "anthropic/claude-sonnet-4-5",
      endpoints: [
        { name: "anthropic", type: "anthropic", defaultModel: "claude-sonnet-4-5" },
        { name: "openai", type: "openai", defaultModel: "gpt-5" },
      ],
    }),
  );
  return cwd;
}

function mount(cwd: string, overrides: Partial<Parameters<typeof SettingsPanel>[0]> = {}) {
  const changes: Partial<UserConfig>[] = [];
  const switched: string[] = [];
  const toasts: string[] = [];
  let wizard = 0;
  const testHome = overrides.home ?? mkdtempSync(join(tmpdir(), "moh-home-"));
  const props = {
    cwd,
    home: testHome,
    config: DEFAULT_USER_CONFIG,
    onChange: (patch: Partial<UserConfig>) => changes.push(patch),
    modelLabel: "anthropic/claude-sonnet-4-5",
    onProviderSwitch: (ref: string) => switched.push(ref),
    onStartWizard: () => (wizard += 1),
    onConfigureHandoff: () => {},
    onToast: (t: string) => toasts.push(t),
    onClose: () => {},
    ...overrides,
  };
  const i = render(
    <ThemeProvider value={THEMES[DEFAULT_THEME]}>
      <SettingsPanel {...props} />
    </ThemeProvider>,
  );
  return { i, changes, switched, toasts, wizardCount: () => wizard };
}

const down = async (i: ReturnType<typeof render>, n: number) => {
  for (let k = 0; k < n; k++) {
    i.stdin.write("\x1b[B");
    await sleep(30);
  }
};

describe("settings panel ToS card (#444)", () => {
  test("pressing t on an endpoint shows the full ToS card with disclaimer, links and verification date", async () => {
    const cwd = setupCwd();
    const { i } = mount(cwd);
    await sleep(30);
    await down(i, 8); // Provider row
    i.stdin.write("\r");
    await sleep(30);
    i.stdin.write("t"); // ToS for mock: toast, no card
    await sleep(30);
    let frame = stripAnsi(i.lastFrame() ?? "");
    // First row is mock: no bundled card, just a toast.
    expect(frame).not.toContain("Machine-written informational summary");
    await down(i, 1); // anthropic endpoint
    i.stdin.write("t");
    await sleep(30);
    frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("Machine-written informational summary"); // disclaimer
    expect(frame).toContain("Terms of Service — anthropic (verified 2026-09)");
    expect(frame).toContain("Terms of Service: https://www.anthropic.com/legal/com…");
    expect(frame).toContain("Data retention:");
    i.stdin.write("\x1b"); // back
    await sleep(30);
    frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("anthropic"); // endpoint list again
    i.unmount();
  });
});

describe("settings panel (issue #33)", () => {
  test("renders every setting row with current values", async () => {
    const i = mount(setupCwd());
    await sleep(30);
    const frame = stripAnsi(i.i.lastFrame() ?? "");
    for (const label of [
      "Mode",
      "Theme",
      "Icons",
      "File preview",
      "Answer language",
      "Telemetry",
      "Default permission mode",
      "Provider",
      "Add provider",
      "Remove provider",
      "Jev (TypeSafe)",
    ]) {
      expect(frame).toContain(label);
    }
    expect(frame).toContain("vibe");
    expect(frame).toContain("Tokyo Night");
    // The list scrolls: the rows below the fold are reachable, not missing.
    await down(i.i, 16);
    expect(stripAnsi(i.i.lastFrame() ?? "")).toContain("Provider reasoning");
    i.i.unmount();
  });

  test("enter toggles fields and persists via onChange", async () => {
    const { i, changes } = mount(setupCwd());
    await sleep(30);
    i.stdin.write("\r"); // mode → dev
    await sleep(10);
    await down(i, 1);
    i.stdin.write("\r"); // theme → opens the theme picker
    await sleep(30);
    i.stdin.write("\x1b[B"); // catppuccin
    await sleep(30);
    i.stdin.write("\r"); // apply catppuccin (picker closes, cursor stays on theme row)
    await sleep(30);
    await down(i, 2);
    i.stdin.write("\r"); // icons off (row 3)
    await sleep(10);
    await down(i, 3);
    i.stdin.write("\r"); // telemetry on (row 6 after Themes… insert)
    await sleep(10);
    await down(i, 3);
    i.stdin.write("\r"); // telemetry on (row 5)
    await sleep(10);
    expect(changes).toContainEqual({ mode: "dev" });
    expect(changes).toContainEqual({ theme: "catppuccin" });
    expect(changes).toContainEqual({ icons: false });
    expect(changes).toContainEqual({ telemetry: true });
    i.unmount();
  });

  test("Session handoff shows its project transport state and opens its chooser", async () => {
    const cwd = setupCwd();
    let opened = 0;
    const { i } = mount(cwd, { onConfigureHandoff: () => { opened += 1; } });
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Session handoff");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Not Set");
    await down(i, 12); // Session handoff (the Jev entry sits at 11, #784)
    i.stdin.write("\r");
    await sleep(30);
    expect(opened).toBe(1);
    i.unmount();
  });

  test("provider reasoning sets the persisted global display default", async () => {
    const { i, changes } = mount(setupCwd());
    await sleep(30);
    await down(i, 16); // Provider reasoning (Themes… + Jev rows inserted, #784)
    i.stdin.write("\r");
    await sleep(10);
    expect(changes).toContainEqual({ showReasoning: true });
    i.unmount();
  });

  test("provider switch is hierarchical: endpoint → model, rewrites defaultModel + provider in moh.json", async () => {
    const cwd = setupCwd();
    const { i, switched, toasts } = mount(cwd);
    await sleep(30);
    await down(i, 8); // Provider row
    i.stdin.write("\r");
    await sleep(30);
    let frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("mock");
    expect(frame).toContain("anthropic");
    expect(frame).toContain("openai");
    await down(i, 2); // openai endpoint
    i.stdin.write("\r");
    await sleep(30);
    frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("ctx "); // model rows with context windows
    // type a model id → the free-text row commits it
    i.stdin.write("gpt-5.4");
    await sleep(30);
    i.stdin.write("\x1b[B"); // gpt-5.4-mini
    await sleep(30);
    i.stdin.write("\x1b[B"); // the free-text row (catalog rows first)
    await sleep(30);
    i.stdin.write("\r");
    await sleep(30);
    expect(switched).toEqual(["openai/gpt-5.4"]);
    expect(toasts.some((t) => t.includes("openai/gpt-5.4"))).toBe(true);
    const config = loadMohConfig(join(cwd, "moh.json"));
    expect(config.provider).toBe("openai/gpt-5.4");
    expect(config.endpoints?.find((e) => e.name === "openai")?.defaultModel).toBe("gpt-5.4");
    i.unmount();
  });

  test("typing in the model level filters the catalog incrementally", async () => {
    const cwd = setupCwd();
    const { i } = mount(cwd);
    await sleep(30);
    await down(i, 8);
    i.stdin.write("\r");
    await sleep(30);
    await down(i, 2); // openai
    i.stdin.write("\r");
    await sleep(30);
    i.stdin.write("mini");
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("gpt-5.4-mini");
    expect(frame).not.toContain("gpt-5.5");
    i.unmount();
  });

  test("provider remove deletes the endpoint from moh.json", async () => {
    const cwd = setupCwd();
    const { i, toasts } = mount(cwd);
    await sleep(30);
    await down(i, 10); // Remove provider row
    i.stdin.write("\r");
    await sleep(30);
    await down(i, 1); // openai
    await sleep(30); // let Ink commit the submenu cursor before selecting
    i.stdin.write("\r");
    await sleep(30);
    const config = loadMohConfig(join(cwd, "moh.json"));
    expect(config.endpoints?.map((e) => e.name)).toEqual(["anthropic"]);
    expect(toasts.some((t) => t.includes("removed endpoint openai"))).toBe(true);
    i.unmount();
  });

  test("removing the active endpoint resets the default provider to a remaining one", async () => {
    const cwd = setupCwd();
    const { i } = mount(cwd);
    await sleep(30);
    await down(i, 10);
    i.stdin.write("\r");
    await sleep(30);
    i.stdin.write("\r"); // first option = anthropic (the active one)
    await sleep(30);
    expect(loadMohConfig(join(cwd, "moh.json")).provider).toBe("openai/gpt-5");
    i.unmount();
  });

  test("add provider opens the wizard overlay", async () => {
    const h = mount(setupCwd());
    await sleep(30);
    await down(h.i, 9); // Add provider row (mode0 theme1 themes2 icons3 preview4 lang5 telemetry6 perm7)
    h.i.stdin.write("\r");
    await sleep(30);
    expect(h.wizardCount()).toBe(1);
    h.i.unmount();
  });

  test("esc closes; submenus back out with esc first", async () => {
    let closed = 0;
    const { i } = mount(setupCwd(), { onClose: () => (closed += 1) });
    await sleep(30);
    await down(i, 8);
    i.stdin.write("\r");
    await sleep(30);
    i.stdin.write("\x1b"); // leave submenu, not the panel
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("enter change · esc close");
    expect(closed).toBe(0);
    i.stdin.write("\x1b");
    await sleep(30);
    expect(closed).toBe(1);
    i.unmount();
  });
});

describe("merged provider endpoints (#129)", () => {
  test("provider switch list includes user-level endpoints (display-only)", async () => {
    const cwd = setupCwd();
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    upsertUserEndpoint(join(home, ".moh", "config"), {
      name: "zai",
      type: "openai-compat",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      defaultModel: "glm-5.3",
      apiKey: "key",
    });
    const { i } = mount(cwd, { home });
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await sleep(30);
    await down(i, 8);
    i.stdin.write("\r");
    await waitForFrame(frame, "switch endpoint");
    // Wait for each React commit before the next key: under suite load a
    // fixed 30ms pause can drop one arrow and leave the cursor on openai.
    for (const endpoint of ["anthropic", "openai", "zai (user)"]) {
      // Under CI load an arrow can be dropped while the list is scrollable
      // (↓ n more): repeat the key until the cursor lands (actUntilFrame).
      await actUntilFrame(() => i.stdin.write("\x1b[B"), frame, `› ${endpoint}`);
    }
    expect(frame()).toContain("zai (user)");
    i.unmount();
  });

  test("picking a model on a user openai-compat endpoint fetches the live list and switches only the provider ref", async () => {
    const cwd = setupCwd();
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    const userFile = join(home, ".moh", "config");
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ data: [{ id: "glm-5.3" }, { id: "glm-5.3-air" }] });
      },
    });
    upsertUserEndpoint(userFile, {
      name: "zai",
      type: "openai-compat",
      baseUrl: `http://localhost:${server.port}/v1`,
      defaultModel: "glm-5.3",
      apiKey: "key",
    });
    try {
      const { i, switched } = mount(cwd, { home });
      await sleep(30);
      await down(i, 8);
      i.stdin.write("\r");
      await sleep(30);
      await down(i, 3); // zai (user)
      i.stdin.write("\r");
      await sleep(30);
      // model level: fetched list arrives asynchronously
      await sleep(120);
      const frame = stripAnsi(i.lastFrame() ?? "");
      expect(frame).toContain("glm-5.3-air");
      i.stdin.write("air");
      await sleep(30);
      i.stdin.write("\x1b[B"); // free-text row (filter narrowed to nothing)
      await sleep(30);
      i.stdin.write("\r");
      await sleep(30);
      expect(switched).toEqual(["zai/air"]);
      expect(loadMohConfig(join(cwd, "moh.json")).provider).toBe("zai/air");
      // user endpoint: its defaultModel is never rewritten here
      expect(readUserProviderConfig(userFile).endpoints?.find((e) => e.name === "zai")?.defaultModel).toBe("glm-5.3");
      expect(loadMohConfig(join(cwd, "moh.json")).endpoints?.some((e) => e.name === "zai")).toBe(false);
      i.unmount();
    } finally {
      server.stop(true);
    }
  });

  test("removing a user-level endpoint updates user config", async () => {
    const cwd = setupCwd();
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    const userFile = join(home, ".moh", "config");
    upsertUserEndpoint(userFile, {
      name: "zai",
      type: "openai-compat",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      defaultModel: "glm-5.3",
      apiKey: "key",
    });
    const { i, toasts } = mount(cwd, { home });
    await sleep(30);
    await down(i, 10);
    i.stdin.write("\r");
    await sleep(30);
    await down(i, 2); // anthropic, openai, then zai
    i.stdin.write("\r");
    await sleep(30);
    expect(readUserProviderConfig(userFile).endpoints?.some((e) => e.name === "zai")).toBe(false);
    expect(toasts.some((t) => t.includes("removed endpoint zai"))).toBe(true);
    i.unmount();
  });
});

describe("max iterations row (#498)", () => {
  test("cycles presets forward on enter and persists to moh.json; unlimited shows warning once", async () => {
    const cwd = setupCwd();
    const { i, toasts } = mount(cwd);
    await sleep(30);
    // Rows: mode0 theme1 icons2 preview3 lang4 telemetry5 perm6
    // Rows: mode0 theme1 themes2 icons3 preview4 lang5 telemetry6 perm7
    // provider8 add9 remove10 jev11 handoff12 mpm13 maxIterations14 (#784)
    await down(i, 14);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Max iterations/turn");
    i.stdin.write("\r"); // 50 → 100
    await sleep(30);
    i.stdin.write("\r"); // 100 → 200
    await sleep(30);
    expect(loadMohConfig(join(cwd, "moh.json")).maxIterations).toBe(200);
    // → unlimited (three more: 300? no: 200 → 500 → unlimited)
    i.stdin.write("\r"); // 200 → 500
    await sleep(30);
    i.stdin.write("\r"); // 500 → unlimited
    await sleep(30);
    expect(loadMohConfig(join(cwd, "moh.json")).maxIterations).toBe(0);
    let frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("unlimited");
    expect(frame).toContain("anti-runaway");
    // Any keypress dismisses the warning; it stays dismissed on revisit.
    i.stdin.write("\x1b[B");
    await sleep(30);
    frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).not.toContain("anti-runaway");
    expect(toasts.some((t) => t.includes("unlimited"))).toBe(true);
    i.unmount();
  });

  test("cycles backward on shift+tab (wraps unlimited → 500)", async () => {
    const cwd = setupCwd();
    const { i } = mount(cwd);
    await sleep(30);
    await down(i, 14);
    await sleep(30);
    // shift+tab from 50 wraps back to unlimited (warning shows).
    i.stdin.write("\x1b[Z");
    await sleep(30);
    expect(loadMohConfig(join(cwd, "moh.json")).maxIterations).toBe(0);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("anti-runaway");
    i.stdin.write("\x1b[Z"); // unlimited → 500
    await sleep(30);
    expect(loadMohConfig(join(cwd, "moh.json")).maxIterations).toBe(500);
    i.unmount();
  });

  test("warning re-arms after leaving unlimited and returning", async () => {
    const cwd = setupCwd();
    const { i } = mount(cwd);
    await sleep(30);
    await down(i, 14);
    await sleep(30);
    i.stdin.write("\r"); // 50 → 100
    await sleep(30);
    i.stdin.write("\x1b[Z"); // back to 50 (dismiss-armed reset happens on non-unlimited)
    await sleep(30);
    i.stdin.write("\x1b[Z"); // 50 → unlimited (wrap): warning must appear
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("anti-runaway");
    i.unmount();
  });

  test("round-trips an existing unlimited config and shows the row value", async () => {
    const cwd = setupCwd();
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({
      provider: "anthropic/claude-sonnet-4-5",
      endpoints: [{ name: "anthropic", type: "anthropic", defaultModel: "claude-sonnet-4-5" }],
      maxIterations: 0,
    }));
    const { i } = mount(cwd);
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("unlimited");
    i.unmount();
  });
});

describe("max iterations row (#498) — right arrow", () => {
  test("→ cycles presets forward like enter", async () => {
    const cwd = setupCwd();
    const { i } = mount(cwd);
    await sleep(30);
    await down(i, 14);
    await sleep(30);
    i.stdin.write("\x1b[C"); // →: 50 → 100
    await sleep(30);
    expect(loadMohConfig(join(cwd, "moh.json")).maxIterations).toBe(100);
    i.stdin.write("\x1b[C"); // →: 100 → 200
    await sleep(30);
    expect(loadMohConfig(join(cwd, "moh.json")).maxIterations).toBe(200);
    i.unmount();
  });

  test("MPM row (ADR-0026): cycles inherit → on → off → inherit and persists to moh.json", async () => {
    const cwd = setupCwd();
    const { i, toasts } = mount(cwd);
    await sleep(30);
    // Rows: mode0 theme1 themes2 icons3 preview4 lang5 telemetry6 perm7 provider8 add9 remove10 jev11 handoff12 mpm13 (#784)
    await down(i, 13);
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Moh Project Map");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("inherit (global default)");
    // inherit → on: writes mpm.enabled true into moh.json.
    i.stdin.write("\r");
    await sleep(30);
    expect(loadMohConfig(join(cwd, "moh.json")).mpm?.enabled).toBe(true);
    expect(toasts.some((t) => t.includes("moh project map: on"))).toBe(true);
    // on → off.
    i.stdin.write("\r");
    await sleep(30);
    expect(loadMohConfig(join(cwd, "moh.json")).mpm?.enabled).toBe(false);
    // off → inherit: the mpm section is removed entirely.
    i.stdin.write("\r");
    await sleep(30);
    expect(loadMohConfig(join(cwd, "moh.json")).mpm).toBeUndefined();
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("inherit (global default)");
    i.unmount();
  });

  test("MPM row shows an existing explicit off as its starting state", async () => {
    const cwd = setupCwd();
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({
      provider: "anthropic/claude-sonnet-4-5",
      mpm: { enabled: false },
    }));
    const { i } = mount(cwd);
    await sleep(30);
    await down(i, 13);
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("off (this project)");
    i.unmount();
  });
});

describe("user themes in settings (#749)", () => {
  test("theme row opens a picker with source labels; enter applies a user:<id> ref", async () => {
    const cwd = setupCwd();
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    mkdirSync(join(home, ".moh", "themes"), { recursive: true });
    writeFileSync(join(home, ".moh", "themes", "my-violet.json"), JSON.stringify({
      version: 1, id: "my-violet", name: "My Violet", extends: "tokyo-night",
      colors: { accent: "#b983ff" },
    }));
    const { i, changes } = mount(cwd, { home });
    await sleep(30);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await down(i, 1);
    i.stdin.write("\r"); // open theme picker
    await waitForFrame(frame, "My Violet · personal");
    expect(frame()).toContain("· built-in");
    await down(i, 8); // first user theme (8 built-ins before it)
    i.stdin.write("\r");
    await waitForFrame(frame, "enter change · esc close");
    expect(changes).toContainEqual({ theme: "user:my-violet" });
    i.unmount();
  });

  test("My themes… opens the theme studio; sliders derive colors; naming saves & applies", async () => {
    const cwd = setupCwd();
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    const { i, changes, toasts } = mount(cwd, { home });
    await sleep(30);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await down(i, 2);
    i.stdin.write("\r"); // My themes… → studio modal (mode0 theme1 themes2)
    await waitForFrame(frame, "theme studio");
    // studio rows: hue(0) brightness(1) — adjust hue then rename+save
    i.stdin.write("\x1b[C"); await sleep(40); // hue +6°
    i.stdin.write("n"); await sleep(60); // name & save
    await waitForCondition(() => frame().includes("theme name:"), () => `for name prompt; frame: ${frame()}`);
    i.stdin.write("My Neon");
    await waitForCondition(() => frame().includes("My Neon"), () => `for name echo; frame: ${frame()}`);
    i.stdin.write("\r"); await sleep(60); // save & apply
    await waitForCondition(
      () => changes.some((c) => "theme" in c),
      () => `for theme change; toasts: ${JSON.stringify(toasts)}`,
    );
    expect(changes).toContainEqual({ theme: "user:my-neon" });
    expect(toasts.some((t) => t.includes("theme saved"))).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(home, ".moh", "themes", "my-neon.json"), "utf8")) as { id: string; name: string; colors: Record<string, string> };
    expect(onDisk.id).toBe("my-neon");
    expect(onDisk.name).toBe("My Neon");
    expect(onDisk.colors.accent).toMatch(/^#[0-9a-f]{6}$/);
    i.unmount();
  });

  test("studio: enter on an override row clears to auto and does NOT close the modal", async () => {
    const cwd = setupCwd();
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    const { i, changes } = mount(cwd, { home });
    await sleep(30);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await down(i, 2);
    i.stdin.write("\r");
    await waitForFrame(frame, "theme studio");
    await sleep(100); // the studio's useInput mounts a frame after its first paint
    i.stdin.write("s"); await sleep(60); // split on → focus lands on 'ok'
    await waitForCondition(() => frame().includes("split"), () => `for split; frame: ${frame()}`);
    expect(frame().includes("› ✓ ok")).toBe(true); // focus moved to the first override
    i.stdin.write("\x1b[C"); await sleep(60); // pick first basic color
    await waitForCondition(() => frame().includes("red"), () => `for red pick; frame: ${frame()}`);
    i.stdin.write("\r"); await sleep(80); // enter → back to auto, NOT close
    expect(frame()).toContain("theme studio");
    expect(frame()).toContain("auto");
    expect(changes.every((c) => !("theme" in c))).toBe(true); // nothing applied
    i.unmount();
  });

  test("studio: 'n' opens the name prompt from an override row; esc returns to the studio", async () => {
    const cwd = setupCwd();
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    const { i, changes } = mount(cwd, { home });
    await sleep(30);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await down(i, 2);
    i.stdin.write("\r");
    await waitForFrame(frame, "theme studio");
    i.stdin.write("s"); await sleep(60); // split mode, focus on 'ok' override
    i.stdin.write("n"); await sleep(60); // 'n' must NOT be swallowed here
    await waitForCondition(() => frame().includes("theme name:"), () => `for name prompt; frame: ${frame()}`);
    i.stdin.write("\x1b"); await sleep(60); // esc → back to the studio, not settings
    expect(frame()).toContain("theme studio");
    expect(changes.every((c) => !("theme" in c))).toBe(true);
    i.unmount();
  });

  test("studio: create a theme, then delete it from the manage view (r → d)", async () => {
    const cwd = setupCwd();
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    const { i, changes } = mount(cwd, { home });
    await sleep(30);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await down(i, 2);
    i.stdin.write("\r");
    await waitForFrame(frame, "theme studio");
    i.stdin.write("n"); await sleep(60);
    i.stdin.write("Temp");
    await waitForCondition(() => frame().includes("Temp"), () => `for name; frame: ${frame()}`);
    i.stdin.write("\r"); await sleep(60);
    await waitForCondition(() => changes.some((c) => "theme" in c), () => "for save");
    expect(existsSync(join(home, ".moh", "themes", "temp.json"))).toBe(true);
    // back into settings → studio → manage view → delete
    i.stdin.write("\x1b"); await sleep(40); // studio → settings
    i.stdin.write("\r"); await sleep(60); // settings → studio again
    i.stdin.write("r"); await sleep(60);
    await waitForCondition(() => frame().includes("my themes"), () => `for manage; frame: ${frame()}`);
    expect(frame()).toContain("Temp");
    i.stdin.write("d"); await sleep(80); // delete the active theme
    await waitForCondition(
      () => !existsSync(join(home, ".moh", "themes", "temp.json")),
      () => `for deletion; frame: ${frame()}`,
    );
    i.unmount();
  });

  test("studio: deleting the ACTIVE theme from manage view applies the base fallback", async () => {
    const cwd = setupCwd();
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    mkdirSync(join(home, ".moh", "themes"), { recursive: true });
    writeFileSync(join(home, ".moh", "themes", "live.json"), JSON.stringify({ version: 1, id: "live", name: "Live", extends: "candy", colors: {} }));
    const { i, changes } = mount(cwd, { home, config: { ...DEFAULT_USER_CONFIG, theme: "user:live" } });
    await sleep(30);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await down(i, 2);
    i.stdin.write("\r");
    await waitForFrame(frame, "theme studio");
    await sleep(100); // the studio's useInput mounts a frame after its first paint
    i.stdin.write("r");
    // wait for the manage view to actually LIST the theme, not just for the heading
    await waitForCondition(() => frame().includes("› Live"), () => `for manage list; frame: ${frame()}`);
    i.stdin.write("d");
    await waitForCondition(
      () => !existsSync(join(home, ".moh", "themes", "live.json")),
      () => `for deletion; frame: ${frame()}`,
      { timeoutMs: 10_000 },
    );
    expect(changes).toContainEqual({ theme: "candy" });
    i.unmount();
  });

  test("deleting the active user theme falls back to a built-in", async () => {
    const cwd = setupCwd();
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    mkdirSync(join(home, ".moh", "themes"), { recursive: true });
    writeFileSync(join(home, ".moh", "themes", "gone.json"), JSON.stringify({
      version: 1, id: "gone", name: "Gone", extends: "candy", colors: {},
    }));
    const { i, changes } = mount(cwd, { home, config: { ...DEFAULT_USER_CONFIG, theme: "user:gone" } });
    await sleep(30);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await down(i, 1);
    i.stdin.write("\r"); // picker
    await waitForFrame(frame, "Gone · personal");
    await down(i, 8); // Gone · personal
    i.stdin.write("d");
    await waitForFrame(frame, "enter change · esc close");
    expect(existsSync(join(home, ".moh", "themes", "gone.json"))).toBe(false);
    // #749: deleting the active theme falls back to its extends base, not a
    // hardcoded preset.
    expect(changes).toContainEqual({ theme: "candy" });
    i.unmount();
  });
});

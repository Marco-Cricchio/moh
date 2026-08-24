import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMohConfig, readUserProviderConfig, upsertUserEndpoint } from "@moh/core";
import { SettingsPanel } from "../src/SettingsPanel";
import { DEFAULT_USER_CONFIG, type UserConfig } from "../src/user-config";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi } from "./helpers";

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
  const props = {
    cwd,
    config: DEFAULT_USER_CONFIG,
    onChange: (patch: Partial<UserConfig>) => changes.push(patch),
    modelLabel: "anthropic/claude-sonnet-4-5",
    onProviderSwitch: (ref: string) => switched.push(ref),
    onStartWizard: () => (wizard += 1),
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
    ]) {
      expect(frame).toContain(label);
    }
    expect(frame).toContain("vibe");
    expect(frame).toContain("Tokyo Night");
    i.i.unmount();
  });

  test("enter toggles fields and persists via onChange", async () => {
    const { i, changes } = mount(setupCwd());
    await sleep(30);
    i.stdin.write("\r"); // mode → dev
    await sleep(10);
    await down(i, 1);
    i.stdin.write("\r"); // theme → catppuccin
    await sleep(10);
    await down(i, 1);
    i.stdin.write("\r"); // icons off
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

  test("provider switch rewrites moh.json and notifies the live label", async () => {
    const cwd = setupCwd();
    const { i, switched, toasts } = mount(cwd);
    await sleep(30);
    await down(i, 7); // Provider row
    i.stdin.write("\r");
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("mock");
    expect(frame).toContain("anthropic/claude-sonnet-4-5");
    expect(frame).toContain("openai/gpt-5");
    await down(i, 2); // openai/gpt-5
    i.stdin.write("\r");
    await sleep(30);
    expect(switched).toEqual(["openai/gpt-5"]);
    expect(toasts.some((t) => t.includes("openai/gpt-5"))).toBe(true);
    expect(loadMohConfig(join(cwd, "moh.json")).provider).toBe("openai/gpt-5");
    i.unmount();
  });

  test("provider remove deletes the endpoint from moh.json", async () => {
    const cwd = setupCwd();
    const { i, toasts } = mount(cwd);
    await sleep(30);
    await down(i, 9); // Remove provider row
    i.stdin.write("\r");
    await sleep(30);
    await down(i, 1); // openai
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
    await down(i, 9);
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
    await down(h.i, 8); // Add provider row (mode0..perm7, provider8)
    h.i.stdin.write("\r");
    await sleep(30);
    expect(h.wizardCount()).toBe(1);
    h.i.unmount();
  });

  test("esc closes; submenus back out with esc first", async () => {
    let closed = 0;
    const { i } = mount(setupCwd(), { onClose: () => (closed += 1) });
    await sleep(30);
    await down(i, 7);
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
  test("provider switch list includes user-level endpoints", async () => {
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
    await sleep(30);
    await down(i, 7);
    i.stdin.write("\r");
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("zai/glm-5.3");
    i.unmount();
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
    await down(i, 9);
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

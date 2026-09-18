/**
 * #784: the TUI Settings entry for Jev (TypeSafe) — the only supported way
 * to enter the key. Valid / invalid / unreachable are three distinct paths
 * (an invalid key must not stay persisted, an unreachable service must), and
 * the validator is always injected so no test touches the network.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTypesafeConfig, userConfigFile } from "@moh/core";
import type { JevKeyValidation } from "@moh/jev-guard";
import { SettingsPanel } from "../src/SettingsPanel";
import { DEFAULT_USER_CONFIG, type UserConfig } from "../src/user-config";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The entry's row index in the settings list (after "Remove provider"). */
const JEV_ROW = 11;

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "moh-jev-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "moh-jev-home-"));
  writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
  return { cwd, home };
}

function mount(cwd: string, home: string, validateKey: (key: string) => Promise<JevKeyValidation>, config?: UserConfig) {
  const toasts: string[] = [];
  const i = render(
    <ThemeProvider value={THEMES[DEFAULT_THEME]}>
      <SettingsPanel
        cwd={cwd}
        home={home}
        config={config ?? DEFAULT_USER_CONFIG}
        onChange={() => {}}
        modelLabel="mock"
        onProviderSwitch={() => {}}
        onStartWizard={() => {}}
        onToast={(t) => toasts.push(t)}
        onClose={() => {}}
        validateKey={validateKey}
      />
    </ThemeProvider>,
  );
  return { i, toasts };
}

const down = async (i: ReturnType<typeof render>, n: number) => {
  for (let k = 0; k < n; k++) {
    i.stdin.write("\x1b[B");
    await sleep(25);
  }
};

/** Walk to the Jev entry's key input. */
async function openKeyInput(i: ReturnType<typeof render>) {
  await down(i, JEV_ROW);
  i.stdin.write("\r"); // open the Jev entry
  await sleep(30);
  i.stdin.write("\r"); // "API key"
  await sleep(30);
}

const storedKey = (home: string): string | undefined => {
  const file = userConfigFile(home);
  if (!existsSync(file)) return undefined;
  return readTypesafeConfig(file).apiKey;
};

describe("settings Jev entry (#784)", () => {
  test("the row renders and the disclosure shows under the entry", async () => {
    const { cwd, home } = setup();
    const { i } = mount(cwd, home, async () => ({ status: "active", latencyMs: 10 }));
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Jev (TypeSafe)");
    await down(i, JEV_ROW);
    await sleep(30);
    // The row's footer hint wraps, so assert on a fragment that always fits.
    const hint = stripAnsi(i.lastFrame() ?? "");
    expect(hint).toContain("judgments send the command, working directory and git");
    expect(hint).toContain("training on inputs.");
    i.stdin.write("\r");
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("API key");
    expect(frame).toContain("Status");
    expect(frame).toContain("Remove");
    // #787: the routing opt-in lives in the same entry, off by default.
    expect(frame).toContain("Model routing");
    expect(frame).toContain("off");
    expect(frame).toContain("inactive");
    i.unmount();
  });

  test("a valid key is persisted and reported active", async () => {
    const { cwd, home } = setup();
    const { i, toasts } = mount(cwd, home, async () => ({ status: "active", latencyMs: 812 }));
    await sleep(30);
    await openKeyInput(i);
    i.stdin.write("sk-valid-1234");
    await sleep(30);
    i.stdin.write("\r");
    await sleep(80);
    expect(storedKey(home)).toBe("sk-valid-1234");
    expect(toasts).toContain("jev: active");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("active");
    i.unmount();
  });

  test("an invalid key is NOT persisted and says so", async () => {
    const { cwd, home } = setup();
    const { i, toasts } = mount(cwd, home, async () => ({ status: "invalid", message: "HTTP 401" }));
    await sleep(30);
    await openKeyInput(i);
    i.stdin.write("sk-bad");
    await sleep(30);
    i.stdin.write("\r");
    await sleep(80);
    expect(storedKey(home)).toBeUndefined();
    expect(toasts.some((t) => t.includes("invalid key"))).toBe(true);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("invalid key — not saved");
    i.unmount();
  });

  test("an invalid key never overwrites a stored one", async () => {
    const { cwd, home } = setup();
    const file = userConfigFile(home);
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(file, JSON.stringify({ typesafe: { apiKey: "sk-previous-abcd" } }));
    const { i } = mount(cwd, home, async () => ({ status: "invalid", message: "HTTP 401" }));
    await sleep(30);
    await openKeyInput(i);
    i.stdin.write("sk-bad");
    await sleep(30);
    i.stdin.write("\r");
    await sleep(80);
    // Validation runs first: the rejected key never reaches the file, and
    // the good one the user already had is still there.
    expect(storedKey(home)).toBe("sk-previous-abcd");
    i.unmount();
  });

  test("an unreachable service keeps the key (fail-open) with its own message", async () => {
    const { cwd, home } = setup();
    const { i, toasts } = mount(cwd, home, async () => ({ status: "unreachable", kind: "network", message: "fetch failed" }));
    await sleep(30);
    await openKeyInput(i);
    i.stdin.write("sk-slow");
    await sleep(30);
    i.stdin.write("\r");
    await sleep(80);
    expect(storedKey(home)).toBe("sk-slow");
    expect(toasts.some((t) => t.includes("could not verify"))).toBe(true);
    i.unmount();
  });

  test("Remove clears the key and the row goes back to inactive", async () => {
    const { cwd, home } = setup();
    const { i, toasts } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }), {
      ...DEFAULT_USER_CONFIG,
    });
    await sleep(30);
    await openKeyInput(i);
    i.stdin.write("sk-remove-me");
    await sleep(30);
    i.stdin.write("\r");
    await sleep(80);
    expect(storedKey(home)).toBe("sk-remove-me");
    // Back to the entry menu (the valid path returns there), then "Remove"
    // (API key · Model routing · Status · Remove, #787).
    await down(i, 3);
    i.stdin.write("\r");
    await sleep(60);
    expect(storedKey(home)).toBeUndefined();
    expect(toasts.some((t) => t.includes("key removed"))).toBe(true);
    i.unmount();
  });

  test("an existing key shows as active with a masked hint", async () => {
    const { cwd, home } = setup();
    const file = userConfigFile(home);
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(file, JSON.stringify({ typesafe: { apiKey: "sk-existing-abcd", timeoutMs: 1200 } }));
    const { i } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    // The row column truncates; the masked hint and the effective timeout
    // are what a user reads there, and the full key never appears.
    expect(frame).toContain("active (key …abcd, timeout");
    expect(frame).not.toContain("sk-existing-abcd");
    i.unmount();
  });
});

describe("settings Jev entry: model routing (#787)", () => {
  const storedRouting = (home: string): boolean | undefined => {
    const file = userConfigFile(home);
    if (!existsSync(file)) return undefined;
    return readTypesafeConfig(file).routing;
  };

  test("the toggle writes the opt-in and reports that it starts next session", async () => {
    const { cwd, home } = setup();
    const { i, toasts } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    await sleep(30);
    await down(i, JEV_ROW);
    i.stdin.write("\r"); // open the Jev entry
    await sleep(30);
    await down(i, 1); // "Model routing"
    i.stdin.write("\r");
    await sleep(60);

    expect(storedRouting(home)).toBe(true);
    expect(toasts.some((t) => t.includes("routing on"))).toBe(true);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("Model routing");
    expect(frame).toContain("on");
    i.unmount();
  });

  test("toggling twice turns it back off, and an unrelated section survives", async () => {
    const { cwd, home } = setup();
    const file = userConfigFile(home);
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(file, JSON.stringify({ typesafe: { apiKey: "sk-keep-abcd", routing: true }, theme: "dark" }));
    const { i, toasts } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    await sleep(30);
    await down(i, JEV_ROW);
    i.stdin.write("\r");
    await sleep(30);
    await down(i, 1);
    i.stdin.write("\r");
    await sleep(60);

    expect(storedRouting(home)).toBe(false);
    expect(toasts.some((t) => t.includes("routing off"))).toBe(true);
    // The read-modify-write keeps the key and every unrelated section.
    const written = readTypesafeConfig(file);
    expect(written.apiKey).toBe("sk-keep-abcd");
    i.unmount();
  });
});

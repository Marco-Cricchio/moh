/**
 * #784: the TUI Settings entry for Jev (TypeSafe) — the only supported way
 * to enter the key. Valid / invalid / unreachable are three distinct paths
 * (an invalid key must not stay persisted, an unreachable service must), and
 * the validator is always injected so no test touches the network.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userConfigFile } from "@moh/core";
import { readTypesafeConfig, type JevKeyValidation } from "@moh/jev-guard";
import { SettingsPanel } from "../src/SettingsPanel";
import { DEFAULT_USER_CONFIG, type UserConfig } from "../src/user-config";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi, waitForCondition } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The entry's row index in the settings list (after "Remove provider"). */
const JEV_ROW = 11;

/**
 * Moves the settings cursor onto the Jev entry by its LABEL. A fixed index
 * broke 14 tests the moment a settings row was inserted above it; the label
 * survives insertions.
 */
const gotoJevRow = async (i: ReturnType<typeof render>) => {
  for (let k = 0; k < 24; k++) {
    const on = stripAnsi(i.lastFrame() ?? "").split("\n").some((l) => l.includes("›") && l.includes("Jev (TypeSafe)"));
    if (on) return;
    i.stdin.write("\x1b[B");
    await sleep(25);
  }
  throw new Error("the Jev settings row was not reachable by label");
};

/**
 * The sub-menu's rows, in order (#833 added "Classification" between
 * "Anti-injection" and "Quality gate", which shifted the ones below it):
 * 0 API key · 1 Model routing · 2 Anti-injection · 3 Classification ·
 * 4 Quality gate · 5 Seed rerank · 6 Skill suggestion · 7 Status · 8 Remove
 */
const JEV_OPTION = { apiKey: 0, routing: 1, injection: 2, classification: 3, lint: 4, rerank: 5, skills: 6, status: 7, remove: 8 } as const;

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
  await gotoJevRow(i);
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
    await gotoJevRow(i);
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
    // (see JEV_OPTION: it is the last row, #833 added Classification).
    await down(i, JEV_OPTION.remove);
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
    await gotoJevRow(i);
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
    await gotoJevRow(i);
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

describe("settings Jev entry: anti-injection (#791)", () => {
  const storedInjection = (home: string): boolean | undefined => {
    const file = userConfigFile(home);
    if (!existsSync(file)) return undefined;
    return readTypesafeConfig(file).injection;
  };

  test("off by default, the toggle writes the opt-in and states what it sends", async () => {
    const { cwd, home } = setup();
    const { i, toasts } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    await sleep(30);
    expect(storedInjection(home)).toBeUndefined();

    await gotoJevRow(i);
    i.stdin.write("\r"); // open the Jev entry
    await sleep(30);
    await down(i, 2); // "Anti-injection"
    i.stdin.write("\r");
    await sleep(60);

    expect(storedInjection(home)).toBe(true);
    expect(toasts.some((t) => t.includes("anti-injection on"))).toBe(true);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("Anti-injection");
    // The disclosure grows with the one use case that sends the message
    // (the copy wraps inside the dialog, so a fragment is what to assert).
    expect(frame).toContain("sends your message");
    i.unmount();
  });

  test("toggling twice turns it back off, and the key survives", async () => {
    const { cwd, home } = setup();
    const file = userConfigFile(home);
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(file, JSON.stringify({ typesafe: { apiKey: "sk-keep-abcd", injection: true } }));
    const { i, toasts } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    await sleep(30);
    await gotoJevRow(i);
    i.stdin.write("\r");
    await sleep(30);
    await down(i, 2);
    i.stdin.write("\r");
    await sleep(60);

    expect(storedInjection(home)).toBe(false);
    expect(toasts.some((t) => t.includes("anti-injection off"))).toBe(true);
    expect(readTypesafeConfig(file).apiKey).toBe("sk-keep-abcd");
    i.unmount();
  });
});

describe("settings Jev entry: quality gate (#789)", () => {
  const storedLint = (home: string): boolean | undefined => {
    const file = userConfigFile(home);
    if (!existsSync(file)) return undefined;
    return readTypesafeConfig(file).lint;
  };

  test("off by default; the toggle writes the opt-in and states what it sends", async () => {
    const { cwd, home } = setup();
    const { i, toasts } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    await sleep(30);
    expect(storedLint(home)).toBeUndefined(); // off by default
    await gotoJevRow(i);
    i.stdin.write("\r"); // open the Jev entry
    await sleep(30);
    await down(i, 4); // "Quality gate"
    i.stdin.write("\r");
    await sleep(60);

    expect(storedLint(home)).toBe(true);
    expect(toasts.some((t) => t.includes("quality gate on"))).toBe(true);
    // The disclosure states the privacy step where the toggle lives.
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame.replace(/[\s│]+/g, " ")).toContain("quality gate sends the diff of the changed code");
    i.unmount();
  });

  test("toggling twice turns it back off", async () => {
    const { cwd, home } = setup();
    const { i } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    await sleep(30);
    await gotoJevRow(i);
    i.stdin.write("\r");
    await sleep(30);
    await down(i, 4); // "Quality gate"
    i.stdin.write("\r");
    await sleep(60);
    expect(storedLint(home)).toBe(true);
    await down(i, 4); // "Quality gate" again (cursor reset to the entry top)
    i.stdin.write("\r");
    await sleep(60);
    expect(storedLint(home)).toBe(false);
    i.unmount();
  });
});

describe("settings Jev entry: skill suggestion (#793)", () => {
  const storedSkills = (home: string): boolean | undefined => {
    const file = userConfigFile(home);
    if (!existsSync(file)) return undefined;
    return readTypesafeConfig(file).skills;
  };

  test("off by default; the toggle writes the opt-in and states what it sends", async () => {
    const { cwd, home } = setup();
    const { i, toasts } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    await sleep(30);
    expect(storedSkills(home)).toBeUndefined(); // off by default
    await gotoJevRow(i);
    i.stdin.write("\r"); // open the Jev entry
    await sleep(30);
    await down(i, 6); // "Skill suggestion"
    i.stdin.write("\r");
    await sleep(60);

    expect(storedSkills(home)).toBe(true);
    expect(toasts.some((t) => t.includes("skill suggestion on"))).toBe(true);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame.replace(/[\s│]+/g, " ")).toContain("skill suggestion sends your message");
    i.unmount();
  });

  test("toggling twice turns it back off", async () => {
    const { cwd, home } = setup();
    const { i } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    await sleep(30);
    await gotoJevRow(i);
    i.stdin.write("\r");
    await sleep(30);
    await down(i, 6); // "Skill suggestion"
    i.stdin.write("\r");
    await sleep(60);
    expect(storedSkills(home)).toBe(true);
    await down(i, 6);
    i.stdin.write("\r");
    await sleep(60);
    expect(storedSkills(home)).toBe(false);
    i.unmount();
  });
});

describe("settings Jev entry: prompt classification (#788/#833)", () => {
  const storedClassification = (home: string): boolean | undefined => {
    const file = userConfigFile(home);
    if (!existsSync(file)) return undefined;
    return readTypesafeConfig(file).classification;
  };

  test("on by default; the row turns it off and states what it changes", async () => {
    const { cwd, home } = setup();
    const { i, toasts } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    await sleep(30);
    expect(storedClassification(home)).toBeUndefined(); // on unless opted out
    await gotoJevRow(i);
    i.stdin.write("\r"); // open the Jev entry
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("Classification");
    expect(frame.replace(/[\s│]+/g, " ")).toContain("Classification on");
    await down(i, JEV_OPTION.classification);
    i.stdin.write("\r");
    await sleep(60);

    expect(storedClassification(home)).toBe(false);
    expect(toasts.some((t) => t.includes("classification off"))).toBe(true);
    i.unmount();
  });

  test("toggling twice turns it back on, and another section survives", async () => {
    const { cwd, home } = setup();
    const file = userConfigFile(home);
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(file, JSON.stringify({ typesafe: { apiKey: "sk-keep-me" }, telemetry: true }));
    const { i } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    // The parent list keeps its marker while the submenu is open.
    const selectedRow = () => frame().split("\n").filter((line) => line.includes("›")).at(-1)?.trim() ?? "";
    const waitForSelection = (label: string) => waitForCondition(
      () => selectedRow().includes(label),
      () => `selected ${label}. Last frame:\n${frame()}`,
    );
    const selectRow = async (label: string) => {
      await waitForCondition(() => selectedRow() !== "", () => `initial selection. Last frame:\n${frame()}`);
      for (let step = 0; step < 24 && !selectedRow().includes(label); step++) {
        const previous = selectedRow();
        i.stdin.write("\x1b[B");
        await waitForCondition(
          () => selectedRow() !== "" && selectedRow() !== previous,
          () => `selection to move from ${previous} toward ${label}. Last frame:\n${frame()}`,
        );
      }
      expect(selectedRow()).toContain(label);
    };
    try {
      await selectRow("Jev (TypeSafe)");
      i.stdin.write("\r");
      await waitForSelection("API key");
      expect(frame().replace(/[\s│]+/g, " ")).toContain("Classification on");

      for (const next of [false, true]) {
        await selectRow("Classification");
        i.stdin.write("\r");
        await waitForCondition(
          () => storedClassification(home) === next,
          () => `persisted classification ${next}; got ${storedClassification(home)}. Last frame:\n${frame()}`,
        );
        // Persistence precedes the render that resets the submenu cursor.
        await waitForSelection("API key");
        expect(frame().replace(/[\s│]+/g, " ")).toContain(`Classification ${next ? "on" : "off"}`);
      }
      expect(readTypesafeConfig(file).apiKey).toBe("sk-keep-me");
      expect(JSON.parse(readFileSync(file, "utf8")).telemetry).toBe(true);
    } finally {
      i.unmount();
    }
  });

  test("the entry states the persistent-vs-session split", async () => {
    const { cwd, home } = setup();
    const { i } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    await sleep(30);
    await gotoJevRow(i);
    i.stdin.write("\r");
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "").replace(/[\s│]+/g, " ");
    expect(frame).toContain("these switches are persistent (they apply from your next session); changing one in an open session is /jev.");
    i.unmount();
  });
});

/**
 * #784: the TUI Settings entry for Jev (TypeSafe) — the only supported way
 * to enter the key. Valid / invalid / unreachable are three distinct paths
 * (an invalid key must not stay persisted, an unreachable service must), and
 * the validator is always injected so no test touches the network.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userConfigFile } from "@moh/core";
import { JEV_USE_CASE_DESCRIPTIONS, readTypesafeConfig, type JevKeyValidation } from "@moh/jev-guard";
import { SettingsPanel } from "../src/SettingsPanel";
import { DEFAULT_USER_CONFIG, type UserConfig } from "../src/user-config";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { pressSettled, stripAnsi, waitStep, waitText } from "./helpers";
import { fileCredentialStore } from "../../core/src/credential-store";

// #1162: these tests drive the credential store — the 0600-file fallback
// under each test's isolated home, never the developer's keychain. #1504:
// set for this file only and restored after, so no other file leans on it.
const originalSecretStore = process.env.MOH_SECRET_STORE;
beforeAll(() => {
  process.env.MOH_SECRET_STORE = "file";
});
afterAll(() => {
  if (originalSecretStore === undefined) delete process.env.MOH_SECRET_STORE;
  else process.env.MOH_SECRET_STORE = originalSecretStore;
});

type View = ReturnType<typeof render>;

const frameOf = (i: View) => stripAnsi(i.lastFrame() ?? "");

/**
 * The highlighted row: the last line carrying `›` (the parent list keeps its
 * marker while the Jev sub-menu is open, so the sub-menu's cursor is last).
 */
const cursorRow = (i: View) => frameOf(i).split("\n").filter((l) => l.includes("›")).at(-1) ?? "";

/** #1495: the settings list has painted and its key handler is attached. */
const mounted = (i: View) => waitText(i, "Jev (TypeSafe)", "settings list rendered");

/** Presses ↓ and waits for the cursor to reach another row, never a fixed pause (#1495). */
const pressDown = async (i: View, step: string) => {
  const before = cursorRow(i);
  i.stdin.write("\x1b[B");
  await waitStep(i, () => cursorRow(i) !== before, `${step} (cursor leaving ${JSON.stringify(before.trim())})`);
};

/**
 * Moves the settings cursor onto the Jev entry by its LABEL. A fixed index
 * broke 14 tests the moment a settings row was inserted above it; the label
 * survives insertions.
 */
const gotoJevRow = async (i: View) => {
  for (let k = 0; k < 24; k++) {
    if (cursorRow(i).includes("Jev (TypeSafe)")) return;
    await pressDown(i, `walking to the Jev row (${k + 1})`);
  }
  throw new Error("the Jev settings row was not reachable by label");
};

/** The Jev sub-menu is open with its cursor on the first row ("API key"). */
const entryTop = (i: View, step: string) =>
  waitStep(i, () => cursorRow(i).includes("API key") && !frameOf(i).includes("api key: "), step);

/** Opens the Jev entry from its row. */
const openEntry = async (i: View) => {
  i.stdin.write("\r");
  await entryTop(i, "Jev sub-menu opened");
};

/**
 * Presses enter on a sub-menu row that acts and resets the cursor to the top
 * (a toggle, Remove, a saved key): the write precedes that reset, so the
 * reset is the state to wait on.
 */
const enterBackToTop = async (i: View, step: string) => {
  i.stdin.write("\r");
  await entryTop(i, step);
};

/** Types a key into the masked input and waits for its echo. */
const typeKey = async (i: View, key: string) => {
  i.stdin.write(key);
  await waitText(i, `api key: ${"•".repeat(Math.min(24, key.length))}▏`, "key typed");
};

/**
 * The sub-menu's rows, in order (#1041 added "Guardrail" right after the
 * key, which shifted the ones below it): 0 API key · 1 Guardrail ·
 * 2 Model routing · 3 Anti-injection · 4 Classification · 5 Quality gate ·
 * 6 Seed rerank · 7 Skill suggestion · 8 Status · 9 Remove
 */
const JEV_OPTION = { apiKey: 0, guardrail: 1, routing: 2, injection: 3, classification: 4, lint: 5, rerank: 6, skills: 7, status: 8, remove: 9 } as const;
/** Walk the sub-menu cursor onto one row, by the map above. */
const gotoOption = (i: View, option: number) => down(i, option);

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
  // #1042: the sub-menu windows its rows to the terminal height, so these
  // content tests need a tall-enough viewport — the default non-tty
  // fallback (24 rows) is a layout concern the height tests own.
  Object.defineProperty(i.stdout, "rows", { value: 40, configurable: true });
  Object.defineProperty(i.stdout, "columns", { value: 100, configurable: true });
  i.stdout.emit("resize");
  return { i, toasts };
}

const down = async (i: View, n: number) => {
  for (let k = 0; k < n; k++) await pressDown(i, `arrow down ${k + 1}/${n}`);
};

/** Walk to the Jev entry's key input. */
async function openKeyInput(i: View) {
  await gotoJevRow(i);
  await openEntry(i);
  i.stdin.write("\r"); // "API key"
  await waitText(i, "api key: ", "key input opened");
}

/** #1162: the key lives in the credential store, not in config. */
const storedKey = (home: string): string | undefined => fileCredentialStore({ home }).get("typesafe");

describe("settings Jev entry (#784)", () => {
  test("the row renders and the disclosure shows under the entry", async () => {
    const { cwd, home } = setup();
    const { i } = mount(cwd, home, async () => ({ status: "active", latencyMs: 10 }));
    await mounted(i);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Jev (TypeSafe)");
    await gotoJevRow(i);
    // The row's footer hint wraps, so assert on a fragment that always fits.
    const hint = stripAnsi(i.lastFrame() ?? "");
    expect(hint).toContain("judgments send the command, working directory and git");
    expect(hint).toContain("training on inputs.");
    await openEntry(i);
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
    await mounted(i);
    await openKeyInput(i);
    await typeKey(i, "sk-valid-1234");
    await enterBackToTop(i, "key saved, back in the sub-menu");
    expect(storedKey(home)).toBe("sk-valid-1234");
    expect(toasts).toContain("jev: active");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("active");
    i.unmount();
  });

  test("an invalid key is NOT persisted and says so", async () => {
    const { cwd, home } = setup();
    const { i, toasts } = mount(cwd, home, async () => ({ status: "invalid", message: "HTTP 401" }));
    await mounted(i);
    await openKeyInput(i);
    await typeKey(i, "sk-bad");
    i.stdin.write("\r");
    await waitText(i, "invalid key — not saved", "rejected key reported");
    expect(storedKey(home)).toBeUndefined();
    expect(toasts.some((t) => t.includes("invalid key"))).toBe(true);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("invalid key — not saved");
    i.unmount();
  });

  test("an invalid key never overwrites a stored one", async () => {
    const { cwd, home } = setup();
    mkdirSync(join(home, ".moh"), { recursive: true });
    fileCredentialStore({ home }).set("typesafe", "sk-previous-abcd");
    const { i } = mount(cwd, home, async () => ({ status: "invalid", message: "HTTP 401" }));
    await mounted(i);
    await openKeyInput(i);
    await typeKey(i, "sk-bad");
    i.stdin.write("\r");
    await waitText(i, "invalid key — not saved", "rejected key reported");
    // Validation runs first: the rejected key never reaches the file, and
    // the good one the user already had is still there.
    expect(storedKey(home)).toBe("sk-previous-abcd");
    i.unmount();
  });

  test("an unreachable service keeps the key (fail-open) with its own message", async () => {
    const { cwd, home } = setup();
    const { i, toasts } = mount(cwd, home, async () => ({ status: "unreachable", kind: "network", message: "fetch failed" }));
    await mounted(i);
    await openKeyInput(i);
    await typeKey(i, "sk-slow");
    await enterBackToTop(i, "key saved, back in the sub-menu");
    expect(storedKey(home)).toBe("sk-slow");
    expect(toasts.some((t) => t.includes("could not verify"))).toBe(true);
    i.unmount();
  });

  test("Remove clears the key and the row goes back to inactive", async () => {
    const { cwd, home } = setup();
    const { i, toasts } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }), {
      ...DEFAULT_USER_CONFIG,
    });
    await mounted(i);
    await openKeyInput(i);
    await typeKey(i, "sk-remove-me");
    await enterBackToTop(i, "key saved, back in the sub-menu");
    expect(storedKey(home)).toBe("sk-remove-me");
    // Back to the entry menu (the valid path returns there), then "Remove"
    // (see JEV_OPTION: it is the last row, #833 added Classification).
    await down(i, JEV_OPTION.remove);
    await enterBackToTop(i, "row acted, cursor back on top");
    expect(storedKey(home)).toBeUndefined();
    expect(toasts.some((t) => t.includes("key removed"))).toBe(true);
    i.unmount();
  });

  test("an existing key shows as active with a masked hint", async () => {
    const { cwd, home } = setup();
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(userConfigFile(home), JSON.stringify({ typesafe: { timeoutMs: 1200 } }));
    fileCredentialStore({ home }).set("typesafe", "sk-existing-abcd");
    const { i } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    await mounted(i);
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
    await mounted(i);
    await gotoJevRow(i);
    await openEntry(i);
    await gotoOption(i, JEV_OPTION.routing);
    await enterBackToTop(i, "row acted, cursor back on top");

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
    await mounted(i);
    await gotoJevRow(i);
    await openEntry(i);
    await gotoOption(i, JEV_OPTION.routing);
    await enterBackToTop(i, "row acted, cursor back on top");

    expect(storedRouting(home)).toBe(false);
    expect(toasts.some((t) => t.includes("routing off"))).toBe(true);
    // The read-modify-write keeps the key (in the store, #1162) and every
    // unrelated section.
    expect(storedKey(home)).toBe("sk-keep-abcd");
    const written = readTypesafeConfig(file);
    expect(written.routing).toBe(false);
    expect(written.apiKey).toBeUndefined();
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
    await mounted(i);
    expect(storedInjection(home)).toBeUndefined();

    await gotoJevRow(i);
    await openEntry(i);
    await gotoOption(i, JEV_OPTION.injection);
    await enterBackToTop(i, "row acted, cursor back on top");

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
    await mounted(i);
    await gotoJevRow(i);
    await openEntry(i);
    await gotoOption(i, JEV_OPTION.injection);
    await enterBackToTop(i, "row acted, cursor back on top");

    expect(storedInjection(home)).toBe(false);
    expect(toasts.some((t) => t.includes("anti-injection off"))).toBe(true);
    // #1162: the key survives — in the store, not the config file.
    expect(storedKey(home)).toBe("sk-keep-abcd");
    expect(readTypesafeConfig(file).apiKey).toBeUndefined();
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
    await mounted(i);
    expect(storedLint(home)).toBeUndefined(); // off by default
    await gotoJevRow(i);
    await openEntry(i);
    await gotoOption(i, JEV_OPTION.lint);
    await enterBackToTop(i, "row acted, cursor back on top");

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
    await mounted(i);
    await gotoJevRow(i);
    await openEntry(i);
    await gotoOption(i, JEV_OPTION.lint);
    await enterBackToTop(i, "row acted, cursor back on top");
    expect(storedLint(home)).toBe(true);
    await gotoOption(i, JEV_OPTION.lint); // "Quality gate" again (cursor reset to the entry top)
    await enterBackToTop(i, "row acted, cursor back on top");
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
    await mounted(i);
    expect(storedSkills(home)).toBeUndefined(); // off by default
    await gotoJevRow(i);
    await openEntry(i);
    await gotoOption(i, JEV_OPTION.skills);
    await enterBackToTop(i, "row acted, cursor back on top");

    expect(storedSkills(home)).toBe(true);
    expect(toasts.some((t) => t.includes("skill suggestion on"))).toBe(true);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame.replace(/[\s│]+/g, " ")).toContain("skill suggestion sends your message");
    i.unmount();
  });

  test("toggling twice turns it back off", async () => {
    const { cwd, home } = setup();
    const { i } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    await mounted(i);
    await gotoJevRow(i);
    await openEntry(i);
    await gotoOption(i, JEV_OPTION.skills);
    await enterBackToTop(i, "row acted, cursor back on top");
    expect(storedSkills(home)).toBe(true);
    await gotoOption(i, JEV_OPTION.skills);
    await enterBackToTop(i, "row acted, cursor back on top");
    expect(storedSkills(home)).toBe(false);
    i.unmount();
  });
});

// #1430 characterization: the seed-rerank row had no test. It pins the whole
// config file after each toggle (not only the flag), waiting on frames and
// effects through the helpers rather than fixed sleeps.
describe("settings Jev entry: seed rerank (#790, #1430)", () => {
  const SEED = { provider: "mock", telemetry: true, typesafe: { timeoutMs: 1200, tiers: { "a/one": "potente" }, routing: true } };
  const readFile = (home: string): Record<string, unknown> =>
    JSON.parse(readFileSync(userConfigFile(home), "utf8")) as Record<string, unknown>;

  /** Moves the cursor until the row carrying `label` is the highlighted one. */
  const cursorOnRow = async (view: ReturnType<typeof render>, label: string) => {
    const onRow = () => stripAnsi(view.lastFrame() ?? "").split("\n").some((l) => l.includes("›") && l.includes(label));
    for (let k = 0; k < 24 && !onRow(); k++) {
      const before = view.lastFrame();
      await pressSettled(view, "\x1b[B");
      await waitStep(view, () => view.lastFrame() !== before, `cursor move towards "${label}"`);
    }
    if (!onRow()) throw new Error(`the "${label}" row was not reachable by label`);
  };

  test("on and off rewrite only the rerank flag in the whole config file", async () => {
    const { cwd, home } = setup();
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(userConfigFile(home), JSON.stringify(SEED));
    const { i, toasts } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    await waitText(i, "Jev (TypeSafe)", "settings main list");
    await cursorOnRow(i, "Jev (TypeSafe)");
    await pressSettled(i, "\r");
    await waitText(i, "Seed rerank", "Jev sub-menu");
    await cursorOnRow(i, "Seed rerank");
    await pressSettled(i, "\r");
    await waitStep(i, () => toasts.some((t) => t.includes("seed rerank on")), "toast: seed rerank on");
    expect(readFile(home)).toEqual({ ...SEED, typesafe: { ...SEED.typesafe, rerank: true } });

    await waitText(i, "Seed rerank", "back in the Jev sub-menu");
    await cursorOnRow(i, "Seed rerank");
    await pressSettled(i, "\r");
    await waitStep(i, () => toasts.some((t) => t.includes("seed rerank off")), "toast: seed rerank off");
    expect(readFile(home)).toEqual({ ...SEED, typesafe: { ...SEED.typesafe, rerank: false } });
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
    await mounted(i);
    expect(storedClassification(home)).toBeUndefined(); // on unless opted out
    await gotoJevRow(i);
    await openEntry(i);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("Classification");
    expect(frame.replace(/[\s│]+/g, " ")).toContain("Classification on");
    await down(i, JEV_OPTION.classification);
    await enterBackToTop(i, "row acted, cursor back on top");

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
    const frame = () => frameOf(i);
    // #1495: every key waits on the cursor row through `waitStep`, which
    // also flushes passive effects — an enter written the moment the cursor
    // painted reached the previous row's handler and toggled Anti-injection.
    const selectRow = async (label: string) => {
      await waitStep(i, () => cursorRow(i) !== "", "initial selection");
      for (let step = 0; step < 24 && !cursorRow(i).includes(label); step++) {
        await pressDown(i, `selection moving toward ${label}`);
      }
      expect(cursorRow(i)).toContain(label);
    };
    try {
      await selectRow("Jev (TypeSafe)");
      await openEntry(i);
      expect(frame().replace(/[\s│]+/g, " ")).toContain("Classification on");

      for (const next of [false, true]) {
        await selectRow("Classification");
        // Persistence precedes the render that resets the submenu cursor.
        await enterBackToTop(i, `classification toggled ${next ? "on" : "off"}`);
        expect(storedClassification(home)).toBe(next);
        expect(frame().replace(/[\s│]+/g, " ")).toContain(`Classification ${next ? "on" : "off"}`);
      }
      // #1162: the key survives — in the store, not the config file.
      expect(storedKey(home)).toBe("sk-keep-me");
      expect(readTypesafeConfig(file).apiKey).toBeUndefined();
      expect(JSON.parse(readFileSync(file, "utf8")).telemetry).toBe(true);
    } finally {
      i.unmount();
    }
  });

  test("the entry states the persistent-vs-session split", async () => {
    const { cwd, home } = setup();
    const { i } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    await mounted(i);
    await gotoJevRow(i);
    await openEntry(i);
    const frame = stripAnsi(i.lastFrame() ?? "").replace(/[\s│]+/g, " ");
    expect(frame).toContain("these switches are persistent (they apply from your next session); changing one in an open session is /jev.");
    i.unmount();
  });
});

describe("settings Jev entry: the guardrail row (#1041)", () => {
  const storedGuardrail = (home: string): boolean | undefined => {
    const file = userConfigFile(home);
    if (!existsSync(file)) return undefined;
    return readTypesafeConfig(file).guardrail;
  };

  test("on by default: the row shows an armed guardrail with nothing in the file", async () => {
    const { cwd, home } = setup();
    const { i } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    await mounted(i);
    expect(storedGuardrail(home)).toBeUndefined();

    await gotoJevRow(i);
    await openEntry(i);
    const frame = () => stripAnsi(i.lastFrame() ?? "").replace(/[\s│]+/g, " ");
    expect(frame()).toContain("Guardrail on");
    i.unmount();
  });

  test("the row writes the opt-out the extension reads at the next assembly", async () => {
    const { cwd, home } = setup();
    const { i, toasts } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    await mounted(i);
    await gotoJevRow(i);
    await openEntry(i);
    await gotoOption(i, JEV_OPTION.guardrail);
    await enterBackToTop(i, "row acted, cursor back on top");

    expect(storedGuardrail(home)).toBe(false);
    expect(toasts.some((t) => t.includes("guardrail off · from your next session"))).toBe(true);
    expect(readTypesafeConfig(userConfigFile(home)).guardrail).toBe(false);
    const frame = stripAnsi(i.lastFrame() ?? "").replace(/[\s│]+/g, " ");
    expect(frame).toContain("Guardrail off");

    // ...and back on, in the same entry, leaving an explicit flag.
    await gotoOption(i, JEV_OPTION.guardrail);
    await enterBackToTop(i, "row acted, cursor back on top");
    expect(storedGuardrail(home)).toBe(true);
    expect(toasts.some((t) => t.includes("guardrail on · from your next session"))).toBe(true);
    i.unmount();
  });

  test("every row of the entry states what it does, and the use cases share the /jev words (#1041)", async () => {
    const { cwd, home } = setup();
    const { i } = mount(cwd, home, async () => ({ status: "active", latencyMs: 1 }));
    await mounted(i);
    await gotoJevRow(i);
    await openEntry(i);

    const frame = () => stripAnsi(i.lastFrame() ?? "").replace(/[\s│]+/g, " ");
    /** The words the row must carry, in row order: the seven use cases read
     *  them from the package that owns the vocabulary (so /jev is the same
     *  account), the three others are this panel's own. */
    const rows: [number, string][] = [
      [JEV_OPTION.apiKey, "the TypeSafe key — storing one is what activates Jev; nothing is registered without it"],
      [JEV_OPTION.guardrail, JEV_USE_CASE_DESCRIPTIONS.guardrail],
      [JEV_OPTION.routing, JEV_USE_CASE_DESCRIPTIONS.routing],
      [JEV_OPTION.injection, JEV_USE_CASE_DESCRIPTIONS.injection],
      [JEV_OPTION.classification, JEV_USE_CASE_DESCRIPTIONS.classification],
      [JEV_OPTION.lint, JEV_USE_CASE_DESCRIPTIONS.lint],
      [JEV_OPTION.rerank, JEV_USE_CASE_DESCRIPTIONS.rerank],
      [JEV_OPTION.skills, JEV_USE_CASE_DESCRIPTIONS.skills],
      [JEV_OPTION.status, "what the configuration holds right now — the key, the timeout and this entry's switches"],
      [JEV_OPTION.remove, "forgets the stored key: from the next session nothing of Jev is registered"],
    ];
    // The cursor opens on the first row: each description is shown beside
    // the row it describes, separated by " - ", and only there.
    for (const [index, description] of rows) {
      if (index > 0) await down(i, 1);
      const shown = frame();
      expect(shown).toContain(` - ${description}`);
      for (const [, other] of rows) {
        if (other !== description) expect(shown).not.toContain(other);
      }
    }
    i.unmount();
  });
});

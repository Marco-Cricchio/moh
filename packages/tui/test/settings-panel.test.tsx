import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMohConfig, readUserProviderConfig, upsertUserEndpoint } from "@moh/core";
import { SettingsPanel } from "../src/SettingsPanel";
import { DEFAULT_USER_CONFIG, type UserConfig } from "../src/user-config";
import { ThemeProvider, THEMES, DEFAULT_THEME, THEME_ORDER } from "../src/themes";
import { stripAnsi, waitForCondition, waitForFrame } from "./helpers";

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

type View = ReturnType<typeof render>;

const frameOf = (i: View) => stripAnsi(i.lastFrame() ?? "");

/**
 * #1466: Ink's `useInput` re-subscribes its handler in a `useEffect`, so for a
 * moment after a level paints, a key still reaches the previous level's
 * handler (with the previous state) — the race every fixed sleep in this file
 * was papering over. React's scheduler flushes passive effects on the
 * `setImmediate` queue, which is already holding that flush by the time a
 * frame is observed: two turns of it leave the new handler attached.
 */
const effectsFlushed = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

const stuck = (step: string, e: unknown) =>
  new Error(`settings panel stuck at step "${step}": ${e instanceof Error ? e.message : String(e)}`);

/** Waits for `condition` (a deadline, never a fixed pause) and fails naming the step. */
const until = async (i: View, condition: () => boolean, step: string) => {
  try {
    await waitForCondition(condition, () => `for ${step}. Last frame:\n${frameOf(i)}`, { timeoutMs: 3_000 });
  } catch (e) {
    throw stuck(step, e);
  }
  await effectsFlushed();
};

/** Waits for the frame to contain (or, with `absent`, to lose) `expected`. */
const settle = (i: View, expected: string, step: string, { absent = false } = {}) =>
  until(i, () => frameOf(i).includes(expected) !== absent, `${step} (frame ${absent ? "without" : "containing"} ${JSON.stringify(expected)})`);

/** The settings list has painted and its keyboard handler is attached. */
const mounted = (i: View) => settle(i, "Mode", "settings list rendered");

/**
 * The cursor row's label: the text after the first `›`, up to the value
 * column. A value that repaints in place (an earlier toggle still landing)
 * does not change it; moving the cursor to another row does.
 */
const cursorLabel = (i: View) => {
  const line = frameOf(i).split("\n").find((l) => l.includes("›")) ?? "";
  return (line.split("›")[1] ?? "").replace(/[│]/g, "").trim().split(/\s{2,}/)[0] ?? "";
};

/**
 * Presses a cursor key and waits until the cursor has moved to another row,
 * so the next key never lands inside the same commit window (and is never
 * lost under load). A key that moves nothing is reported as a stuck step.
 */
const press = async (i: View, key: string, step: string) => {
  const before = cursorLabel(i);
  i.stdin.write(key);
  await until(i, () => cursorLabel(i) !== before, `${step} (cursor leaving "${before}")`);
};

/** Presses a key that repaints in place (a slider, a toggle) and waits for the repaint. */
const repaint = async (i: View, key: string, step: string) => {
  const before = i.lastFrame();
  i.stdin.write(key);
  await until(i, () => i.lastFrame() !== before, `${step} (frame repaint)`);
};

const down = async (i: View, n: number) => {
  for (let k = 0; k < n; k++) await press(i, "\x1b[B", `arrow down ${k + 1}/${n}`);
};

/**
 * The row carrying the sub-menu cursor (the fallback list marks it with `›`).
 * A missing row is reported as such instead of collapsing to empty string, so a
 * timeout can tell "no sub-menu is open" from "the cursor is on the wrong row".
 */
const overline = (raw: string) =>
  stripAnsi(raw).split("\n").find((l) => l.includes("›") && (l.includes("📌") || l.includes("· —"))) ?? "<no sub-menu cursor row — is the list open?>";

/**
 * Moves the cursor onto the row whose label starts with `label`.
 * Navigating by label instead of by a fixed count keeps these tests honest
 * when a row is inserted: an off-by-one otherwise silently drives a
 * neighbouring setting (which is how a new row broke 13 tests at once).
 * The walk first climbs to the list's first row (`top`, "Mode" on the
 * settings list) one confirmed press at a time, then walks down the same way.
 */
const gotoRow = async (i: View, label: string, { top = "Mode" }: { top?: string } = {}) => {
  const on = () => frameOf(i).split("\n").some((l) => l.includes("›") && l.includes(label));
  for (let k = 0; k < 40 && !cursorLabel(i).startsWith(top); k++) {
    await press(i, "\x1b[A", `climbing to "${top}" before walking to "${label}"`);
  }
  for (let k = 0; k < 40; k++) {
    if (on()) return;
    await press(i, "\x1b[B", `walking down to the row "${label}"`);
  }
  throw new Error(`settings row not reachable by label: ${label}`);
};

const toasted = (i: View, toasts: string[], text: string) =>
  until(i, () => toasts.some((t) => t.includes(text)), `the toast ${JSON.stringify(text)}`);

describe("settings panel ToS card (#444)", () => {
  test("pressing t on an endpoint shows the full ToS card with disclaimer, links and verification date", async () => {
    const cwd = setupCwd();
    const { i, toasts } = mount(cwd);
    await mounted(i);
    await gotoRow(i, "Provider");
    i.stdin.write("\r");
    await settle(i, "› mock", "endpoint level opened");
    i.stdin.write("t"); // ToS for mock: toast, no card
    await toasted(i, toasts, 'no bundled ToS summary for "mock"');
    let frame = stripAnsi(i.lastFrame() ?? "");
    // First row is mock: no bundled card, just a toast.
    expect(frame).not.toContain("Machine-written informational summary");
    await down(i, 1); // anthropic endpoint
    i.stdin.write("t");
    await settle(i, "Machine-written informational summary", "ToS card for anthropic");
    frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("Machine-written informational summary"); // disclaimer
    expect(frame).toContain("Terms of Service — anthropic (verified 2026-09)");
    expect(frame).toContain("Terms of Service: https://www.anthropic.com/legal/com…");
    expect(frame).toContain("Data retention:");
    i.stdin.write("\x1b"); // back
    await settle(i, "Machine-written informational summary", "back from the ToS card", { absent: true });
    frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("anthropic"); // endpoint list again
    i.unmount();
  });
});

describe("settings panel (issue #33)", () => {
  test("renders every setting row with current values", async () => {
    const i = mount(setupCwd());
    await mounted(i.i);
    const frame = stripAnsi(i.i.lastFrame() ?? "");
    for (const label of [
      "Mode",
      "Theme",
      "Icons",
      "File preview",
      "Answer language",
      "Default permission mode",
      "Provider",
      "Add provider",
      "Remove provider",
      "Jev (TypeSafe)",
    ]) {
      expect(frame).toContain(label);
    }
    // moh sends no telemetry, so there is no switch for it.
    expect(frame).not.toContain("Telemetry");
    expect(frame).toContain("vibe");
    expect(frame).toContain("Tokyo Night");
    // The list scrolls: the rows below the fold are reachable, not missing.
    await gotoRow(i.i, "Provider reasoning");
    expect(stripAnsi(i.i.lastFrame() ?? "")).toContain("Provider reasoning");
    i.i.unmount();
  });

  test("enter toggles fields and persists via onChange", async () => {
    const { i, changes } = mount(setupCwd());
    await mounted(i);
    i.stdin.write("\r"); // mode → dev
    await until(i, () => changes.some((c) => c.mode === "dev"), "the mode change");
    await gotoRow(i, "Theme");
    i.stdin.write("\r"); // theme → opens the theme picker
    await settle(i, "enter apply", "theme picker opened");
    await press(i, "\x1b[B", "picker cursor to catppuccin");
    i.stdin.write("\r"); // apply catppuccin (picker closes, cursor stays on theme row)
    await until(i, () => changes.some((c) => c.theme === "catppuccin"), "the theme change");
    await settle(i, "enter change · esc close", "theme picker closed");
    await gotoRow(i, "Icons");
    i.stdin.write("\r"); // icons off
    await until(i, () => changes.some((c) => c.icons === false), "the icons change");
    expect(changes).toContainEqual({ mode: "dev" });
    expect(changes).toContainEqual({ theme: "catppuccin" });
    expect(changes).toContainEqual({ icons: false });
    i.unmount();
  });

  test("Session handoff shows its project transport state and opens its chooser", async () => {
    const cwd = setupCwd();
    let opened = 0;
    const { i } = mount(cwd, { onConfigureHandoff: () => { opened += 1; } });
    await mounted(i);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Session handoff");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Not Set");
    await gotoRow(i, "Session handoff");
    i.stdin.write("\r");
    await until(i, () => opened > 0, "the handoff chooser callback");
    expect(opened).toBe(1);
    i.unmount();
  });

  test("provider reasoning sets the persisted global display default", async () => {
    const { i, changes } = mount(setupCwd());
    await mounted(i);
    await gotoRow(i, "Provider reasoning");
    i.stdin.write("\r");
    await until(i, () => changes.some((c) => "showReasoning" in c), "the reasoning change");
    expect(changes).toContainEqual({ showReasoning: true });
    i.unmount();
  });

  test("provider switch is hierarchical: endpoint → model, rewrites defaultModel + provider in moh.json", async () => {
    const cwd = setupCwd();
    const { i, switched, toasts } = mount(cwd);
    await mounted(i);
    await gotoRow(i, "Provider");
    i.stdin.write("\r");
    await settle(i, "› mock", "endpoint level opened");
    let frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("mock");
    expect(frame).toContain("anthropic");
    expect(frame).toContain("openai");
    await down(i, 2); // openai endpoint
    await settle(i, "› openai", "cursor on the openai endpoint");
    i.stdin.write("\r");
    await settle(i, "type to filter", "model level opened");
    frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("ctx "); // model rows with context windows
    // type a model id → the free-text row commits it
    i.stdin.write("gpt-5.4");
    await settle(i, '+ use "gpt-5.4"', "free-text row for the typed model id");
    // The filtered catalog ends with the free-text row; walk to the last row
    // by label rather than by a hand-counted number of presses.
    for (let k = 0; k < 20 && !frameOf(i).includes('› + use "gpt-5.4"'); k++) {
      await press(i, "\x1b[B", 'walking down to the row `+ use "gpt-5.4"`');
    }
    i.stdin.write("\r");
    await until(i, () => switched.length > 0, "the provider switch callback");
    expect(switched).toEqual(["openai/gpt-5.4"]);
    expect(toasts.some((t) => t.includes("openai/gpt-5.4"))).toBe(true);
    const config = loadMohConfig(join(cwd, "moh.json"));
    expect(config.provider).toBe("openai/gpt-5.4");
    expect(config.endpoints?.find((e) => e.name === "openai")?.defaultModel).toBe("gpt-5.4");
    i.unmount();
  });

  test("ADR-0049: the model rows show a provider-declared window next to the catalog one", async () => {
    const cwd = setupCwd();
    const { i } = mount(cwd, {
      // The session learned this window from a refusal for that reference
      // alone (a sibling model on the same endpoint declared nothing).
      declaredWindow: (ref) => (ref === "anthropic/claude-fable-5" ? 131_072 : undefined),
    });
    await mounted(i);
    await gotoRow(i, "Provider");
    i.stdin.write("\r");
    await settle(i, "› mock", "endpoint level opened");
    await down(i, 1); // anthropic endpoint
    i.stdin.write("\r");
    await settle(i, "type to filter", "model level opened");
    i.stdin.write("fable"); // narrow to the two rows the assertion names
    await settle(i, '+ use "fable"', "the fable filter applied");
    const frame = stripAnsi(i.lastFrame() ?? "");
    // Declared first (the number every context decision uses), catalog
    // second. The dialog clips at its width; `windowText` pins the rest.
    expect(frame).toContain("claude-fable-5) · ctx 131k declared");
    // The sibling that declared nothing renders exactly as before.
    expect(frame).toContain("claude-fable-5-1) · ctx 1000k");
    i.unmount();
  });

  test("typing in the model level filters the catalog incrementally", async () => {
    const cwd = setupCwd();
    const { i } = mount(cwd);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await mounted(i);
    await gotoRow(i, "Provider");
    i.stdin.write("\r");
    // #1042: navigation is keyed off the rendered cursor row, so each step
    // waits for its commit instead of a fixed sleep (under suite load a
    // fixed pause can drop an arrow or type into the previous level).
    await settle(i, "› mock", "endpoint level opened");
    await down(i, 2); // openai endpoint
    await settle(i, "› openai", "cursor on the openai endpoint");
    i.stdin.write("\r");
    await settle(i, "type to filter", "model level opened");
    i.stdin.write("mini");
    // #1042: the model list windows to the terminal height now, so a slow
    // keystroke commit can show one filtered row next to unfiltered ones —
    // wait for the full filter to settle, not just for one matching row.
    await waitForCondition(
      () => !stripAnsi(i.lastFrame() ?? "").includes("gpt-5.5"),
      () => "for gpt-5.5 to leave the filtered list",
    );
    expect(frame()).toContain("gpt-5.4-mini");
    expect(frame()).not.toContain("gpt-5.5");
    i.unmount();
  });

  test("provider remove deletes the endpoint from moh.json", async () => {
    const cwd = setupCwd();
    const { i, toasts } = mount(cwd);
    await mounted(i);
    await gotoRow(i, "Remove provider");
    i.stdin.write("\r");
    await settle(i, "› anthropic", "remove list opened");
    await down(i, 1); // openai
    i.stdin.write("\r");
    await toasted(i, toasts, "removed endpoint openai");
    const config = loadMohConfig(join(cwd, "moh.json"));
    expect(config.endpoints?.map((e) => e.name)).toEqual(["anthropic"]);
    expect(toasts.some((t) => t.includes("removed endpoint openai"))).toBe(true);
    i.unmount();
  });

  test("removing the active endpoint resets the default provider to a remaining one", async () => {
    const cwd = setupCwd();
    const { i, toasts } = mount(cwd);
    await mounted(i);
    await gotoRow(i, "Remove provider");
    i.stdin.write("\r");
    await settle(i, "› anthropic", "remove list opened");
    i.stdin.write("\r"); // first option = anthropic (the active one)
    await toasted(i, toasts, "removed endpoint anthropic");
    expect(loadMohConfig(join(cwd, "moh.json")).provider).toBe("openai/gpt-5");
    i.unmount();
  });

  test("add provider opens the wizard overlay", async () => {
    const h = mount(setupCwd());
    await mounted(h.i);
    await gotoRow(h.i, "Add provider");
    h.i.stdin.write("\r");
    await until(h.i, () => h.wizardCount() > 0, "the wizard callback");
    expect(h.wizardCount()).toBe(1);
    h.i.unmount();
  });

  test("esc closes; submenus back out with esc first", async () => {
    let closed = 0;
    const { i } = mount(setupCwd(), { onClose: () => (closed += 1) });
    await mounted(i);
    await gotoRow(i, "Provider");
    i.stdin.write("\r");
    await settle(i, "› mock", "endpoint level opened");
    i.stdin.write("\x1b"); // leave submenu, not the panel
    await settle(i, "› mock", "back out of the endpoint level", { absent: true });
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("enter change · esc close");
    expect(closed).toBe(0);
    i.stdin.write("\x1b");
    await until(i, () => closed > 0, "the close callback");
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
    await mounted(i);
    await gotoRow(i, "Provider");
    i.stdin.write("\r");
    await settle(i, "› mock", "endpoint level opened");
    // One confirmed press per row (#1466): the cursor must land on each
    // endpoint in turn, never skip one.
    for (const endpoint of ["anthropic", "openai", "zai (user)"]) {
      await press(i, "\x1b[B", `cursor to ${endpoint}`);
      await settle(i, `› ${endpoint}`, `cursor on ${endpoint}`);
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
      await mounted(i);
      await gotoRow(i, "Provider");
      i.stdin.write("\r");
      await settle(i, "› mock", "endpoint level opened");
      await down(i, 3); // zai (user)
      await settle(i, "› zai (user)", "cursor on zai (user)");
      i.stdin.write("\r");
      // model level: fetched list arrives asynchronously
      await settle(i, "glm-5.3-air", "the live model list fetched");
      const frame = stripAnsi(i.lastFrame() ?? "");
      expect(frame).toContain("glm-5.3-air");
      i.stdin.write("air");
      await settle(i, '+ use "air"', "free-text row for the typed model id");
      // The free-text row closes the filtered list: walk to it by label.
      for (let k = 0; k < 20 && !frameOf(i).includes('› + use "air"'); k++) {
        await press(i, "\x1b[B", 'walking down to the row `+ use "air"`');
      }
      i.stdin.write("\r");
      await until(i, () => switched.length > 0, "the provider switch callback");
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
    await mounted(i);
    await gotoRow(i, "Remove provider");
    i.stdin.write("\r");
    await settle(i, "› anthropic", "remove list opened");
    await down(i, 2); // anthropic, openai, then zai
    i.stdin.write("\r");
    await toasted(i, toasts, "removed endpoint zai");
    expect(readUserProviderConfig(userFile).endpoints?.some((e) => e.name === "zai")).toBe(false);
    expect(toasts.some((t) => t.includes("removed endpoint zai"))).toBe(true);
    i.unmount();
  });
});

describe("fallback models screen (ADR-0012 preferred model)", () => {
  /** A project endpoint plus a user-level one — the two storage homes. */
  function fallbackSetup() {
    const cwd = setupCwd();
    const home = mkdtempSync(join(tmpdir(), "moh-fb-home-"));
    mkdirSync(join(home, ".moh"), { recursive: true });
    upsertUserEndpoint(join(home, ".moh", "config"), { name: "zai", type: "zai", defaultModel: "glm-5.3-flash" });
    return { cwd, home };
  }

  /** Opens the fallback list with its cursor on the first stop (anthropic). */
  async function openFallback(i: View) {
    await mounted(i);
    await gotoRow(i, "Fallback models");
    i.stdin.write("\r");
    await settle(i, "› anthropic · 📌 claude-sonnet-4-5", "fallback list opened");
  }

  test("the row summarises how many endpoints can serve as fallback stops", async () => {
    const { cwd, home } = fallbackSetup();
    const i = mount(cwd, { home });
    await mounted(i.i);
    const frame = stripAnsi(i.i.lastFrame() ?? "");
    expect(frame).toContain("Fallback models");
    // anthropic + openai (project) + zai (user) all carry a preferred model.
    expect(frame).toContain("3 of 3 endpoint(s)");
    i.i.unmount();
  });

  test("lists every endpoint with its preferred model, and why one cannot be a stop", async () => {
    const { cwd, home } = fallbackSetup();
    // A custom-factory type is route-incapable: listed, with the reason.
    const moh = loadMohConfig(join(cwd, "moh.json"));
    writeFileSync(
      join(cwd, "moh.json"),
      JSON.stringify({ ...moh, endpoints: [...(moh.endpoints ?? []), { name: "mine", type: "my-factory" }] }),
    );
    const i = mount(cwd, { home });
    await openFallback(i.i);
    let frame = stripAnsi(i.i.lastFrame() ?? "");
    expect(frame).toContain("anthropic · 📌 claude-sonnet-4-5");
    expect(frame).toContain("openai · 📌 gpt-5");
    // The ineligible one says why instead of disappearing.
    expect(frame).toContain("mine · — no preferred model (provider type \"my-facto");
    expect(frame).toContain("c clear");
    // The user-level endpoint is in the same list (one screen, one chain).
    // Walk by label, not by a counted `down(3)`. The row still has to be the
    // one under the cursor, not merely painted.
    await gotoRow(i.i, "zai", { top: "anthropic" });
    await waitForFrame(() => overline(i.i.lastFrame() ?? ""), "zai · 📌 glm-5.3-flash");
    frame = stripAnsi(i.i.lastFrame() ?? "");
    expect(frame).toContain("zai · 📌 glm-5.3-flash");
    i.i.unmount();
  });

  test("a burst of arrow presses inside one commit window moves the cursor every time (#930)", async () => {
    const { cwd, home } = fallbackSetup();
    const i = mount(cwd, { home });
    // Navigate by label, not by a counted walk: the subject here is the burst
    // inside one commit window, not the separate lost-press race above.
    await openFallback(i.i);
    // Three presses before Ink paints once — what a loaded runner delivers when
    // the keys pile up inside one commit window. Every press must move the
    // cursor: read from a closure, each one recomputes from the same sub-menu
    // cursor, the burst advances by one row and the last stop never reaches the
    // viewport (the CI flake #930 — the frame was honest, the cursor really was
    // one short).
    i.i.stdin.write("\x1b[B");
    i.i.stdin.write("\x1b[B");
    i.i.stdin.write("\x1b[B");
    await waitForCondition(
      () => overline(i.i.lastFrame() ?? "").includes("zai · 📌 glm-5.3-flash"),
      () => `for the burst to land on the zai stop — swallowed key; cursor is on: ${overline(i.i.lastFrame() ?? "")}`,
    );
    i.i.unmount();
  });

  test("picking a model writes the preferred model and NEVER switches the active provider", async () => {
    const { cwd, home } = fallbackSetup();
    const i = mount(cwd, { home });
    await openFallback(i.i); // fallback list
    await press(i.i, "\x1b[B", "cursor to openai"); // to openai
    i.i.stdin.write("\r"); // its model list
    await settle(i.i, "type to filter", "openai model list opened");
    // The model list opens on the endpoint's current model; pick another row.
    await press(i.i, "\x1b[B", "cursor to another model");
    i.i.stdin.write("\r");
    await toasted(i.i, i.toasts, "fallback: openai →");
    // The project endpoint's defaultModel changed in moh.json…
    const project = loadMohConfig(join(cwd, "moh.json"));
    const openai = project.endpoints!.find((e) => e.name === "openai")!;
    expect(openai.defaultModel).not.toBe("gpt-5");
    // …the active provider ref did NOT move (that is the whole point)…
    expect(project.provider).toBe("anthropic/claude-sonnet-4-5");
    expect(i.switched).toEqual([]);
    // …and the toast says so.
    expect(i.toasts.some((t) => t.includes("fallback: openai →"))).toBe(true);
    i.i.unmount();
  });

  test("picking a preferred model for a USER endpoint writes ~/.moh/config, not moh.json", async () => {
    const { cwd, home } = fallbackSetup();
    const i = mount(cwd, { home });
    await openFallback(i.i);
    await down(i.i, 2); // to zai (third row)
    i.i.stdin.write("\r");
    await settle(i.i, "type to filter", "zai model list opened");
    await press(i.i, "\x1b[B", "cursor to another model");
    i.i.stdin.write("\r");
    await toasted(i.i, i.toasts, "fallback: zai →");
    // The user-level endpoint is writable now (it used to be display-only).
    const user = readUserProviderConfig(join(home, ".moh", "config"));
    const zai = user.endpoints!.find((e) => e.name === "zai")!;
    expect(zai.defaultModel).toBeDefined();
    expect(zai.defaultModel).not.toBe("glm-5.3-flash");
    // moh.json is untouched: no user endpoint leaked into the project file.
    const project = loadMohConfig(join(cwd, "moh.json"));
    expect(project.endpoints!.some((e) => e.name === "zai")).toBe(false);
    i.i.unmount();
  });

  test("`x` excludes the whole provider while keeping its preferred model, and puts it back", async () => {
    const { cwd, home } = fallbackSetup();
    const i = mount(cwd, { home });
    await openFallback(i.i);
    i.i.stdin.write("x"); // exclude the first row (anthropic)
    await toasted(i.i, i.toasts, "anthropic excluded from the chain");
    await settle(i.i, "anthropic · ✗ excluded", "the excluded row repainted");
    const project = loadMohConfig(join(cwd, "moh.json"));
    const anthropic = project.endpoints!.find((e) => e.name === "anthropic")!;
    // The exclusion is the whole-provider switch: the preferred model stays.
    expect(anthropic.fallbackEligible).toBe(false);
    expect(anthropic.defaultModel).toBe("claude-sonnet-4-5");
    expect(i.toasts.some((t) => t.includes("anthropic excluded from the chain"))).toBe(true);
    expect(stripAnsi(i.i.lastFrame() ?? "")).toContain("anthropic · ✗ excluded · 📌 claude-sonnet-4-5");
    // …and the summary drops it from the eligible count.
    i.i.stdin.write("\x1b"); // back to the settings list
    await settle(i.i, "› Fallback models", "back on the settings list");
    expect(stripAnsi(i.i.lastFrame() ?? "")).toContain("Fallback models");
    i.i.stdin.write("\r"); // re-enter and put it back
    await settle(i.i, "› anthropic · ✗ excluded", "fallback list reopened");
    i.i.stdin.write("x");
    await toasted(i.i, i.toasts, "anthropic back in the chain");
    const after = loadMohConfig(join(cwd, "moh.json")).endpoints!.find((e) => e.name === "anthropic")!;
    // Re-including removes the key instead of writing `true`.
    expect("fallbackEligible" in after).toBe(false);
    expect(i.toasts.some((t) => t.includes("anthropic back in the chain"))).toBe(true);
    i.i.unmount();
  });

  test("`x` on a USER endpoint writes ~/.moh/config", async () => {
    const { cwd, home } = fallbackSetup();
    const i = mount(cwd, { home });
    await openFallback(i.i);
    await down(i.i, 2); // zai (user-level, third row)
    i.i.stdin.write("x");
    await toasted(i.i, i.toasts, "zai excluded from the chain");
    const user = readUserProviderConfig(join(home, ".moh", "config"));
    const zai = user.endpoints!.find((e) => e.name === "zai")!;
    expect(zai.fallbackEligible).toBe(false);
    expect(zai.defaultModel).toBe("glm-5.3-flash");
    // No user endpoint leaked into the project file.
    expect(loadMohConfig(join(cwd, "moh.json")).endpoints!.some((e) => e.name === "zai")).toBe(false);
    i.i.unmount();
  });

  test("`c` clears the preferred model and drops the endpoint out of the chain", async () => {
    const { cwd, home } = fallbackSetup();
    const i = mount(cwd, { home });
    await openFallback(i.i);
    i.i.stdin.write("c"); // clear the first row (anthropic)
    await toasted(i.i, i.toasts, "removed from the chain");
    await settle(i.i, "anthropic · — no preferred model", "the cleared row repainted");
    const project = loadMohConfig(join(cwd, "moh.json"));
    const anthropic = project.endpoints!.find((e) => e.name === "anthropic")!;
    // Cleared means ABSENT, not empty: the chain tests `!== undefined`.
    expect("defaultModel" in anthropic).toBe(false);
    expect(i.toasts.some((t) => t.includes("removed from the chain"))).toBe(true);
    expect(stripAnsi(i.i.lastFrame() ?? "")).toContain("anthropic · — no preferred model");
    i.i.unmount();
  });
});

/** The max-iterations toast for one value (the exact text: 50 is a prefix of 500). */
const iterToast = (value: string) => `max iterations: ${value} (new sessions)`;

describe("max iterations row (#498)", () => {
  test("cycles presets forward on enter and persists to moh.json; unlimited shows warning once", async () => {
    const cwd = setupCwd();
    const { i, toasts } = mount(cwd);
    await mounted(i);
    await gotoRow(i, "Max iterations/turn");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Max iterations/turn");
    i.stdin.write("\r"); // 50 → 100
    await toasted(i, toasts, iterToast("100"));
    i.stdin.write("\r"); // 100 → 200
    await toasted(i, toasts, iterToast("200"));
    expect(loadMohConfig(join(cwd, "moh.json")).maxIterations).toBe(200);
    // → unlimited (three more: 300? no: 200 → 500 → unlimited)
    i.stdin.write("\r"); // 200 → 500
    await toasted(i, toasts, iterToast("500"));
    i.stdin.write("\r"); // 500 → unlimited
    await toasted(i, toasts, iterToast("unlimited"));
    await settle(i, "unlimited", "the unlimited value painted");
    expect(loadMohConfig(join(cwd, "moh.json")).maxIterations).toBe(0);
    let frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("unlimited");
    expect(frame).toContain("anti-runaway");
    // Any keypress dismisses the warning; it stays dismissed on revisit.
    await press(i, "\x1b[B", "cursor off the max iterations row");
    frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).not.toContain("anti-runaway");
    expect(toasts.some((t) => t.includes("unlimited"))).toBe(true);
    i.unmount();
  });

  test("cycles backward on shift+tab (wraps unlimited → 500)", async () => {
    const cwd = setupCwd();
    const { i, toasts } = mount(cwd);
    await mounted(i);
    await gotoRow(i, "Max iterations/turn");
    // shift+tab from 50 wraps back to unlimited (warning shows).
    i.stdin.write("\x1b[Z");
    await toasted(i, toasts, iterToast("unlimited"));
    await settle(i, "unlimited", "the unlimited value painted");
    expect(loadMohConfig(join(cwd, "moh.json")).maxIterations).toBe(0);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("anti-runaway");
    i.stdin.write("\x1b[Z"); // unlimited → 500
    await toasted(i, toasts, iterToast("500"));
    expect(loadMohConfig(join(cwd, "moh.json")).maxIterations).toBe(500);
    i.unmount();
  });

  test("warning re-arms after leaving unlimited and returning", async () => {
    const cwd = setupCwd();
    const { i, toasts } = mount(cwd);
    await mounted(i);
    await gotoRow(i, "Max iterations/turn");
    i.stdin.write("\r"); // 50 → 100
    await toasted(i, toasts, iterToast("100"));
    i.stdin.write("\x1b[Z"); // back to 50 (dismiss-armed reset happens on non-unlimited)
    await toasted(i, toasts, iterToast("50"));
    i.stdin.write("\x1b[Z"); // 50 → unlimited (wrap): warning must appear
    await toasted(i, toasts, iterToast("unlimited"));
    await settle(i, "unlimited", "the unlimited value painted");
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
    await mounted(i);
    // The row can sit below the visible window (the settings list scrolls):
    // walk to it by label, as every other row test does, then read it.
    await gotoRow(i, "Max iterations/turn");
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("unlimited");
    i.unmount();
  });
});

describe("max iterations row (#498) — right arrow", () => {
  test("→ cycles presets forward like enter", async () => {
    const cwd = setupCwd();
    const { i, toasts } = mount(cwd);
    await mounted(i);
    await gotoRow(i, "Max iterations/turn");
    i.stdin.write("\x1b[C"); // →: 50 → 100
    await toasted(i, toasts, iterToast("100"));
    expect(loadMohConfig(join(cwd, "moh.json")).maxIterations).toBe(100);
    i.stdin.write("\x1b[C"); // →: 100 → 200
    await toasted(i, toasts, iterToast("200"));
    expect(loadMohConfig(join(cwd, "moh.json")).maxIterations).toBe(200);
    i.unmount();
  });

  test("MPM row (ADR-0026): cycles inherit → on → off → inherit and persists to moh.json", async () => {
    const cwd = setupCwd();
    const { i, toasts } = mount(cwd);
    await mounted(i);
    await gotoRow(i, "Moh Project Map");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Moh Project Map");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("inherit (global default)");
    // Each press toasts once: wait for the next toast before reading the file.
    const next = async (step: string) => {
      const before = toasts.length;
      i.stdin.write("\r");
      await until(i, () => toasts.length > before, step);
    };
    // inherit → on: writes mpm.enabled true into moh.json.
    await next("the MPM toggle to on");
    expect(loadMohConfig(join(cwd, "moh.json")).mpm?.enabled).toBe(true);
    expect(toasts.some((t) => t.includes("moh project map: on"))).toBe(true);
    // on → off.
    await next("the MPM toggle to off");
    expect(loadMohConfig(join(cwd, "moh.json")).mpm?.enabled).toBe(false);
    // off → inherit: the mpm section is removed entirely.
    await next("the MPM toggle back to inherit");
    await settle(i, "inherit (global default)", "the inherit value painted");
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
    await mounted(i);
    await gotoRow(i, "Moh Project Map");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("off (this project)");
    i.unmount();
  });
});

describe("user themes in settings (#749)", () => {
  /** Opens the theme studio from the "My themes…" row, input handler attached. */
  async function openStudio(i: View) {
    await mounted(i);
    await gotoRow(i, "My themes");
    i.stdin.write("\r");
    await settle(i, "theme studio", "theme studio opened");
  }

  test("theme row opens a picker with source labels; enter applies a user:<id> ref", async () => {
    const cwd = setupCwd();
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    mkdirSync(join(home, ".moh", "themes"), { recursive: true });
    writeFileSync(join(home, ".moh", "themes", "my-violet.json"), JSON.stringify({
      version: 1, id: "my-violet", name: "My Violet", extends: "tokyo-night",
      colors: { accent: "#b983ff" },
    }));
    const { i, changes } = mount(cwd, { home });
    await mounted(i);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await down(i, 1);
    i.stdin.write("\r"); // open theme picker
    await settle(i, "My Violet [u]", "theme picker opened");
    expect(frame()).toContain("[s]");
    // First user theme (the built-ins come before it), reached by label.
    for (let k = 0; k <= THEME_ORDER.length && !cursorLabel(i).startsWith("My Violet"); k++) {
      await press(i, "\x1b[B", "walking to the first user theme");
    }
    i.stdin.write("\r");
    await settle(i, "enter change · esc close", "theme picker closed");
    expect(changes).toContainEqual({ theme: "user:my-violet" });
    i.unmount();
  });

  test("My themes… opens the theme studio; sliders derive colors; naming saves & applies", async () => {
    const cwd = setupCwd();
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    const { i, changes, toasts } = mount(cwd, { home });
    await openStudio(i);
    // studio rows: hue(0) brightness(1) — adjust hue then rename+save
    // The hue only recolors the preview (no visible text change under the
    // test's colorless output); the studio's handler is already attached.
    i.stdin.write("\x1b[C"); // hue +6°
    i.stdin.write("n"); // name & save
    await settle(i, "theme name:", "the name prompt");
    i.stdin.write("My Neon");
    await settle(i, "My Neon", "the typed name echoed");
    i.stdin.write("\r"); // save & apply
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
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await openStudio(i);
    i.stdin.write("s"); // split on → focus lands on 'ok'
    await settle(i, "› ✓ ok", "split mode, focus on the first override");
    expect(frame().includes("› ✓ ok")).toBe(true); // focus moved to the first override
    await repaint(i, "\x1b[C", "pick the first basic color"); // pick first basic color
    await settle(i, "red", "the red pick");
    await repaint(i, "\r", "enter on the override row"); // enter → back to auto, NOT close
    expect(frame()).toContain("theme studio");
    expect(frame()).toContain("auto");
    expect(changes.every((c) => !("theme" in c))).toBe(true); // nothing applied
    i.unmount();
  });

  test("studio: 'n' opens the name prompt from an override row; esc returns to the studio", async () => {
    const cwd = setupCwd();
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    const { i, changes } = mount(cwd, { home });
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await openStudio(i);
    i.stdin.write("s"); // split mode, focus on 'ok' override
    await settle(i, "› ✓ ok", "split mode, focus on the first override");
    i.stdin.write("n"); // 'n' must NOT be swallowed here
    await settle(i, "theme name:", "the name prompt");
    i.stdin.write("\x1b"); // esc → back to the studio, not settings
    await settle(i, "theme name:", "esc out of the name prompt", { absent: true });
    expect(frame()).toContain("theme studio");
    expect(changes.every((c) => !("theme" in c))).toBe(true);
    i.unmount();
  });

  test("studio: create a theme, then delete it from the manage view (r → d)", async () => {
    const cwd = setupCwd();
    const home = mkdtempSync(join(tmpdir(), "moh-home-"));
    const { i, changes } = mount(cwd, { home });
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await openStudio(i);
    i.stdin.write("n");
    await settle(i, "theme name:", "the name prompt");
    i.stdin.write("Temp");
    await settle(i, "Temp", "the typed name echoed");
    i.stdin.write("\r");
    await until(i, () => changes.some((c) => "theme" in c), "the save");
    expect(existsSync(join(home, ".moh", "themes", "temp.json"))).toBe(true);
    // back into settings → studio → manage view → delete
    i.stdin.write("\x1b"); // studio → settings
    await settle(i, "enter change · esc close", "back on the settings list");
    i.stdin.write("\r"); // settings → studio again
    await settle(i, "theme studio", "theme studio reopened");
    i.stdin.write("r");
    await settle(i, "my themes", "the manage view");
    expect(frame()).toContain("Temp");
    i.stdin.write("d"); // delete the active theme
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
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await openStudio(i);
    i.stdin.write("r");
    // wait for the manage view to actually LIST the theme, not just for the heading
    await settle(i, "› Live", "the manage list");
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
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await mounted(i);
    await down(i, 1);
    i.stdin.write("\r"); // picker
    await settle(i, "Gone [u]", "theme picker opened");
    // First user theme: "Gone" (the picker opens on the active theme, which
    // is this one; walk by label so a clamped press never stalls the test).
    for (let k = 0; k <= THEME_ORDER.length && !cursorLabel(i).startsWith("Gone"); k++) {
      await press(i, "\x1b[B", "walking to the first user theme");
    }
    i.stdin.write("d");
    await waitForFrame(frame, "enter change · esc close");
    expect(existsSync(join(home, ".moh", "themes", "gone.json"))).toBe(false);
    // #749: deleting the active theme falls back to its extends base, not a
    // hardcoded preset.
    expect(changes).toContainEqual({ theme: "candy" });
    i.unmount();
  });
});

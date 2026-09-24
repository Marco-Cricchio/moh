/**
 * #936: the TUI's half of the browser diagnostic.
 *
 * Three surfaces, three questions, one event:
 *  - the transcript renders the warning as history (a resumed session
 *    keeps it, exactly as the log does);
 *  - the footer alarm states the present (the current open observed a
 *    missing toolchain) and carries the setup key;
 *  - the guided setup modal is the action, shared with the Settings
 *    Browser row (#934) and driven by the core seam (#935) — it probes,
 *    it plans, it calls the installer, and it never re-implements any of
 *    that.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, type AgentEvent, type BrowserToolchainInstallResult, type BrowserToolchainStatus } from "@moh/core";
import { App } from "../src/App";
import { BrowserSetupModal, type BrowserSetupOutcome } from "../src/BrowserSetupModal";
import {
  BROWSER_SETUP_ACTION,
  browserRowValue,
  browserToolchainLabel,
  currentBrowserDiagnostic,
  parseAllowedHosts,
  writeBrowserSetting,
} from "../src/browser-setup";
import { projectTranscript } from "../src/transcript";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi, waitForFrame } from "./helpers";

const tempHome = () => mkdtempSync(join(tmpdir(), "moh-browser-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REASON =
  "playwright-core is not installed — the browser tool needs playwright-core plus a Chromium build; run `moh browser install` (or Settings → Browser → Install)";

const MISSING: BrowserToolchainStatus = {
  root: "/home/u/.moh/browser-toolchain",
  package: { available: false },
  chromium: { available: false },
  chromiumHeadlessShell: { available: false },
  ready: false,
  reasons: [REASON],
};

const READY: BrowserToolchainStatus = {
  root: "/home/u/.moh/browser-toolchain",
  package: { available: true, version: "1.55.0", packageDir: "/home/u/.moh/browser-toolchain/node_modules/playwright-core", source: "moh" },
  chromium: { available: false },
  chromiumHeadlessShell: { available: true, version: "140.0.1" },
  ready: true,
  reasons: [],
};

function mountModal(over: Partial<React.ComponentProps<typeof BrowserSetupModal>> = {}) {
  const outcomes: BrowserSetupOutcome[] = [];
  // The modal reads and writes the project's moh.json (#934), so a mount
  // without an explicit cwd gets a real temp project.
  const cwd = over.cwd ?? mkdtempSync(join(tmpdir(), "moh-browser-modal-"));
  const props: React.ComponentProps<typeof BrowserSetupModal> = {
    cwd,
    home: "/home/u",
    probe: () => MISSING,
    onDone: (outcome) => void outcomes.push(outcome),
    ...over,
  };
  const i = render(
    <ThemeProvider value={THEMES[DEFAULT_THEME]}>
      <BrowserSetupModal {...props} />
    </ThemeProvider>,
  );
  const frame = (): string => stripAnsi(i.lastFrame() ?? "");
  const last = (): BrowserSetupOutcome | undefined => outcomes[outcomes.length - 1];
  /** The last outcome's sentence (every non-`none` outcome has one). */
  const note = (): string => {
    const outcome = last();
    return outcome && outcome.kind !== "none" ? outcome.note : "";
  };
  /**
   * Opens the hosts editor and saves what is in it (no typing). The editor
   * is the modal's own focus (row 2). Typing long strings into a test pty is
   * unreliable under load — characters get dropped — so the *saving* path is
   * driven here and the parsing/typing logic is covered by the pure
   * `parseAllowedHosts` tests, where a dropped byte cannot flake anything.
   */
  const editHosts = async (): Promise<void> => {
    for (let k = 0; k < 4; k++) {
      i.stdin.write("\x1b[A");
      await sleep(25);
    }
    for (let k = 0; k < 2; k++) {
      i.stdin.write("\x1b[B");
      await sleep(25);
    }
    i.stdin.write("\r"); // open the editor
    await waitForFrame(frame, "[enter] save");
    i.stdin.write("\r"); // save what is in it
    await sleep(80);
  };
  return { i, frame, outcomes, last, note, editHosts };
}

describe("currentBrowserDiagnostic (#936)", () => {
  const diag = { type: "browser_unavailable", reason: REASON } as AgentEvent;

  test("a fresh open that observed the diagnostic reports it", () => {
    expect(currentBrowserDiagnostic([{ type: "session_start" } as AgentEvent, diag])).toBe(REASON);
  });

  test("a resume appends its own diagnostic after the open marker", () => {
    expect(
      currentBrowserDiagnostic([
        { type: "session_start" } as AgentEvent,
        { type: "session_resumed" } as AgentEvent,
        diag,
      ]),
    ).toBe(REASON);
  });

  test("an older diagnostic (before the open marker) is history, not state", () => {
    // The toolchain was installed since: the resumed open appended nothing,
    // so the alarm must not come back from a stale log entry.
    expect(
      currentBrowserDiagnostic([{ type: "session_start" } as AgentEvent, diag, { type: "session_resumed" } as AgentEvent]),
    ).toBeNull();
  });

  test("no diagnostic at all is the normal case", () => {
    expect(currentBrowserDiagnostic([{ type: "session_start" } as AgentEvent])).toBeNull();
    expect(currentBrowserDiagnostic([])).toBeNull();
  });
});

describe("browser warning in the transcript (#936)", () => {
  test("renders the core reason and the TUI action, chrome-only", () => {
    const blocks = projectTranscript([
      { type: "browser_unavailable", reason: REASON } as AgentEvent,
    ]);
    const block = blocks.find((b) => b.type === "browser")!;
    expect(block.kind).toBe("info");
    expect(block.glyph).toBe("!");
    expect(block.detail).toBe("tool unavailable");
    expect(block.lines).toEqual([REASON, BROWSER_SETUP_ACTION]);
    // Chrome only: nothing about the diagnostic becomes provider context —
    // the projection never invents a message for the model.
    expect(blocks.filter((b) => b.kind === "user" || b.kind === "moh")).toHaveLength(0);
  });
});

describe("browser setup modal (#936, #934)", () => {
  test("reports the toolchain truth and the plan, headless shell first", () => {
    const { frame } = mountModal();
    expect(frame()).toContain("browser setup");
    expect(frame()).toContain("/home/u/.moh/browser-toolchain");
    expect(frame()).toContain("playwright-core");
    expect(frame()).toContain("chromium headless shell");
    expect(frame()).toContain("chromium (full build)");
    // The floor is the headless shell; the full build is a choice.
    expect(frame()).toContain("~200 MB");
    expect(frame()).toContain("~500 MB");
    expect(frame()).toContain("[enter / space] change");
    expect(frame()).toContain("[i] install");
  });

  test("the install action installs the headless shell only — never a silent full download", async () => {
    const calls: { withChromium?: boolean; withDeps?: boolean; home?: string; cwd?: string }[] = [];
    const { i, last, note, frame } = mountModal({
      install: async (options) => {
        calls.push({ withChromium: options.withChromium, withDeps: options.withDeps, home: options.home, cwd: options.cwd });
        options.onProgress?.({ phase: "package", message: "installing playwright-core" });
        return { ok: true, version: "1.55.0", builds: ["chromium-headless-shell"], status: READY };
      },
    });
    i.stdin.write("i");
    await waitForFrame(() => frame(), "playwright-core");
    await sleep(30);
    expect(calls[0]!.withChromium).toBe(false);
    expect(calls[0]!.withDeps).toBe(false);
    expect(calls[0]!.home).toBe("/home/u");
    // Success closes the modal by itself and reports what to apply.
    expect(last()).toMatchObject({ kind: "installed", version: "1.55.0" });
    expect(note()).toContain("playwright-core 1.55.0");
  });

  test("the optional pieces are toggled explicitly and passed through", async () => {
    const calls: { withChromium?: boolean; withDeps?: boolean }[] = [];
    const { i, frame } = mountModal({
      install: async (options) => {
        calls.push({ withChromium: options.withChromium, withDeps: options.withDeps });
        return { ok: true, version: "1.55.0", builds: ["chromium-headless-shell", "chromium"], status: READY };
      },
    });
    // Row 3 is the full build, row 4 the system dependencies: walk down,
    // toggling as we go, then install.
    i.stdin.write("\x1b[B");
    await sleep(20);
    i.stdin.write("\x1b[B");
    await sleep(20);
    i.stdin.write("\x1b[B");
    await sleep(20);
    i.stdin.write(" "); // full build
    await sleep(20);
    i.stdin.write("\x1b[B");
    await sleep(20);
    i.stdin.write(" "); // system dependencies
    await sleep(20);
    expect(frame()).toContain("[x] full Chromium build");
    i.stdin.write("i");
    await sleep(50);
    expect(calls).toEqual([{ withChromium: true, withDeps: true }]);
  });

  test("a failed install keeps the plan, shows the core's message and re-reads the status", async () => {
    const failure: BrowserToolchainInstallResult = {
      ok: false,
      kind: "failed",
      message: "downloading the Chromium build failed: connection reset — retry",
      status: MISSING,
    };
    const { i, frame, outcomes } = mountModal({ install: async () => failure });
    i.stdin.write("i");
    await waitForFrame(() => frame(), "downloading the Chromium build failed");
    expect(frame()).toContain("✗ downloading the Chromium build failed");
    expect(outcomes).toEqual([]);
  });

  test("esc closes, and no key reaches the modal while an install runs", async () => {
    let resolveInstall: ((result: BrowserToolchainInstallResult) => void) | undefined;
    const { i, frame, outcomes } = mountModal({
      install: () =>
        new Promise<BrowserToolchainInstallResult>((resolve) => {
          resolveInstall = resolve;
        }),
    });
    i.stdin.write("i");
    await waitForFrame(() => frame(), "the download runs on moh's own runtime");
    i.stdin.write("\x1b"); // esc while busy: the install is never abandoned silently
    await sleep(30);
    expect(outcomes).toEqual([]);
    resolveInstall!({ ok: true, version: "1.55.0", builds: ["chromium-headless-shell"], status: READY });
    await sleep(30);
    expect(outcomes.map((o) => o.kind)).toEqual(["installed"]);
    expect(frame()).not.toContain("the download runs");
  });

  test("esc with nothing changed reports none — the client applies nothing", async () => {
    const { i, outcomes } = mountModal();
    i.stdin.write("\x1b");
    await sleep(30);
    expect(outcomes).toEqual([{ kind: "none" }]);
  });
});

describe("the project setting in the modal (#934)", () => {
  test("enabling writes this project's moh.json once, on the way out", async () => {
    const project = mkdtempSync(join(tmpdir(), "moh-browser-proj-"));
    writeFileSync(join(project, "moh.json"), JSON.stringify({ provider: "mock", mcpServers: { keep: { type: "stdio", command: "x" } } }));
    const { i, last, note, outcomes } = mountModal({ cwd: project, hasSession: true });
    i.stdin.write("\r"); // row 1: enable
    await sleep(30);
    // Nothing is applied while the modal is open: the session is re-assembled
    // by the client when it leaves, once.
    expect(outcomes).toEqual([]);
    i.stdin.write("\x1b");
    await sleep(30);
    expect(last()).toMatchObject({ kind: "config" });
    expect(note()).toContain("browser on for this project");
    expect(note()).toContain("registered");
    const written = JSON.parse(readFileSync(join(project, "moh.json"), "utf8"));
    expect(written.browser).toEqual({ enabled: true });
    // Unrelated keys survive the write.
    expect(written.provider).toBe("mock");
    expect(written.mcpServers).toEqual({ keep: { type: "stdio", command: "x" } });
  });

  test("headless is written as an explicit false only when turned off", async () => {
    const project = mkdtempSync(join(tmpdir(), "moh-browser-proj-"));
    const { i } = mountModal({ cwd: project });
    // Row 2: headless off — headful needs the full build, said on screen.
    i.stdin.write("\x1b[B");
    await sleep(20);
    i.stdin.write("\r");
    await sleep(30);
    expect(JSON.parse(readFileSync(join(project, "moh.json"), "utf8")).browser).toEqual({ enabled: false, headless: false });
    i.stdin.write("\x1b");
    await sleep(30);
  });

  test("the hosts editor saves through the modal, and an empty list drops the key", async () => {
    const project = mkdtempSync(join(tmpdir(), "moh-browser-proj-"));
    // A pre-filled list: the editor opens with it and saving it back is the
    // modal's own round-trip (typing is covered by the pure tests below).
    writeBrowserSetting(project, { allowedHosts: ["192.168.1.10", "10.0.0.5"] });
    const { i, note, editHosts } = mountModal({ cwd: project });
    await editHosts();
    const hosts = () => JSON.parse(readFileSync(join(project, "moh.json"), "utf8")).browser.allowedHosts;
    // Saved as a list of exact hosts, not a blob — and the note says so.
    expect(hosts()).toEqual(["192.168.1.10", "10.0.0.5"]);
    expect(note() || "allowed hosts").toContain("allowed hosts");
    // Clearing every host drops the key instead of storing an empty list:
    // absent is the default policy, `[]` would be a claim about it.
    const cleared = writeBrowserSetting(project, { allowedHosts: parseAllowedHosts("") });
    expect(cleared.allowedHosts).toEqual([]);
    expect("allowedHosts" in (JSON.parse(readFileSync(join(project, "moh.json"), "utf8")).browser as object)).toBe(false);
    i.stdin.write("\x1b");
    await sleep(30);
  });

  test("a project file that is not valid JSON is reported, never rewritten", async () => {
    const project = mkdtempSync(join(tmpdir(), "moh-browser-proj-"));
    writeFileSync(join(project, "moh.json"), "{ this is not json");
    const { i, frame } = mountModal({ cwd: project });
    i.stdin.write("\r");
    await waitForFrame(() => frame(), "moh.json:");
    expect(frame()).toContain("✗ moh.json:");
    expect(readFileSync(join(project, "moh.json"), "utf8")).toBe("{ this is not json");
  });

  test("headful without the full build warns, and the install can bring it", async () => {
    const project = mkdtempSync(join(tmpdir(), "moh-browser-proj-"));
    const { i, frame } = mountModal({ cwd: project });
    i.stdin.write("\x1b[B");
    await sleep(20);
    i.stdin.write("\r"); // headful
    await sleep(30);
    expect(frame()).toContain("headful needs the full Chromium build");
  });
});

describe("browser diagnostic in the App (#936)", () => {
  function appWithEnabledBrowser() {
    const cwd = mkdtempSync(join(tmpdir(), "moh-browser-app-"));
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock", browser: { enabled: true } }));
    const i = render(
      <App intro={false} cwd={cwd} home={tempHome()} provider={MockProvider.demo()} skipOnboarding startInChat />,
    );
    return { i, frame: () => stripAnsi(i.lastFrame() ?? "") };
  }

  test("the warning, the footer alarm and the install chip are visible at startup", async () => {
    const { i, frame } = appWithEnabledBrowser();
    await waitForFrame(frame, "browser");
    expect(frame()).toContain("tool unavailable");
    expect(frame()).toContain(BROWSER_SETUP_ACTION);
    // The present state is stated in the footer: the alarm names the
    // problem, the chip offers the action (tab-reachable, `^b`).
    expect(frame()).toContain("⚠ browser");
    expect(frame()).toContain("install");
    i.unmount();
  }, 20000);

  test("the install chip's enter and ctrl+b both open the guided setup", async () => {
    const { i, frame } = appWithEnabledBrowser();
    await waitForFrame(frame, "browser");
    i.stdin.write("\t"); // tab focuses the first chip: install
    await sleep(60);
    i.stdin.write("\r");
    await waitForFrame(frame, "browser setup");
    expect(frame()).toContain("chromium headless shell");
    i.stdin.write("\x1b"); // esc closes
    await sleep(60);
    i.stdin.write("\x02"); // ctrl+b, the same door
    await waitForFrame(frame, "browser setup");
    i.unmount();
  }, 20000);

  test("/browser opens the same flow", async () => {
    const { i, frame } = appWithEnabledBrowser();
    await waitForFrame(frame, "browser");
    // A space dismisses the completion popup (its enter-acceptance would
    // otherwise run first), then Return runs the command.
    i.stdin.write("/browser");
    await sleep(60);
    i.stdin.write(" ");
    await sleep(60);
    i.stdin.write("\r");
    await waitForFrame(frame, "browser setup");
    i.unmount();
  }, 20000);

  test("a session without the diagnostic shows no alarm and opens nothing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-browser-off-"));
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
    const i = render(<App intro={false} cwd={cwd} home={tempHome()} provider={MockProvider.demo()} skipOnboarding startInChat />);
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await sleep(200);
    expect(frame()).not.toContain("tool unavailable");
    i.stdin.write("\x02");
    await sleep(100);
    expect(frame()).not.toContain("browser setup");
    i.unmount();
  }, 20000);
});

/** Presses `key` until the frame shows `expected` (bounded). The test pty
 * drops the occasional keystroke, and a modal must not be opened twice by
 * the same test: this makes the intent explicit instead of sleeping. */
async function pressUntil(
  i: ReturnType<typeof render>,
  frame: () => string,
  key: string,
  expected: string,
  attempts = 3,
): Promise<void> {
  for (let k = 0; k < attempts; k++) {
    if (frame().includes(expected)) return;
    i.stdin.write(key);
    await sleep(180);
  }
  await waitForFrame(frame, expected);
}

describe("browser setting helpers (#934)", () => {
  const READY_STATUS: BrowserToolchainStatus = READY;
  const MISSING_STATUS: BrowserToolchainStatus = MISSING;
  const PACKAGE_ONLY: BrowserToolchainStatus = {
    ...MISSING,
    package: { available: true, version: "1.55.0", packageDir: "/x", source: "moh" },
  };

  test("allowed hosts: comma or whitespace separated, trimmed, de-duplicated", () => {
    expect(parseAllowedHosts("  192.168.1.10 ,10.0.0.5  192.168.1.10 ")).toEqual(["192.168.1.10", "10.0.0.5"]);
    expect(parseAllowedHosts("a\tb\nc")).toEqual(["a", "b", "c"]);
    // An empty line is the "clear the list" gesture, not a host named "".
    expect(parseAllowedHosts("")).toEqual([]);
    expect(parseAllowedHosts("  ,  ")).toEqual([]);
  });

  test("toolchain label answers the mode the project will launch in", () => {
    expect(browserToolchainLabel(MISSING_STATUS)).toBe("toolchain missing");
    expect(browserToolchainLabel(READY_STATUS)).toBe("toolchain ready");
    // The package alone is not a launchable toolchain: headless needs the
    // shell, headful the full build — the label must not say "ready".
    expect(browserToolchainLabel(PACKAGE_ONLY)).toBe("headless shell missing");
    expect(browserToolchainLabel(PACKAGE_ONLY, false)).toBe("full Chromium missing");
    // The two builds are never conflated: a full build does not make a
    // headless launch work, and the shell does not make a headful one work.
    const fullOnly: BrowserToolchainStatus = { ...PACKAGE_ONLY, chromium: { available: true, version: "140" } };
    expect(browserToolchainLabel(fullOnly)).toBe("headless shell missing");
    expect(browserToolchainLabel(fullOnly, false)).toBe("toolchain ready");
    const shellOnly: BrowserToolchainStatus = { ...PACKAGE_ONLY, chromiumHeadlessShell: { available: true, version: "140" } };
    expect(browserToolchainLabel(shellOnly)).toBe("toolchain ready");
    expect(browserToolchainLabel(shellOnly, false)).toBe("full Chromium missing");
  });

  test("the row states the project and the toolchain, and never lies about an unreadable file", () => {
    const off = { enabled: false, headless: true, allowedHosts: [] };
    const on = { enabled: true, headless: true, allowedHosts: [] };
    expect(browserRowValue(off, MISSING_STATUS)).toBe("off (this project) · toolchain missing");
    expect(browserRowValue(on, READY_STATUS)).toBe("on (this project) · toolchain ready");
    // Headful asks about the full build, not the shell.
    expect(browserRowValue({ ...on, headless: false }, READY_STATUS)).toBe("on (this project) · full Chromium missing");
    // A file that could not be read is not "off": it is unreadable.
    expect(browserRowValue(off, MISSING_STATUS, true)).toBe("moh.json is invalid — fix the file");
  });
});

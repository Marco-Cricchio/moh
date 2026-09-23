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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, type AgentEvent, type BrowserToolchainInstallResult, type BrowserToolchainStatus } from "@moh/core";
import { App } from "../src/App";
import { BrowserSetupModal } from "../src/BrowserSetupModal";
import { BROWSER_SETUP_ACTION, currentBrowserDiagnostic } from "../src/browser-setup";
import { projectTranscript } from "../src/transcript";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi, waitForFrame } from "./helpers";

const tempHome = () => mkdtempSync(join(tmpdir(), "moh-browser-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REASON =
  "browser tool disabled: playwright-core is not installed — the browser tool needs playwright-core plus a Chromium build; run `moh browser install` (or Settings → Browser → Install)";

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
  const installed: { version: string }[] = [];
  let closed = 0;
  const props: React.ComponentProps<typeof BrowserSetupModal> = {
    cwd: "/proj",
    home: "/home/u",
    probe: () => MISSING,
    onInstalled: (result) => void installed.push(result),
    onClose: () => {
      closed += 1;
    },
    ...over,
  };
  const i = render(
    <ThemeProvider value={THEMES[DEFAULT_THEME]}>
      <BrowserSetupModal {...props} />
    </ThemeProvider>,
  );
  return { i, frame: () => stripAnsi(i.lastFrame() ?? ""), installed, closed: () => closed };
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

describe("browser setup modal (#936)", () => {
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
    expect(frame()).toContain("[enter / i] install");
  });

  test("enter installs the headless shell only — never a silent full download", async () => {
    const calls: { withChromium?: boolean; withDeps?: boolean; home?: string; cwd?: string }[] = [];
    const { i, installed, frame } = mountModal({
      install: async (options) => {
        calls.push({ withChromium: options.withChromium, withDeps: options.withDeps, home: options.home, cwd: options.cwd });
        options.onProgress?.({ phase: "package", message: "installing playwright-core" });
        return { ok: true, version: "1.55.0", builds: ["chromium-headless-shell"], status: READY };
      },
    });
    i.stdin.write("\r");
    await waitForFrame(() => frame(), "playwright-core");
    await sleep(30);
    expect(calls).toEqual([{ withChromium: false, withDeps: false, home: "/home/u", cwd: "/proj" }]);
    // Success hands over to the client (which re-assembles the session).
    expect(installed).toEqual([{ version: "1.55.0" }]);
  });

  test("the optional pieces are toggled explicitly and passed through", async () => {
    const calls: { withChromium?: boolean; withDeps?: boolean }[] = [];
    const { i, frame } = mountModal({
      install: async (options) => {
        calls.push({ withChromium: options.withChromium, withDeps: options.withDeps });
        return { ok: true, version: "1.55.0", builds: ["chromium-headless-shell", "chromium"], status: READY };
      },
    });
    // Toggle the full build, then the system dependencies.
    i.stdin.write(" ");
    await sleep(20);
    i.stdin.write("\x1b[B"); // ↓
    await sleep(20);
    i.stdin.write(" ");
    await sleep(20);
    expect(frame()).toContain("[x] full Chromium build");
    i.stdin.write("\r");
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
    const { i, frame, installed } = mountModal({ install: async () => failure });
    i.stdin.write("\r");
    await waitForFrame(() => frame(), "retry the install");
    expect(frame()).toContain("✗ downloading the Chromium build failed");
    expect(installed).toEqual([]);
  });

  test("esc closes, and no key reaches the modal while an install runs", async () => {
    let resolveInstall: ((result: BrowserToolchainInstallResult) => void) | undefined;
    const { i, frame, closed } = mountModal({
      install: () =>
        new Promise<BrowserToolchainInstallResult>((resolve) => {
          resolveInstall = resolve;
        }),
    });
    i.stdin.write("\r");
    await waitForFrame(() => frame(), "the download runs on moh's own runtime");
    i.stdin.write("\x1b"); // esc while busy: the install is never abandoned silently
    await sleep(30);
    expect(closed()).toBe(0);
    resolveInstall!({ ok: true, version: "1.55.0", builds: ["chromium-headless-shell"], status: READY });
    await sleep(30);
    expect(closed()).toBe(0);
    i.stdin.write("\x1b");
    await sleep(30);
    expect(closed()).toBe(1);
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

  test("the warning is visible at startup and ctrl+b opens the guided setup", async () => {
    const { i, frame } = appWithEnabledBrowser();
    await waitForFrame(frame, "browser");
    expect(frame()).toContain("tool unavailable");
    expect(frame()).toContain(BROWSER_SETUP_ACTION);
    // The footer alarm states the present and carries the key (the label
    // is width-class aware: compact below 110 columns).
    expect(frame()).toContain("browser");
    i.stdin.write("\x02"); // ctrl+b
    await waitForFrame(frame, "browser setup");
    expect(frame()).toContain("chromium headless shell");
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

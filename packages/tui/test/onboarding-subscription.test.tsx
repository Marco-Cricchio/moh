/**
 * TUI onboarding wizard — subscription branch (issue #149): auth-method
 * step (never for openai-compat), ToS screen, overlay-driven OAuth flow
 * (authorize URL shown, browser opened via the openUrl seam, paste-code
 * input, completion), tokens + endpoint stub persisted right after login,
 * model + connection test as usual, and no token/code material on screen.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOS_WARNING, getStoredToken, readUserConfigFile, subscriptionModelCatalog, type AuthToken, type AuthorizationIo } from "@moh/core";
import { Onboarding } from "../src/OnboardingOverlay";
import { stripAnsi, waitForCondition, waitForFrame } from "./helpers";

const sleep = (ms: number) => Promise.resolve().then(() => new Promise((r) => setTimeout(r, ms)));
const tempHome = () => mkdtempSync(join(tmpdir(), "moh-sub-home-"));
const tempCwd = () => mkdtempSync(join(tmpdir(), "moh-sub-"));
const okTester = async () => ({ ok: true as const, modelId: "tested" });

const TOKEN: AuthToken = { accessToken: "at-secret-value", refreshToken: "rt-secret-value", updatedAt: 1 };

/** A scripted grant: shows URLs, opens the browser, demands a pasted code. */
const scriptedLogin = async (io: AuthorizationIo, code = "CODE-123"): Promise<AuthToken> => {
  await io.info("Authorize via:\n  https://provider.example/oauth/manual");
  if (io.openUrl) await io.openUrl("https://provider.example/oauth/auto");
  const pasted = await io.ask("Paste code here: ");
  await io.info("✓ Authorization code received — exchanging tokens…");
  if (pasted !== code) throw new Error("authorization failed: invalid code");
  return TOKEN;
};


describe("onboarding wizard — subscription branch (#149)", () => {
  test("auth-method step appears for anthropic but never for openai-compat", async () => {
    const i1 = render(<Onboarding cwd={tempCwd()} home={tempHome()} env={{}} tester={okTester} onDone={() => {}} />);
    await sleep(60);
    i1.stdin.write("\r"); // anthropic
    await sleep(60);
    expect(stripAnsi(i1.lastFrame() ?? "")).toContain("How does anthropic authenticate?");
    i1.unmount();

    const i2 = render(<Onboarding cwd={tempCwd()} home={tempHome()} env={{}} tester={okTester} onDone={() => {}} />);
    await sleep(60);
    for (let d = 0; d < 3; d++) {
      i2.stdin.write("\x1b[B");
      await sleep(10);
    }
    i2.stdin.write("\r"); // openai-compat → model directly (byte-identical path)
    await sleep(60);
    const frame = stripAnsi(i2.lastFrame() ?? "");
    expect(frame).toContain("Default model");
    expect(frame).not.toContain("authenticate?");
    i2.unmount();
  });

  test("full subscription flow: ToS → login → stub+tokens → model → test → user-level save", async () => {
    const cwd = tempCwd();
    const home = tempHome();
    const userFile = join(home, ".moh", "config");
    const done: (string | null)[] = [];
    const opened: string[] = [];
    let logins = 0;
    const i = render(
      <Onboarding
        cwd={cwd}
        home={home}
        env={{}}
        tester={okTester}
        subscriptionLogin={async (io) => {
          logins++;
          return scriptedLogin(io);
        }}
        openUrl={async (url) => {
          opened.push(url);
          return true;
        }}
        onDone={(ref) => done.push(ref)}
      />,
    );
    await sleep(60);
    i.stdin.write("\r"); // anthropic
    await sleep(60);
    i.stdin.write("\x1b[B"); // down → subscription
    await sleep(60);
    i.stdin.write("\r");
    await sleep(60);

    // ToS screen first (spec invariant 4) — same text as the CLI.
    const tos = stripAnsi(i.lastFrame() ?? "");
    expect(tos).toContain("Terms of service");
    expect(tos).toContain(TOS_WARNING.slice(0, 40));
    i.stdin.write("y");
    await sleep(80);

    // Login screen: manual URL visible, browser opened via the seam.
    const loginFrame = stripAnsi(i.lastFrame() ?? "");
    expect(loginFrame).toContain("https://provider.example/oauth/manual");
    expect(opened).toEqual(["https://provider.example/oauth/auto"]);
    expect(loginFrame).toContain("Paste code here");

    // Pasted code is masked on screen (redaction).
    i.stdin.write("CODE-123");
    await sleep(60);
    const masked = stripAnsi(i.lastFrame() ?? "");
    expect(masked).not.toContain("CODE-123");
    expect(masked).toContain("********");
    i.stdin.write("\r");
    await sleep(80);

    // Completion (#156): post-login model list — no typing required. The
    // catalog names are shown, with a manual free-text row at the bottom.
    const modelFrame = stripAnsi(i.lastFrame() ?? "");
    expect(modelFrame).toContain("tokens stored in");
    expect(modelFrame).toContain("Pick your default model");
    expect(modelFrame).toContain("enter a model id manually");
    const first = subscriptionModelCatalog("anthropic")[0]!;
    expect(modelFrame).toContain(first.id);
    i.stdin.write("\r"); // select the first catalog entry
    await sleep(60);
    // Selection goes straight to the connection test (no key, no base URL).
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Testing connection");
    await sleep(150);

    expect(done).toEqual([`anthropic/${first.id}`]);
    expect(logins).toBe(1);

    // Tokens live in ~/.moh/config (never moh.json); endpoint completed.
    const user = readUserConfigFile(userFile);
    expect(getStoredToken(userFile, "anthropic")?.accessToken).toBe("at-secret-value");
    expect((user.endpoints as { name: string }[] ?? []).find((e) => e.name === "anthropic")).toMatchObject({
      type: "anthropic",
      auth: { kind: "subscription" },
      defaultModel: first.id,
    });
    // No token material in the rendered frames.
    for (const frame of [tos, loginFrame, masked, modelFrame]) {
      expect(frame).not.toContain("at-secret-value");
      expect(frame).not.toContain("rt-secret-value");
    }
    i.unmount();
  });

  test("endpoint stub is persisted immediately after login, before the model prompt", async () => {
    const home = tempHome();
    const userFile = join(home, ".moh", "config");
    const i = render(
      <Onboarding
        cwd={tempCwd()}
        home={home}
        env={{}}
        tester={okTester}
        subscriptionLogin={async (io) => {
          // Stub + tokens must not exist before the login resolves (#150).
          const user = readUserConfigFile(userFile);
          expect((user.endpoints as { name: string }[] ?? []).find((e) => e.name === "anthropic")).toBeUndefined();
          return scriptedLogin(io);
        }}
        onDone={() => {}}
      />,
    );
    await sleep(60);
    i.stdin.write("\r");
    await sleep(60);
    i.stdin.write("\x1b[B");
    await sleep(60);
    i.stdin.write("\r");
    await sleep(60);
    i.stdin.write("y");
    await sleep(80);
    i.stdin.write("CODE-123");
    await sleep(60);
    i.stdin.write("\r");
    await sleep(80);

    // Right after login: stub + tokens are on disk even though the wizard
    // is still at the model prompt.
    const user = readUserConfigFile(userFile);
    expect((user.endpoints as { name: string }[] ?? []).find((e) => e.name === "anthropic")).toMatchObject({ auth: { kind: "subscription" } });
    expect(getStoredToken(userFile, "anthropic")).toBeDefined();
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Pick your default model");
    i.unmount();
  });

  test("#156: manual free-text entry stays available from the model list", async () => {
    const home = tempHome();
    const done: (string | null)[] = [];
    const i = render(
      <Onboarding
        cwd={tempCwd()}
        home={home}
        env={{}}
        tester={okTester}
        subscriptionLogin={async (io) => scriptedLogin(io)}
        onDone={(ref) => done.push(ref)}
      />,
    );
    await sleep(60);
    i.stdin.write("\r"); // anthropic
    await sleep(60);
    i.stdin.write("\x1b[B"); // subscription
    await sleep(60);
    i.stdin.write("\r");
    await sleep(60);
    i.stdin.write("y"); // ToS
    await sleep(80);
    i.stdin.write("CODE-123");
    await sleep(60);
    i.stdin.write("\r");
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await waitForFrame(frame, "Pick your default model");
    // Bottom row = free-text fallback (advanced).
    const list = frame();
    expect(list).toContain("Pick your default model");
    const down = subscriptionModelCatalog("anthropic").length;
    for (let d = 0; d < down; d++) {
      i.stdin.write("\x1b[B");
      await sleep(10);
    }
    i.stdin.write("\r"); // manual entry
    await waitForFrame(frame, "Default model");
    expect(frame()).toContain("Default model");
    i.stdin.write("claude-sonnet-4-5");
    await sleep(60);
    i.stdin.write("\r");
    await waitForCondition(
      () => done.length > 0,
      () => `onDone was not called; received: ${JSON.stringify(done)}`,
    );
    expect(done).toEqual(["anthropic/claude-sonnet-4-5"]);
    i.unmount();
  });

  test("declining the ToS returns to the auth-method step without logging in", async () => {
    const done: (string | null)[] = [];
    let logins = 0;
    const i = render(
      <Onboarding
        cwd={tempCwd()}
        home={tempHome()}
        env={{}}
        tester={okTester}
        subscriptionLogin={async (io) => {
          logins++;
          return scriptedLogin(io);
        }}
        onDone={(ref) => done.push(ref)}
      />,
    );
    await sleep(60);
    i.stdin.write("\r"); // anthropic
    await sleep(60);
    i.stdin.write("\x1b[B"); // subscription
    await sleep(60);
    i.stdin.write("\r");
    await sleep(60);
    i.stdin.write("n"); // decline
    await sleep(60);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("How does anthropic authenticate?");
    expect(logins).toBe(0);
    // Cursor remembers the declined choice; switching to api-key works.
    i.stdin.write("\x1b[A"); // up → api-key
    await sleep(60);
    i.stdin.write("\r"); // api-key
    await sleep(60);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Default model");
    i.unmount();
  });

  test("login failure offers retry / method change / skip; retry succeeds", async () => {
    const home = tempHome();
    const done: (string | null)[] = [];
    let attempts = 0;
    const i = render(
      <Onboarding
        cwd={tempCwd()}
        home={home}
        env={{}}
        tester={okTester}
        subscriptionLogin={async (io) => {
          attempts++;
          return scriptedLogin(io, attempts === 1 ? "WRONG" : "CODE-123");
        }}
        onDone={(ref) => done.push(ref)}
      />,
    );
    await sleep(60);
    i.stdin.write("\r");
    await sleep(60);
    i.stdin.write("\x1b[B");
    await sleep(60);
    i.stdin.write("\r");
    await sleep(60);
    i.stdin.write("y");
    await sleep(80);
    i.stdin.write("CODE-123");
    await sleep(60);
    i.stdin.write("\r");
    await sleep(80);

    const failed = stripAnsi(i.lastFrame() ?? "");
    expect(failed).toContain("Login failed: authorization failed: invalid code");
    expect(failed).toContain("r retry");
    i.stdin.write("r");
    await sleep(80);
    i.stdin.write("CODE-123");
    await sleep(60);
    i.stdin.write("\r");
    await sleep(80);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Pick your default model");
    expect(attempts).toBe(2);
    i.unmount();
  });
});


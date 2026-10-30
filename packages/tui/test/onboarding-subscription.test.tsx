/**
 * TUI onboarding wizard — subscription branch (issue #149): auth-method
 * step (never for openai-compat), ToS screen, overlay-driven OAuth flow
 * (authorize URL shown, browser opened via the openUrl seam, paste-code
 * input, completion), tokens + endpoint stub persisted right after login,
 * model + connection test as usual, and no token/code material on screen.
 *
 * #1317/#1720: neither anthropic nor google sees the auth-method step any
 * more, so the flows here are driven on openai — the live kind that behaves
 * like them (native OAuth, paste-code, shipped catalog) — and one case
 * asserts both withheld kinds take the api-key path.
 */
import { describe, expect, test } from "bun:test";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOS_WARNING, readUserConfigFile, subscriptionModelCatalog, type AuthToken, type AuthorizationIo } from "@moh/core";
import { getStoredToken } from "../../core/src/auth/store";
import { Onboarding } from "../src/OnboardingOverlay";
import { clipboardBackend } from "../src/clipboard";
import { stripAnsi, waitForCondition, waitForFrame } from "./helpers";

const tempHome = () => mkdtempSync(join(tmpdir(), "moh-sub-home-"));
const tempCwd = () => mkdtempSync(join(tmpdir(), "moh-sub-"));
const okTester = async () => ({ ok: true as const, modelId: "tested" });

/** #1317/#1720: drives the wizard to a kind whose subscription offer is
 * live — openai, one row down the type list (anthropic, openai). The
 * per-row wait makes a dropped keystroke visible instead of silently
 * selecting the wrong kind. */
const pickOpenai = async (i: ReturnType<typeof render>, frame: () => string): Promise<void> => {
  await waitForFrame(frame, "Pick a provider type");
  i.stdin.write("\x1b[B");
  await waitForFrame(frame, "› openai");
  i.stdin.write("\r");
  await waitForFrame(frame, "How does openai authenticate?");
};

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

/** A scripted grant that never reaches the paste prompt: browser-opened
 * path stuck waiting for the callback (where `c` is bound with no
 * prompt on screen). */
const browserWaitingLogin = async (io: AuthorizationIo): Promise<AuthToken> => {
  await io.info("Authorize via:\n  https://provider.example/oauth/manual");
  if (!io.openUrl) throw new Error("no openUrl");
  await io.openUrl("https://provider.example/oauth/auto");
  await io.info("Waiting for the browser to complete the authorization…");
  return new Promise(() => {}); // never settles within the test
};


describe("onboarding wizard — subscription branch (#149, #1317)", () => {
  test("#1317/#1720: anthropic and google never show the auth-method step; a live offer does; openai-compat never does", async () => {
    // Both kinds have a grant but the wizard withholds the offer: selecting
    // either lands straight on the api-key flow — never the ToS, login or
    // subscription-model screens. Rows: anthropic (0 downs), google (2).
    for (const downs of [0, 2]) {
      const i1 = render(<Onboarding cwd={tempCwd()} home={tempHome()} env={{}} tester={okTester} onDone={() => {}} />);
      const frame1 = () => stripAnsi(i1.lastFrame() ?? "");
      await waitForFrame(frame1, "Pick a provider type");
      for (let n = 1; n <= downs; n++) {
        i1.stdin.write("\x1b[B");
        await waitForFrame(frame1, `\u203a ${n === 1 ? "openai" : "google"}`);
      }
      i1.stdin.write("\r");
      await waitForFrame(frame1, "Default model");
      expect(frame1()).not.toContain("authenticate?");
      i1.unmount();
    }

    // A kind whose offer is live still asks (openai: the flows below).
    const i2 = render(<Onboarding cwd={tempCwd()} home={tempHome()} env={{}} tester={okTester} onDone={() => {}} />);
    const frame2 = () => stripAnsi(i2.lastFrame() ?? "");
    await pickOpenai(i2, frame2);
    i2.unmount();

    const i3 = render(<Onboarding cwd={tempCwd()} home={tempHome()} env={{}} tester={okTester} onDone={() => {}} />);
    const frame3 = () => stripAnsi(i3.lastFrame() ?? "");
    await waitForFrame(frame3, "Pick a provider type");
    for (const type of ["openai", "google", "openai-compat"]) {
      i3.stdin.write("\x1b[B");
      await waitForFrame(frame3, `› ${type}`);
    }
    i3.stdin.write("\r"); // openai-compat → model directly (no grant at all)
    await waitForFrame(frame3, "Default model");
    expect(frame3()).not.toContain("authenticate?");
    i3.unmount();
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
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await pickOpenai(i, frame);
    i.stdin.write("\x1b[B"); // down → subscription
    await waitForFrame(frame, "› subscription");
    i.stdin.write("\r");

    // ToS screen first (spec invariant 4) — same text as the CLI.
    await waitForFrame(frame, "Terms of service");
    const tos = frame();
    expect(tos).toContain(TOS_WARNING.slice(0, 40));
    i.stdin.write("y");

    // Login screen: manual URL visible, browser opened via the seam.
    await waitForFrame(frame, "Paste code here");
    const loginFrame = frame();
    expect(loginFrame).toContain("https://provider.example/oauth/manual");
    expect(opened).toEqual(["https://provider.example/oauth/auto"]);

    // Pasted code is masked on screen (redaction).
    i.stdin.write("CODE-123");
    await waitForFrame(frame, "********");
    const masked = frame();
    expect(masked).not.toContain("CODE-123");
    i.stdin.write("\r");

    // Completion (#156): post-login model list — no typing required. The
    // catalog names are shown, with a manual free-text row at the bottom.
    await waitForFrame(frame, "Pick your default model");
    const modelFrame = frame();
    expect(modelFrame).toContain("tokens stored in");
    expect(modelFrame).toContain("Pick your default model");
    // The catalog may have grown past the viewport (scrollable, "↓ N more"):
    // the manual row exists in the list but is not guaranteed visible.
    expect(modelFrame).toMatch(/enter a model id manually|↓ \d+ more/);
    const first = subscriptionModelCatalog("openai")[0]!;
    // The row carries name · id and is right-truncated at this width; the
    // name is the part the frame always shows.
    expect(modelFrame).toContain(first.name);
    i.stdin.write("\r"); // select the first catalog entry
    // Selection goes straight to the connection test (no key, no base URL).
    await waitForFrame(frame, "Testing connection");
    await waitForCondition(
      () => done.length > 0,
      () => `onDone was not called; received: ${JSON.stringify(done)}`,
    );

    expect(done).toEqual([`openai/${first.id}`]);
    expect(logins).toBe(1);

    // Tokens live in ~/.moh/config (never moh.json); endpoint completed.
    const user = readUserConfigFile(userFile);
    expect(getStoredToken(userFile, "openai")?.accessToken).toBe("at-secret-value");
    expect((user.endpoints as { name: string }[] ?? []).find((e) => e.name === "openai")).toMatchObject({
      type: "openai",
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

  test("'c' copies the full authorize URL to the clipboard (manual path, paste prompt pending)", async () => {
    const writes: string[] = [];
    clipboardBackend({ kind: "binary", write: async (t) => { writes.push(t); } });
    try {
      const i = render(
        <Onboarding
          cwd={tempCwd()}
          home={tempHome()}
          env={{}}
          tester={okTester}
          subscriptionLogin={async (io) => scriptedLogin(io)}
          openUrl={async () => true}
          onDone={() => {}}
        />,
      );
      const frame = () => stripAnsi(i.lastFrame() ?? "");
      await pickOpenai(i, frame);
      i.stdin.write("\x1b[B\r");
      await waitForFrame(frame, "Terms of service");
      i.stdin.write("y");
      await waitForFrame(frame, "Paste code here");
      // Hint is visible next to the (possibly truncated) URL line.
      await waitForFrame(frame, "c copy the authorize URL to the clipboard");
      expect(writes).toEqual([]); // nothing copied until asked
      i.stdin.write("c");
      await waitForFrame(frame, "✓ authorize URL copied to the clipboard");
      // The copy carries the full URL from the log — never the truncated
      // render or dialog chrome.
      expect(writes).toEqual(["https://provider.example/oauth/manual"]);
      i.unmount();
    } finally {
      clipboardBackend(null);
    }
  });

  test("'c' is a literal character once the user has typed into the code field", async () => {
    const writes: string[] = [];
    clipboardBackend({ kind: "binary", write: async (t) => { writes.push(t); } });
    try {
      const i = render(
        <Onboarding
          cwd={tempCwd()}
          home={tempHome()}
          env={{}}
          tester={okTester}
          subscriptionLogin={async (io) => scriptedLogin(io, "XCcODE") }
          openUrl={async () => true}
          onDone={() => {}}
        />,
      );
      const frame = () => stripAnsi(i.lastFrame() ?? "");
      await pickOpenai(i, frame);
      i.stdin.write("\x1b[B\r");
      await waitForFrame(frame, "Terms of service");
      i.stdin.write("y");
      await waitForFrame(frame, "Paste code here");
      i.stdin.write("X");
      await waitForFrame(frame, "› *");
      // askValue is non-empty: 'c' must type, not copy.
      i.stdin.write("c");
      await sleep(50);
      expect(writes).toEqual([]);
      expect(frame()).toContain("› **"); // masked input grew by one character
      i.unmount();
    } finally {
      clipboardBackend(null);
    }
  });

  test("'c' surfaces a failed clipboard copy instead of failing silently", async () => {
    clipboardBackend({ kind: "binary", write: async () => { throw new Error("no clipboard"); } });
    try {
      const i = render(
        <Onboarding
          cwd={tempCwd()}
          home={tempHome()}
          env={{}}
          tester={okTester}
          subscriptionLogin={async (io) => scriptedLogin(io)}
          openUrl={async () => true}
          onDone={() => {}}
        />,
      );
      const frame = () => stripAnsi(i.lastFrame() ?? "");
      await pickOpenai(i, frame);
      i.stdin.write("\x1b[B\r");
      await waitForFrame(frame, "Terms of service");
      i.stdin.write("y");
      await waitForFrame(frame, "Paste code here");
      i.stdin.write("c");
      await waitForFrame(frame, "clipboard copy failed (no clipboard)");
      // The failure line keeps the URL visible as the manual fallback.
      expect(frame()).toContain("https://provider.example/oauth/manual");
      expect(frame()).not.toContain("✓ authorize URL copied");
      i.unmount();
    } finally {
      clipboardBackend(null);
    }
  });

  test("'c' copies while waiting for the browser (no paste prompt on screen)", async () => {
    const writes: string[] = [];
    clipboardBackend({ kind: "binary", write: async (t) => { writes.push(t); } });
    try {
      const i = render(
        <Onboarding
          cwd={tempCwd()}
          home={tempHome()}
          env={{}}
          tester={okTester}
          subscriptionLogin={async (io) => browserWaitingLogin(io)}
          openUrl={async () => true}
          onDone={() => {}}
        />,
      );
      const frame = () => stripAnsi(i.lastFrame() ?? "");
      await pickOpenai(i, frame);
      i.stdin.write("\x1b[B\r");
      await waitForFrame(frame, "Terms of service");
      i.stdin.write("y");
      await waitForFrame(frame, "Waiting for the browser");
      i.stdin.write("c");
      await waitForFrame(frame, "✓ authorize URL copied to the clipboard");
      expect(writes).toEqual(["https://provider.example/oauth/manual"]);
      i.unmount();
    } finally {
      clipboardBackend(null);
    }
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
          expect((user.endpoints as { name: string }[] ?? []).find((e) => e.name === "openai")).toBeUndefined();
          return scriptedLogin(io);
        }}
        onDone={() => {}}
      />,
    );
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await pickOpenai(i, frame);
    i.stdin.write("\x1b[B");
    await waitForFrame(frame, "› subscription");
    i.stdin.write("\r");
    await waitForFrame(frame, "Terms of service");
    i.stdin.write("y");
    await waitForFrame(frame, "Paste code here");
    i.stdin.write("CODE-123");
    await waitForFrame(frame, "********");
    i.stdin.write("\r");
    await waitForFrame(frame, "Pick your default model");

    // Right after login: stub + tokens are on disk even though the wizard
    // is still at the model prompt.
    const user = readUserConfigFile(userFile);
    expect((user.endpoints as { name: string }[] ?? []).find((e) => e.name === "openai")).toMatchObject({ auth: { kind: "subscription" } });
    expect(getStoredToken(userFile, "openai")).toBeDefined();
    expect(frame()).toContain("Pick your default model");
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
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await pickOpenai(i, frame);
    i.stdin.write("\x1b[B"); // subscription
    await waitForFrame(frame, "› subscription");
    i.stdin.write("\r");
    await waitForFrame(frame, "Terms of service");
    i.stdin.write("y"); // ToS
    await waitForFrame(frame, "Paste code here");
    i.stdin.write("CODE-123");
    await waitForFrame(frame, "********");
    i.stdin.write("\r");
    await waitForFrame(frame, "Pick your default model");
    // Bottom row = free-text fallback (advanced). Arrow past the visible
    // viewport until the manual row is selected — the catalog may have
    // grown (scrollable list), so never count keystrokes.
    const list = frame();
    expect(list).toContain("Pick your default model");
    for (let k = 0; k < 40 && !frame().includes("› enter a model id manually"); k++) {
      i.stdin.write("\x1b[B");
      await sleep(25);
    }
    expect(frame()).toContain("› enter a model id manually");
    i.stdin.write("\r"); // manual entry
    await waitForFrame(frame, "Default model");
    expect(frame()).toContain("Default model");
    i.stdin.write("gpt-6-sol");
    await waitForFrame(frame, "› gpt-6-sol");
    i.stdin.write("\r");
    await waitForCondition(
      () => done.length > 0,
      () => `onDone was not called; received: ${JSON.stringify(done)}`,
    );
    expect(done).toEqual(["openai/gpt-6-sol"]);
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
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await pickOpenai(i, frame);
    i.stdin.write("\x1b[B"); // subscription
    await waitForFrame(frame, "› subscription");
    i.stdin.write("\r");
    await waitForFrame(frame, "Terms of service");
    i.stdin.write("n"); // decline
    await waitForFrame(frame, "How does openai authenticate?");
    expect(logins).toBe(0);
    // Cursor remembers the declined choice; switching to api-key works.
    i.stdin.write("\x1b[A"); // up → api-key
    await waitForFrame(frame, "› api-key");
    i.stdin.write("\r"); // api-key
    await waitForFrame(frame, "Default model");
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
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    await pickOpenai(i, frame);
    i.stdin.write("\x1b[B");
    await waitForFrame(frame, "› subscription");
    i.stdin.write("\r");
    await waitForFrame(frame, "Terms of service");
    i.stdin.write("y");
    await waitForFrame(frame, "Paste code here");
    i.stdin.write("CODE-123");
    await waitForFrame(frame, "********");
    i.stdin.write("\r");

    await waitForFrame(frame, "Login failed: authorization failed: invalid code");
    const failed = frame();
    expect(failed).toContain("r retry");
    i.stdin.write("r");
    await waitForFrame(frame, "Paste code here");
    i.stdin.write("CODE-123");
    await waitForFrame(frame, "********");
    i.stdin.write("\r");
    await waitForFrame(frame, "Pick your default model");
    expect(attempts).toBe(2);
    i.unmount();
  });
});


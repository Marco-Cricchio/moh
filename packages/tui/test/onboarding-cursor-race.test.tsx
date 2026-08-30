/**
 * Onboarding wizard cursor race (found while diagnosing suite flakiness):
 * the wizard navigates with non-functional state updates
 * (`setPhase({ ...phase, cursor: phase.cursor + 1 })`), so two arrow keys
 * delivered before React re-renders the handler both read the same stale
 * `phase` and one increment is lost — Enter then selects the wrong row.
 * Reproduces reliably when the arrows start right after the (expensive,
 * 13-row) model list mounts: round-settle 300ms puts the first two downs
 * inside one render window. The fix (functional cursor updates) must keep
 * every key, independent of render timing.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subscriptionModelCatalog, type AuthToken, type AuthorizationIo } from "@moh/core";
import { Onboarding } from "../src/OnboardingOverlay";
import { stripAnsi, waitForFrame } from "./helpers";

const sleep = (ms: number) => Promise.resolve().then(() => new Promise((r) => setTimeout(r, ms)));
const tempHome = () => mkdtempSync(join(tmpdir(), "moh-arrow-home-"));
const tempCwd = () => mkdtempSync(join(tmpdir(), "moh-arrow-cwd-"));
const okTester = async () => ({ ok: true as const, modelId: "tested" });
const TOKEN: AuthToken = { accessToken: "at", refreshToken: "rt", updatedAt: 1 };
const scriptedLogin = async (io: AuthorizationIo): Promise<AuthToken> => {
  await io.info("Authorize via:\n  https://provider.example/oauth/manual");
  const pasted = await io.ask("Paste code here: ");
  if (pasted !== "CODE-123") throw new Error("authorization failed: invalid code");
  return TOKEN;
};

describe("onboarding wizard — cursor race", () => {
  test("rapid arrows after the model list mounts: no key lost, manual row reached", async () => {
    for (let round = 0; round < 3; round++) {
      const i = render(
        <Onboarding
          cwd={tempCwd()}
          home={tempHome()}
          env={{}}
          tester={okTester}
          subscriptionLogin={async (io) => scriptedLogin(io)}
          onDone={() => {}}
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
      expect(frame()).toContain("Pick your default model");
      const down = subscriptionModelCatalog("anthropic").length;
      for (let d = 0; d < down; d++) {
        i.stdin.write("\x1b[B");
        await sleep(10);
      }
      i.stdin.write("\r"); // must land on the manual-entry row
      await waitForFrame(frame, "Default model");
      expect(frame()).toContain("Default model");
      i.unmount();
    }
  });

  test("down+enter before the input handler re-registers selects the highlighted save-scope row (#275)", async () => {
    for (let round = 0; round < 3; round++) {
      const cwd = tempCwd();
      const home = tempHome();
      const done: (string | null)[] = [];
      const i = render(
        <Onboarding cwd={cwd} home={home} env={{}} tester={okTester} onDone={(ref) => done.push(ref)} subscriptionLogin={async (io) => scriptedLogin(io)} />,
      );
      const frame = () => stripAnsi(i.lastFrame() ?? "");
      const waitFor = async (substr: string, ms = 2000) => {
        for (let t = 0; t < ms / 10 && !frame().includes(substr); t++) await sleep(10);
        expect(frame()).toContain(substr);
      };
      await waitFor("Pick a provider type");
      for (let d = 0; d < 3; d++) {
        i.stdin.write("\x1b[B");
        await sleep(10);
      } // openai-compat
      await sleep(50);
      i.stdin.write("\r");
      await waitFor("Default model");
      i.stdin.write("qwen3");
      await sleep(10);
      i.stdin.write("\r");
      await waitFor("API key");
      i.stdin.write("\r"); // empty key → env/local
      await waitFor("Pick an API endpoint"); // known-endpoint list (#295)
      i.stdin.write("\r"); // Ollama (first entry) prefills the base URL
      await waitFor("Base URL");
      await waitFor("http://localhost:11434/v1");
      i.stdin.write("\r"); // accept the prefilled URL
      await waitFor("Where should");
      // down+enter with no settling window: enter must read the cursor the
      // down produced even if ink re-registers the input handler only in a
      // deferred passive effect.
      i.stdin.write("\x1b[B");
      i.stdin.write("\r");
      await sleep(100);
      expect(done).toEqual(["openai-compat/qwen3"]);
      const config = JSON.parse(readFileSync(join(cwd, "moh.json"), "utf8"));
      expect(config.provider).toBe("openai-compat/qwen3"); // project save — not user-level
      i.unmount();
    }
  });
});

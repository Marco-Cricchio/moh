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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subscriptionModelCatalog, type AuthToken, type AuthorizationIo } from "@moh/core";
import { Onboarding } from "../src/OnboardingOverlay";
import { stripAnsi } from "./helpers";

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
      await sleep(300); // settled: the model list is mounted and idle
      expect(stripAnsi(i.lastFrame() ?? "")).toContain("Pick your default model");
      const down = subscriptionModelCatalog("anthropic").length;
      for (let d = 0; d < down; d++) {
        i.stdin.write("\x1b[B");
        await sleep(10);
      }
      i.stdin.write("\r"); // must land on the manual-entry row
      await sleep(60);
      expect(stripAnsi(i.lastFrame() ?? "")).toContain("Default model");
      i.unmount();
    }
  });
});

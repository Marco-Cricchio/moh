import { describe, expect, test } from "bun:test";
import { waitForCondition, waitForFrame } from "./helpers";

describe("waitForFrame", () => {
  test("waits until the observable frame reaches the expected state", async () => {
    let frame = "loading";
    setTimeout(() => { frame = "ready"; }, 15);
    await waitForFrame(() => frame, "ready", { timeoutMs: 100, intervalMs: 5 });
  });



  test("waits until an overlay is absent", async () => {
    let frame = "workflow mode";
    setTimeout(() => { frame = "home"; }, 15);
    await waitForFrame(() => frame, "workflow mode", { timeoutMs: 100, intervalMs: 5, absent: true });
  });

  test("reports the expected state and final frame on timeout", async () => {
    await expect(waitForFrame(() => "still loading", "ready", { timeoutMs: 10, intervalMs: 5 }))
      .rejects.toThrow('Timed out waiting: for frame containing "ready". Last frame:\nstill loading');
  });

  test("reports caller-provided condition diagnostics", async () => {
    await expect(waitForCondition(() => false, () => "the callback did not fire", { timeoutMs: 10, intervalMs: 5 }))
      .rejects.toThrow("Timed out waiting: the callback did not fire");
  });
});

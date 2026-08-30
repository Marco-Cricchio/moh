import { describe, expect, test } from "bun:test";
import { trackExitWork, awaitExitWork } from "../src/exit";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("exit-work registry (#341)", () => {
  test("settled work resolves immediately as settled", async () => {
    trackExitWork(Promise.resolve());
    expect(await awaitExitWork(50)).toBe(true);
  });

  test("slow work settling within the budget reports settled", async () => {
    trackExitWork(sleep(40));
    expect(await awaitExitWork(1000)).toBe(true);
  });

  test("never-settling work is bounded by the timeout", async () => {
    trackExitWork(new Promise(() => {}));
    const start = Date.now();
    expect(await awaitExitWork(80)).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

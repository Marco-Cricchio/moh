import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { listCases, runCaseFile, suiteNames } from "../src/runner";
import type { EvalCase, MultiRunCase } from "../src/case-types";

/**
 * Meta-harness: every eval case must itself pass (#524). This keeps
 * `bun test` green on the eval corpus and gives CI the failure digest
 * without shelling out to run.ts.
 */
describe("eval suites", () => {
  for (const suite of suiteNames()) {
    describe(suite, () => {
      for (const name of listCases(suite)) {
        test(`${suite}/${name}`, async () => {
          const spec = JSON.parse(
            await Bun.file(join(import.meta.dir, "..", "suites", suite, `${name}.json`)).text(),
          ) as EvalCase | MultiRunCase;
          const result = await runCaseFile(suite, name, spec);
          expect(result.failures).toEqual([]);
          expect(result.pass).toBe(true);
        });
      }
    });
  }
});

/** A deliberately-broken assertion produces a named failure (the digest path). */
describe("failure digest", () => {
  test("a broken assertion is reported, not silent", async () => {
    const result = await runCaseFile("tools", "broken", {
      prompt: "x",
      cassette: [{ deltas: ["hi"], finish: "stop" }],
      assertions: { replyIncludes: ["never said this"] },
    });
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain("replyIncludes");
  });
});

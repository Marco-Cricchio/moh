/**
 * Session Handoff T2 client wiring (#435): the TUI exit-time publish
 * helper. Transport-off = null (single-machine transparency, story 8);
 transport-on failures surface as one warning (story 15). No network:
 `handoffPublishWork`'s own publish path is exercised through the fake
 transport seam in core tests; here we assert the gating and warning
 mapping, which is the TUI's responsibility.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handoffWarning } from "../src/factory";
import type { HandoffTransportError } from "@moh/core";

const TMP = join(import.meta.dir, "tmp-factory-handoff");

describe("handoffWarning", () => {
  const cases: Array<[HandoffTransportError, string]> = [
    [{ reason: "no-artifact" }, "handoff: no local artifact to publish"],
    [{ reason: "gh-missing" }, "handoff: gh is not installed — handoff kept local only"],
    [{ reason: "not-logged-in" }, "handoff: gh is not logged in — handoff kept local only"],
    [{ reason: "timeout" }, "handoff: publish exceeded the exit budget — handoff kept local only"],
    [{ reason: "failed", message: "boom" }, "handoff: publish failed (boom) — handoff kept local only"],
  ];
  for (const [error, message] of cases) {
    test(`${error.reason} → "${message}"`, () => {
      expect(handoffWarning(error)).toBe(message);
    });
  }
});

// handoffPublishWork's gating is config-driven: absent/none transport
// returns null synchronously. The gist-on path is covered by the core
// seam tests (fake transport); driving it here would shell out to gh.
describe("handoffPublishWork gating", () => {
  test("transport off (no moh.json) returns null — single machine unchanged", () => {
    mkdirSync(TMP, { recursive: true });
    rmSync(join(TMP, "moh.json"), { force: true });
    // dynamic import to avoid hoisting issues with the TMP cleanup
    const { handoffPublishWork } = require("../src/factory") as typeof import("../src/factory");
    expect(handoffPublishWork(TMP, TMP, () => {})).toBeNull();
  });

  test("transport none is explicit off — null", () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(join(TMP, "moh.json"), JSON.stringify({ handoff: { transport: "none" } }));
    const { handoffPublishWork } = require("../src/factory") as typeof import("../src/factory");
    expect(handoffPublishWork(TMP, TMP, () => {})).toBeNull();
    rmSync(TMP, { recursive: true, force: true });
  });
});

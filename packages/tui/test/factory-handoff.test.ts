/**
 * Session Handoff T2 client wiring (#435): the TUI exit-time publish
 * helper. Transport-off = null (single-machine transparency, story 8);
 * transport-on failures surface as one warning (story 15). No network:
 * `handoffPublishWork`'s own publish path is exercised through the fake
 * transport seam in core tests; here we assert the gating and warning
 * mapping, which is the TUI's responsibility.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handoffPublishWork, handoffWarning, makeSession } from "../src/factory";
import { HandoffRunner, MockProvider, type HandoffTransportError } from "@moh/core";

const TMP = join(import.meta.dir, "tmp-factory-handoff");

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function project(name: string, mohJson?: unknown): string {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  if (mohJson !== undefined) writeFileSync(join(dir, "moh.json"), JSON.stringify(mohJson));
  return dir;
}

test("a seeded session writes the accepted handoff as supersedes", async () => {
  const cwd = project("seeded", { handoff: { transport: "none" } });
  const home = join(TMP, "home-seeded");
  const made = makeSession({
    cwd,
    home,
    provider: MockProvider.scripted([{ deltas: ["continued"], finish: "stop" }]),
    handoffOffer: {
      status: "offer",
      url: "https://gist.github.com/a",
      stale: false,
      payload: {
        version: 1,
        kind: "raw",
        sessionId: "session-a",
        updatedAt: "2026-09-02T10:00:00.000Z",
        git: {}, turns: 1, lastUserMessage: "work", lastAssistantMessage: "state",
        files: [], tests: [], counts: { toolCalls: 0, errors: 0, cancelled: 0 },
      },
    },
  });
  expect("error" in made).toBe(false);
  if ("error" in made) return;
  await made.session.send("continue");
  await made.session.dispose();
  const artifact = JSON.parse(readFileSync(HandoffRunner.artifactFile(cwd, join(home, ".moh")), "utf8"));
  expect(artifact.supersedes).toEqual({ sessionId: "session-a", updatedAt: "2026-09-02T10:00:00.000Z" });
});

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
    expect(handoffPublishWork(project("off-none"), undefined, () => {})).toBeNull();
  });

  test("transport none is explicit off — null", () => {
    expect(handoffPublishWork(project("off-explicit", { handoff: { transport: "none" } }), undefined, () => {})).toBeNull();
  });
});

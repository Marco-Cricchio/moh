import { describe, expect, test } from "bun:test";
import { enrichHandoffWithWayfinder, notifyClaimedWayfinderTickets } from "../src/handoff-wayfinder";
import type { RawHandoff } from "../src/handoff";
import type { TrackerBackend } from "../src/tracker";

function handoff(): RawHandoff {
  return {
    version: 1, kind: "raw", sessionId: "s", updatedAt: "2026-09-03T10:00:00.000Z", git: {}, turns: 1,
    lastUserMessage: "", lastAssistantMessage: "", files: [], tests: [], counts: { toolCalls: 0, errors: 0, cancelled: 0 },
    wayfinderLinks: [
      { id: "7", relations: ["claimed", "mentioned"] },
      { id: "8", relations: ["mentioned"] },
      { id: "9", relations: ["mentioned"] },
    ],
  };
}

function tracker(): TrackerBackend {
  return {
    kind: "gh",
    async list() { return []; },
    async claim() {},
    async unclaim() {},
    async wayfinderSnapshot() {
      return {
        mapId: "2",
        issues: [
          { id: "7", title: "Claimed", url: "https://x/7", state: "open", labels: ["wayfinder:task"], assignees: ["me"], blockedBy: [] },
          { id: "8", title: "Ready", url: "https://x/8", state: "open", labels: ["wayfinder:research"], assignees: [], blockedBy: [] },
          { id: "9", title: "Blocked", url: "https://x/9", state: "open", labels: ["wayfinder:task"], assignees: [], blockedBy: ["open"] },
        ],
      };
    },
  };
}

describe("Wayfinder handoff enrichment", () => {
  test("adds only map Wayfinder citations and an exact frontier snapshot", async () => {
    const enriched = await enrichHandoffWithWayfinder(handoff(), tracker());
    expect(enriched.wayfinder).toEqual({
      tickets: [
        { id: "7", title: "Claimed", url: "https://x/7", relations: ["claimed", "mentioned"] },
        { id: "8", title: "Ready", url: "https://x/8", relations: ["mentioned"] },
        { id: "9", title: "Blocked", url: "https://x/9", relations: ["mentioned"] },
      ],
      frontier: { ready: 1, inProgress: 1, blocked: 1 },
    });
  });

  test("a missing or failed tracker leaves the raw artifact unchanged", async () => {
    expect(await enrichHandoffWithWayfinder(handoff(), null)).toEqual(handoff());
    expect(await enrichHandoffWithWayfinder(handoff(), { ...tracker(), async wayfinderSnapshot() { throw new Error("offline"); } })).toEqual(handoff());
  });

  test("notifies only claimed citations, and only from an enriched payload", async () => {
    const comments: Array<[string, string]> = [];
    const enriched = await enrichHandoffWithWayfinder(handoff(), {
      ...tracker(),
      async comment(id, body) { comments.push([id, body]); },
    });
    expect(await notifyClaimedWayfinderTickets(enriched, {
      ...tracker(),
      async comment(id, body) { comments.push([id, body]); },
    }, "https://gist.github.com/x")).toBe(1);
    expect(comments).toEqual([["7", "moh session handoff published: https://gist.github.com/x\n\nWayfinder frontier: 1 ready · 1 in progress · 1 blocked."]]);
    expect(await notifyClaimedWayfinderTickets(handoff(), tracker(), "x")).toBe(0);
  });
});

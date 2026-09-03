/**
 * Session Handoff T3 (#436): the receiving side — discovery/newest-wins
 * comparison, stale marking, and the seed surfaces — against a fake
 * HandoffTransport. No test shells out to real `gh` or the network
 * (#433 testing decisions); git anchors are injected, local sessions
 * are injected through the `listLocal` seam.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  discoverHandoff,
  isHandoffStale,
  handoffSeedPrompt,
  handoffSeedMessage,
  type HandoffOffer,
  type HandoffTransport,
} from "../src/handoff-reception";
import type { RawHandoff, HandoffGitAnchor } from "../src/handoff";
import type { SessionSummary } from "../src/session-store";

const TMP = join(import.meta.dir, "tmp-handoff-t3");

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function payload(overrides: Partial<RawHandoff> = {}): RawHandoff {
  return {
    version: 1,
    kind: "raw",
    sessionId: "remote-9",
    updatedAt: "2026-09-02T18:00:00.000Z",
    git: { branch: "develop", head: "feed0000", dirty: false },
    turns: 4,
    lastUserMessage: "continue T3",
    lastAssistantMessage: "halfway through",
    files: ["src/a.ts", "src/b.ts"],
    tests: ["bun test a"],
    counts: { toolCalls: 9, errors: 1, cancelled: 0 },
    ...overrides,
  };
}

function fakeTransport(result: ReturnType<HandoffTransport["fetch"]> | "hang"): HandoffTransport {
  return {
    async publish() {
      throw new Error("publish is T2, not exercised here");
    },
    async fetch(): ReturnType<HandoffTransport["fetch"]> {
      if (result === "hang") return new Promise(() => {});
      return result;
    },
  };
}

function local(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    file: "/tmp/x.jsonl",
    id: "local-1",
    title: "local session",
    mtimeMs: Date.parse("2026-09-02T12:00:00.000Z"),
    ...overrides,
  };
}

const GIT: HandoffGitAnchor = { branch: "develop", head: "feed0000", dirty: false };

/** A `git` override must be passed explicitly (the default probes the
 * live repo); these assertions keep each test hermetic. */
function discover(args: {
  fetch: ReturnType<HandoffTransport["fetch"]> | "hang";
  locals?: SessionSummary[];
  git?: HandoffGitAnchor;
  timeoutMs?: number;
}): Promise<HandoffOffer> {
  return discoverHandoff({
    cwd: TMP,
    transport: fakeTransport(args.fetch),
    git: args.git ?? GIT,
    listLocal: () => args.locals ?? [local()],
    timeoutMs: args.timeoutMs ?? 500,
  });
}

describe("discoverHandoff", () => {
  test("newer remote handoff with matching anchor is offered, not stale", async () => {
    const offer = await discover({ fetch: { ok: true, payload: payload(), url: "u" } });
    expect(offer.status).toBe("offer");
    if (offer.status !== "offer") return;
    expect(offer.stale).toBe(false);
    expect(offer.payload.sessionId).toBe("remote-9");
    expect(offer.url).toBe("u");
  });

  test("handoff matching the newest local session id is own-session", async () => {
    const offer = await discover({
      fetch: { ok: true, payload: payload({ sessionId: "local-1" }), url: "u" },
    });
    expect(offer).toEqual({ status: "own-session" });
  });

  test("handoff not newer than the local session is local-current", async () => {
    const offer = await discover({
      locals: [local({ mtimeMs: Date.parse("2026-09-02T19:00:00.000Z") })],
      fetch: { ok: true, payload: payload(), url: "u" },
    });
    expect(offer).toEqual({ status: "local-current" });
  });

  test("anchor SHA different from HEAD marks the offer stale", async () => {
    const offer = await discover({
      git: { branch: "develop", head: "different999", dirty: false },
      fetch: { ok: true, payload: payload(), url: "u" },
    });
    expect(offer.status).toBe("offer");
    if (offer.status !== "offer") return;
    expect(offer.stale).toBe(true);
  });

  test("no local sessions: any handoff is offered", async () => {
    const offer = await discover({ locals: [], fetch: { ok: true, payload: payload(), url: "u" } });
    expect(offer.status).toBe("offer");
  });

  test("fetch failure is a silent none", async () => {
    const offer = await discover({
      fetch: { ok: false, error: { reason: "gh-missing" } },
    });
    expect(offer).toEqual({ status: "none" });
  });

  test("fetch rejection is a silent none, never a throw", async () => {
    const offer = await discover({
      fetch: { ok: false, error: { reason: "failed", message: "boom" } },
      });
    expect(offer).toEqual({ status: "none" });
  });

  test("a hanging fetch is cut by the deadline", async () => {
    const offer = await discover({ fetch: "hang", timeoutMs: 50 });
    expect(offer).toEqual({ status: "none" });
  });
});

describe("isHandoffStale", () => {
  test("missing anchor head is stale", () => {
    expect(isHandoffStale(payload({ git: {} }), TMP, GIT)).toBe(true);
  });

  test("matching head is current", () => {
    expect(isHandoffStale(payload(), TMP, GIT)).toBe(false);
  });
});

function offered(stale: boolean): Extract<HandoffOffer, { status: "offer" }> {
  const git = stale ? { branch: "develop", head: "old1111", dirty: false } : GIT;
  return { status: "offer", payload: payload({ git }), url: "u", stale };
}

describe("handoffSeedPrompt", () => {
  test("renders the working state, anchor, files and tests", () => {
    const prompt = handoffSeedPrompt(offered(false));
    expect(prompt.name).toBe("handoff-context");
    expect(prompt.text).toContain("Session handoff received");
    expect(prompt.text).toContain("last user message: continue T3");
    expect(prompt.text).toContain("branch: develop");
    expect(prompt.text).toContain("SHA: feed0000");
    expect(prompt.text).toContain("src/a.ts");
    expect(prompt.text).toContain("bun test a");
    expect(prompt.text).not.toContain("STALE");
  });

  test("stale offers carry the reconciliation instruction", () => {
    const prompt = handoffSeedPrompt(offered(true));
    expect(prompt.text).toContain("STALE");
    expect(prompt.text).toContain("git diff");
  });
});

describe("handoffSeedMessage", () => {
  test("clean offer: timestamp and branch, no warning", () => {
    const message = handoffSeedMessage(offered(false));
    expect(message).toContain("2026-09-02 18:00 UTC");
    expect(message).toContain("branch develop");
    expect(message).not.toContain("stale");
  });

  test("stale offer: explicit warning", () => {
    expect(handoffSeedMessage(offered(true))).toContain("stale");
  });
});

/** The artifact must stay readable through the T2 reader — reception
 * consumes the same payload the publish side writes. */
test("readRawHandoff round-trips a T3 payload", async () => {
  const { readRawHandoff } = await import("../src/handoff-transport");
  mkdirSync(TMP, { recursive: true });
  const file = join(TMP, "handoff.json");
  writeFileSync(file, `${JSON.stringify(payload())}\n`);
  expect(readRawHandoff(file)?.sessionId).toBe("remote-9");
});

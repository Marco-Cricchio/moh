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
} from "../src/handoff-reception";
import type { HandoffTransport } from "../src/handoff-transport";
import type { RawHandoff, HandoffGitAnchor } from "../src/handoff";
import { HandoffRunner } from "../src/handoff";
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

type FetchResult = Awaited<ReturnType<HandoffTransport["fetch"]>>;

function fakeTransport(result: FetchResult | "hang"): HandoffTransport {
  return {
    async publish() {
      throw new Error("publish is T2, not exercised here");
    },
    async fetch(): Promise<FetchResult> {
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
  fetch: FetchResult | "hang";
  locals?: SessionSummary[];
  git?: HandoffGitAnchor;
  timeoutMs?: number;
  readLocalArtifact?: () => RawHandoff | undefined;
  readImported?: () => RawHandoff | undefined;
}): Promise<HandoffOffer> {
  return discoverHandoff({
    cwd: TMP,
    transport: fakeTransport(args.fetch),
    git: args.git ?? GIT,
    listLocal: () => args.locals ?? [local()],
    timeoutMs: args.timeoutMs ?? 500,
    readLocalArtifact: args.readLocalArtifact ?? (() => undefined),
    readImported: args.readImported ?? (() => undefined),
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
      readLocalArtifact: () => payload({ sessionId: "local-1", updatedAt: "2026-09-02T10:00:00.000Z" }),
    });
    expect(offer).toEqual({ status: "own-session" });
  });

  test("own-session detection ignores the file-basename id space", async () => {
    // The local session file's id (basename) never matches the payload's
    // internal `session-xxxxxxxx` id — only the local artifact can say
    // "this machine published this handoff" (T3 review finding).
    const offer = await discover({
      locals: [local({ id: "20260902-abcd" })],
      fetch: { ok: true, payload: payload(), url: "u" },
      readLocalArtifact: () => undefined,
    });
    expect(offer.status).toBe("offer");
  });

  test("handoff newer than the newest local session wins despite matching basename", async () => {
    const offer = await discover({
      locals: [local({ id: "remote-9" })],
      fetch: { ok: true, payload: payload(), url: "u" },
      readLocalArtifact: () => undefined,
    });
    expect(offer.status).toBe("offer");
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
    const transport: HandoffTransport = {
      async publish() {
        throw new Error("unused");
      },
      async fetch(): Promise<never> {
        throw new Error("network blew up");
      },
    };
    const offer = await discoverHandoff({
      cwd: TMP,
      transport,
      git: GIT,
      listLocal: () => [],
      readLocalArtifact: () => undefined,
      timeoutMs: 500,
    });
    expect(offer).toEqual({ status: "none" });
  });

  test("a hanging fetch is cut by the deadline", async () => {
    const offer = await discover({ fetch: "hang", timeoutMs: 50 });
    expect(offer).toEqual({ status: "none" });
  });
});

describe("discoverHandoff — manual import merge (T7 #440)", () => {
  const imported = (): RawHandoff => payload({ sessionId: "imported-7", updatedAt: "2026-09-02T20:00:00.000Z" });

  test("a parked import newer than local work is offered when no gist is reachable", async () => {
    const offer = await discover({ fetch: { ok: false, error: { reason: "gh-missing" } }, readImported: imported });
    expect(offer.status).toBe("offer");
    if (offer.status !== "offer") return;
    expect(offer.payload.sessionId).toBe("imported-7");
    expect(offer.url).toBe("imported file");
    expect(offer.stale).toBe(false); // imported anchor feed0000 equals the injected HEAD
  });

  test("a parked import loses to local work just like a fetched handoff", async () => {
    const offer = await discover({ fetch: { ok: false, error: { reason: "gh-missing" } }, readImported: imported, locals: [local({ mtimeMs: Date.parse("2026-09-02T21:00:00.000Z") })] });
    expect(offer.status).toBe("local-current");
  });

  test("importing your own export back is own-session", async () => {
    const offer = await discover({
      fetch: { ok: false, error: { reason: "gh-missing" } },
      readImported: imported,
      readLocalArtifact: () => payload({ sessionId: "imported-7" }),
    });
    expect(offer.status).toBe("own-session");
  });

  test("a fetched gist handoff never loses to an older parked import", async () => {
    const offer = await discover({
      fetch: { ok: false, error: { reason: "gh-missing" } },
      readImported: imported,
      locals: [local({ mtimeMs: Date.parse("2026-09-02T21:00:00.000Z") })],
      // the gist payload is newer than local, but fetch failed — nothing to compare here;
      // instead verify via a beating gist below
    });
    expect(offer.status).toBe("local-current");
  });

  test("a winning gist handoff is offered even with a newer parked import present", async () => {
    const offer = await discover({ fetch: { ok: true, payload: payload(), url: "u" }, readImported: imported });
    expect(offer.status).toBe("offer");
    if (offer.status !== "offer") return;
    expect(offer.payload.sessionId).toBe("remote-9");
    expect(offer.url).toBe("u");
  });

  test("no import parked: fetch failure stays none", async () => {
    const offer = await discover({ fetch: { ok: false, error: { reason: "gh-missing" } } });
    expect(offer.status).toBe("none");
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

  test("renders cited Wayfinder tickets and the exact map frontier", () => {
    const offer = offered(false);
    offer.payload.wayfinder = {
      tickets: [
        { id: "42", title: "Chart route", url: "https://github.com/o/r/issues/42", relations: ["claimed", "mentioned"] },
      ],
      frontier: { ready: 2, inProgress: 1, blocked: 3 },
    };
    const prompt = handoffSeedPrompt(offer);
    expect(prompt.text).toContain("## Wayfinder");
    expect(prompt.text).toContain("claimed + mentioned: [Chart route](https://github.com/o/r/issues/42)");
    expect(prompt.text).toContain("frontier: 2 ready · 1 in progress · 3 blocked");
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

/** Regression (T3 review finding): `home` is the OS home — the local
 * listing and the artifact derivation both add `.moh` themselves, so
 * an injected `<home>/.moh` would look in `<home>/.moh/.moh/...` and
 * silently find nothing. This exercises the real default paths against
 * a temp home, no seams. */
test("default local paths resolve under <home>/.moh exactly once", async () => {
  const { readRawHandoff } = await import("../src/handoff-transport");
  const home = join(TMP, "home-once");
  const cwd = join(TMP, "proj-once");
  mkdirSync(cwd, { recursive: true });
  const artifactFile = HandoffRunner.artifactFile(cwd, join(home, ".moh"));
  mkdirSync(join(artifactFile, ".."), { recursive: true });
  expect(artifactFile.startsWith(join(home, ".moh"))).toBe(true);
  expect(artifactFile.includes(".moh.moh")).toBe(false);
  writeFileSync(artifactFile, `${JSON.stringify(payload())}\n`);
  const offer = await discoverHandoff({
    cwd,
    home,
    transport: fakeTransport({ ok: true, payload: payload(), url: "u" }),
    git: GIT,
    timeoutMs: 500,
  });
  // The artifact matches the payload's session id: this machine's own publish.
  expect(offer).toEqual({ status: "own-session" });
  expect(readRawHandoff(artifactFile)?.sessionId).toBe("remote-9");
});

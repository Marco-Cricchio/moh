/** #680 follow-up: the discovery debug seam. Production (no MOH_DEBUG)
 * writes nothing; MOH_DEBUG=handoff emits one stderr line per gate. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverHandoff, type DiscoverHandoffOptions } from "../src/handoff-reception";
import { handoffDebugEnabled, resetDebugCache, setDebugWriter } from "../src/handoff-debug";
import type { HandoffPayload, HandoffTransport } from "../src/handoff-transport";
import type { SessionSummary } from "../src/session-store";

const payload = (updatedAt: string): HandoffPayload => ({
  version: 1, kind: "raw", sessionId: "remote-1", updatedAt,
  git: { branch: "develop", head: "abc123", dirty: false },
  turns: 1, lastUserMessage: "hello", lastAssistantMessage: "hi",
  files: [], tests: [], counts: { toolCalls: 0, errors: 0, cancelled: 0 },
});

const okTransport = (p: HandoffPayload): HandoffTransport => ({
  publish: async () => ({ ok: true, url: "u" }),
  fetch: async () => ({ ok: true, payload: p, url: "https://gist.github.com/x" }),
});

function base(p: HandoffPayload): DiscoverHandoffOptions {
  return {
    cwd: mkdtempSync(join(tmpdir(), "moh-hdbg-")),
    home: mkdtempSync(join(tmpdir(), "moh-hdbg-home-")),
    transport: okTransport(p),
    listLocal: () => [] as SessionSummary[],
    readLocalArtifact: () => undefined,
    readImported: () => undefined,
    git: { branch: "develop", head: "abc123" },
  };
}

let buffer: string[] = [];
setDebugWriter((line) => buffer.push(line));

async function capture(fn: () => Promise<unknown>): Promise<string> {
  buffer = [];
  await fn();
  return buffer.join("");
}

const ENV = process.env.MOH_DEBUG;

afterEach(() => {
  if (ENV === undefined) delete process.env.MOH_DEBUG;
  else process.env.MOH_DEBUG = ENV;
  resetDebugCache();
});

describe("handoff discovery debug logging", () => {
  test("silent by default, on with MOH_DEBUG=handoff", () => {
    resetDebugCache();
    delete process.env.MOH_DEBUG;
    expect(handoffDebugEnabled()).toBe(false);

    process.env.MOH_DEBUG = "handoff";
    resetDebugCache();
    expect(handoffDebugEnabled()).toBe(true);
    // Comma-list friendly.
    process.env.MOH_DEBUG = "permission,handoff";
    resetDebugCache();
    expect(handoffDebugEnabled()).toBe(true);
    process.env.MOH_DEBUG = "handoffy";
    resetDebugCache();
    expect(handoffDebugEnabled()).toBe(false);
  });

  test("the decision chain is observable end to end (PC B's silent none)", async () => {
    process.env.MOH_DEBUG = "handoff";
    resetDebugCache();
    const err = await capture(() => discoverHandoff(base(payload("2026-09-14T09:47:33.000Z"))));
    // A fresh home with no sessions: fetch-ok then an offer decision.
    expect(err).toContain("moh[handoff] fetch-ok");
    expect(err).toContain('"status":"offer"');

    // local-current logs the losing comparison values.
    const opts = base(payload("2026-09-14T09:47:33.000Z"));
    opts.listLocal = () => [{
      file: "/tmp/newer.jsonl", id: "s-new", title: "t", derivedTitle: "t",
      mtimeMs: Date.parse("2026-09-14T10:00:00.000Z"), consumed: true,
    }] as SessionSummary[];
    const err2 = await capture(() => discoverHandoff(opts));
    expect(err2).toContain('"status":"local-current"');
    expect(err2).toContain("newestLocalFile");
  });

  test("fetch failure logs the error and falls back to import (none here)", async () => {
    process.env.MOH_DEBUG = "handoff";
    resetDebugCache();
    const opts = base(payload("2026-09-14T09:47:33.000Z"));
    opts.transport = {
      publish: async () => ({ ok: true, url: "u" }),
      fetch: async () => ({ ok: false, error: { reason: "failed" as const, message: "boom" } }),
    };
    const err = await capture(() => discoverHandoff(opts));
    expect(err).toContain("moh[handoff] fetch-error");
    expect(err).toContain("boom");
    expect(err).not.toContain('"status":"offer"');
  });
});

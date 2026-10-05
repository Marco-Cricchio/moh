/**
 * #784: the Jev HTTP client. Every test drives a fake fetch — there is no
 * real network call anywhere in this suite (acceptance criterion), and the
 * clock/sleep are injected so the retry policy is deterministic.
 */
import { describe, expect, test } from "bun:test";
import {
  JEV_AUTH_STATUS,
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_OFFLINE_STATUS,
  JEV_RETRY_DELAY_MS,
  createJevClient,
  transportFromFetch,
  validateJevKey,
  type JevJudgeInput,
  type JevTransport,
} from "../src/client";

const transportOf = (impl: unknown) => transportFromFetch(impl as Parameters<typeof transportFromFetch>[0]);

interface Call {
  url: string;
  body: any;
  headers: Record<string, string>;
}

/** Records every request and answers from a scripted queue. */
function fakeFetch(responses: Array<() => Response | Promise<Response>>): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const response = responses[Math.min(calls.length, responses.length - 1)]!;
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return response();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const okBody = {
  model: JEV_MODEL,
  answers: { is_ok: { type: "noul", noul: 0.98 } },
  usage: { input_tokens: 312, output_tokens: 48 },
};

const ok = () => new Response(JSON.stringify(okBody), { status: 200, headers: { "content-type": "application/json" } });

const judgeInput = (overrides: Partial<JevJudgeInput> = {}): JevJudgeInput => ({
  state: "rm -rf /tmp/build",
  questions: { destructive: { type: "noul", instructions: "Is this destructive?" } },
  record: (answers, meta) => ({ useCase: "guardrail", answers, model: meta.model, latencyMs: meta.latencyMs }),
  ...overrides,
});

describe("jev client: request shape", () => {
  test("posts to the fixed endpoint and model, carrying no key material (#1162)", async () => {
    const { impl, calls } = fakeFetch([ok]);
    const client = createJevClient({ transport: transportOf(impl) });
    const out = await client.judge(judgeInput());
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(JEV_ENDPOINT);
    expect(calls[0]!.body.model).toBe(JEV_MODEL);
    expect(calls[0]!.body.state).toBe("rm -rf /tmp/build");
    expect(calls[0]!.body.questions.destructive.type).toBe("noul");
    // The key never crosses the transport: the host resolves the
    // `credential:` ref and injects the bearer itself (ADR-0069).
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(JSON.stringify(calls[0]!.body)).not.toContain("sk-");
  });

  test("a successful judgment is recorded exactly once, through `record`", async () => {
    const { impl } = fakeFetch([ok]);
    const records: Record<string, unknown>[] = [];
    const client = createJevClient({ transport: transportOf(impl), onJudgment: (r) => records.push(r) });
    const out = await client.judge(judgeInput());
    expect(out.ok).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ useCase: "guardrail", model: JEV_MODEL });
  });
});

describe("jev client: failure and retry policy", () => {
  test("401 is an auth failure and is never retried", async () => {
    const { impl, calls } = fakeFetch([() => new Response("{}", { status: 401 })]);
    const client = createJevClient({ transport: transportOf(impl), sleep: async () => {} });
    const out = await client.judge(judgeInput());
    expect(out).toEqual({ ok: false, kind: "auth", message: "HTTP 401" });
    expect(calls).toHaveLength(1);
  });

  test("429 retries once after the fixed short delay (#1162: the transport exposes no headers)", async () => {
    const waits: number[] = [];
    const { impl, calls } = fakeFetch([
      () => new Response("{}", { status: 429 }),
      ok,
    ]);
    const client = createJevClient({ transport: transportOf(impl), sleep: async (ms) => void waits.push(ms) });
    const out = await client.judge(judgeInput());
    expect(out.ok).toBe(true);
    expect(waits).toEqual([JEV_RETRY_DELAY_MS]);
    expect(calls).toHaveLength(2);
  });

  test("429 without retry-after waits the fixed short delay", async () => {
    const waits: number[] = [];
    const { impl } = fakeFetch([() => new Response("{}", { status: 429 }), ok]);
    const client = createJevClient({ transport: transportOf(impl), sleep: async (ms) => void waits.push(ms) });
    expect((await client.judge(judgeInput())).ok).toBe(true);
    expect(waits).toEqual([JEV_RETRY_DELAY_MS]);
  });

  test("a 429 that stays 429 fails closed with the typed kind", async () => {
    const { impl, calls } = fakeFetch([() => new Response("{}", { status: 429 }), () => new Response("{}", { status: 429 })]);
    const client = createJevClient({ transport: transportOf(impl), sleep: async () => {} });
    const out = await client.judge(judgeInput());
    expect(out).toEqual({ ok: false, kind: "rate_limited", message: "HTTP 429" });
    expect(calls).toHaveLength(2);
  });

  test("two failures give up: exactly one retry, never more", async () => {
    let transient = true;
    const { impl, calls } = fakeFetch([
      () => {
        transient = false;
        throw new TypeError("fetch failed");
      },
      () => {
        throw new TypeError("fetch failed again");
      },
    ]);
    const client = createJevClient({ transport: transportOf(impl), sleep: async () => {} });
    const out = await client.judge(judgeInput());
    expect(out).toEqual({ ok: false, kind: "network", message: "fetch failed again" });
    expect(calls).toHaveLength(2);
    expect(transient).toBe(false);
  });

  test("a transport failure recovers on the retry", async () => {
    let first = true;
    const { impl, calls } = fakeFetch([
      () => {
        if (first) {
          first = false;
          throw new TypeError("fetch failed");
        }
        return ok();
      },
    ]);
    const client = createJevClient({ transport: transportOf(impl), sleep: async () => {} });
    expect((await client.judge(judgeInput())).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("the client never throws: an unreadable body is an invalid outcome", async () => {
    const { impl } = fakeFetch([() => new Response("not json", { status: 200 })]);
    const client = createJevClient({ transport: transportOf(impl) });
    const out = await client.judge(judgeInput());
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.kind).toBe("invalid");
  });

  test("a failed call records no judgment and never synthesizes one", async () => {
    const records: unknown[] = [];
    const { impl } = fakeFetch([() => new Response("{}", { status: 500 })]);
    const client = createJevClient({
      transport: transportOf(impl),
      sleep: async () => {},
      onJudgment: (r) => records.push(r),
    });
    const out = await client.judge(judgeInput());
    expect(out.ok).toBe(false);
    expect(records).toEqual([]);
  });
});

describe("jev client: the status signal (#1207 — outage and auth are two facts)", () => {
  test("one status per transition: outage set on the failure, cleared on recovery", async () => {
    let fail = true;
    const statuses: (string | null)[] = [];
    const { impl } = fakeFetch([
      () => {
        if (fail) throw new TypeError("down");
        return ok();
      },
    ]);
    const client = createJevClient({
      transport: transportOf(impl),
      sleep: async () => {},
      onStatus: (text) => statuses.push(text),
    });
    await client.judge(judgeInput());
    await client.judge(judgeInput());
    await client.judge(judgeInput());
    // Two failures in a row: still ONE announcement (no per-call spam).
    expect(statuses).toEqual([JEV_OFFLINE_STATUS]);
    fail = false;
    await client.judge(judgeInput());
    expect(statuses).toEqual([JEV_OFFLINE_STATUS, null]);
  });

  test("a rejected key publishes the auth text, not the outage (#1207)", async () => {
    let status: number = 401;
    const statuses: (string | null)[] = [];
    const { impl } = fakeFetch([() => new Response("{}", { status })]);
    const client = createJevClient({
      transport: transportOf(impl),
      sleep: async () => {},
      onStatus: (text) => statuses.push(text),
    });
    await client.judge(judgeInput());
    // One announcement, and it names the key — not the network.
    expect(statuses).toEqual([JEV_AUTH_STATUS]);
    // Still one announcement on a repeat (no per-call spam).
    await client.judge(judgeInput());
    expect(statuses).toEqual([JEV_AUTH_STATUS]);
    // A healthy call turns the fact over: the auth text is replaced by the
    // healthy clear, never silently held by a stale boolean.
    let healthy = false;
    const statuses2: (string | null)[] = [];
    const { impl: impl2 } = fakeFetch([
      () => {
        if (healthy) return ok();
        return new Response("{}", { status: 401 });
      },
    ]);
    const client2 = createJevClient({
      transport: transportOf(impl2),
      sleep: async () => {},
      onStatus: (text) => statuses2.push(text),
    });
    await client2.judge(judgeInput());
    expect(statuses2).toEqual([JEV_AUTH_STATUS]);
    healthy = true;
    await client2.judge(judgeInput());
    expect(statuses2).toEqual([JEV_AUTH_STATUS, null]);
  });

  test("the two failure texts replace each other — whichever failure is current is the one shown", async () => {
    let status = 401;
    const statuses: (string | null)[] = [];
    const { impl } = fakeFetch([() => new Response("{}", { status })]);
    const client = createJevClient({
      transport: transportOf(impl),
      sleep: async () => {},
      onStatus: (text) => statuses.push(text),
    });
    await client.judge(judgeInput());
    expect(statuses).toEqual([JEV_AUTH_STATUS]);
    // The service goes down while the key is still bad: the outage text
    // takes over (the current fact is the one published).
    status = 500;
    await client.judge(judgeInput());
    expect(statuses).toEqual([JEV_AUTH_STATUS, JEV_OFFLINE_STATUS]);
  });

  test("a host-seam refusal stays silent: the offline signal is untouched (#1162)", async () => {
    const statuses: (string | null)[] = [];
    const refused: JevTransport = async () => ({ ok: false, kind: "refused", message: "outside scope" });
    const client = createJevClient({ transport: refused, sleep: async () => {}, onStatus: (text) => statuses.push(text) });
    await client.judge(judgeInput());
    await client.judge(judgeInput());
    expect(statuses).toEqual([]);
  });
});

describe("jev key validation (#784 Settings entry, #1162 transport)", () => {
  test("a valid key reports active", async () => {
    const { impl, calls } = fakeFetch([ok]);
    const result = await validateJevKey({ transport: transportOf(impl) });
    expect(result.status).toBe("active");
    // The minimal probe: one noul question over a two-word state.
    expect(calls[0]!.body.state).toBe("ok");
    expect(Object.keys(calls[0]!.body.questions)).toEqual(["is_ok"]);
  });

  test("an auth failure reports invalid (never a network problem)", async () => {
    const { impl } = fakeFetch([() => new Response("{}", { status: 401 })]);
    expect((await validateJevKey({ transport: transportOf(impl) })).status).toBe("invalid");
  });

  test("an unreachable service reports unreachable, distinct from invalid", async () => {
    const { impl } = fakeFetch([
      () => {
        throw new TypeError("dns");
      },
    ]);
    const result = await validateJevKey({ transport: transportOf(impl), timeoutMs: 10 });
    expect(result.status).toBe("unreachable");
    expect(result.status === "unreachable" && result.kind).toBe("network");
  });
});

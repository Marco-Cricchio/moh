/**
 * #1100 (P1): provider-declared quota state and commercial usage —
 * `quota_observation` / `quota_episode` / `commercial_declaration` chrome
 * events, the producers (probe recording, quota-class provider errors),
 * the episode/contradiction projections and the pressure query. Every
 * assertion reads metadata only; absent numbers stay absent (never zero).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../src/index";
import { endpointIdentity, ProviderError } from "../src/types";
import type { AgentEvent, Message, StreamEvent } from "../src/types";
import {
  commercialDeclarationEvent,
  declarationInForce,
  observationsFromQuotaReport,
  quotaContradictions,
  quotaEpisodes,
  quotaPressure,
  quotaEventsFromProviderError,
  quotaRecoveryEvent,
  scopeKeyFor,
  summarizeQuota,
} from "../src/quota/telemetry";
import { aggregateTelemetry } from "../src/telemetry";

/** A one-shot provider whose stream is the given generator function. */
function providerOf(name: string, stream: () => AsyncGenerator<StreamEvent>) {
  return {
    name,
    async *stream(_messages: Message[], _signal: AbortSignal): AsyncGenerator<StreamEvent> {
      yield* stream();
    },
  };
}

function session(provider: ReturnType<typeof providerOf>, endpoints?: { name: string; type: string; baseUrl?: string; commercial?: { price?: number; currency?: string; overagePolicy?: "blocked" | "metered" | "unknown" } }[]) {
  const session = createSession({ provider: provider as never, tools: {}, ...(endpoints ? { endpoints: endpoints as never } : {}) });
  void (async () => {
    for await (const _ of session.events) void _;
  })();
  return session;
}

const of = <E extends AgentEvent["type"]>(events: AgentEvent[], type: E) =>
  events.filter((e) => e.type === type) as Extract<AgentEvent, { type: E }>[];

const EP = endpointIdentity("openai-compat", "https://api.example.com/v1");

describe("quota observations (#1100)", () => {
  it("a QuotaReport projects into observations that keep unit, window, source and unknown reset semantics", () => {
    const observations = observationsFromQuotaReport(
      {
        source: "undocumented",
        windows: [
          { label: "5h", percent: 42 },
          { label: "weekly", used: 120, limit: 1000, resetAt: 1800000000000 },
        ],
      },
      { endpoint: EP, observedAt: "2026-10-01T00:00:00.000Z" },
    );
    expect(observations).toHaveLength(2);
    const [fiveHour, weekly] = observations;
    expect(fiveHour!.window).toEqual({ label: "5h", kind: "unknown" });
    expect(fiveHour!.percent).toBe(42);
    // Absent numbers stay absent: percent-only window has no invented limit.
    expect(fiveHour!.limit).toBeUndefined();
    expect(fiveHour!.resetAt).toBeUndefined();
    expect(fiveHour!.source).toBe("quota-endpoint");
    expect(fiveHour!.authority).toBe("undocumented");
    expect(weekly!.limit).toBe(1000);
    expect(weekly!.resetAt).toBe(1800000000000);
    expect(weekly!.scopeKey).toBe(scopeKeyFor(EP));
  });

  it("scope keys separate endpoints and models but keep a shared pool together", () => {
    const other = endpointIdentity("openai-compat", "https://other.example.com/v1");
    const poolA = scopeKeyFor(EP, { scope: "pool", pool: "org-shared" });
    const poolB = scopeKeyFor(other, { scope: "pool", pool: "org-shared" });
    // A pool scope keys on the pool's identity alone: two endpoints, one pool.
    expect(poolA).toBe("pool:org-shared");
    expect(poolB).toBe(poolA);
    expect(scopeKeyFor(EP, { model: "gw/x" })).not.toBe(scopeKeyFor(EP));
  });

  it("a quota-class provider error yields a linked observation plus a block boundary — no invented numbers", () => {
    const [observation, boundary] = quotaEventsFromProviderError({
      endpoint: EP,
      errorKind: "rate_limited",
      servingModel: "openai-compat/gpt-x",
      retryAfterMs: 30000,
      observedAt: "2026-10-01T00:00:00.000Z",
      callId: "c1",
      attemptId: "a1",
    });
    expect(observation.source).toBe("provider-error");
    expect(observation.limit).toBeUndefined();
    expect(observation.window).toBeUndefined();
    expect(observation.callId).toBe("c1");
    expect(observation.attemptId).toBe("a1");
    expect(observation.errorKind).toBe("rate_limited");
    expect(boundary.phase).toBe("rate_limited");
    expect(boundary.startedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(boundary.retryAfterMs).toBe(30000);
  });
});

describe("quota episodes (#1100)", () => {
  it("pairs a block with its recovery into one distinct episode; an unpaired block stays open", () => {
    const episodes = quotaEpisodes([
      quotaEventsFromProviderError({ endpoint: EP, errorKind: "quota_exhausted", servingModel: "gw/x", observedAt: "2026-10-01T00:00:00.000Z", callId: "c1", attemptId: "a1" })[1]!,
      quotaEventsFromProviderError({ endpoint: EP, errorKind: "rate_limited", servingModel: "gw/x", observedAt: "2026-10-01T00:10:00.000Z", callId: "c2", attemptId: "a2" })[1]!,
      quotaRecoveryEvent({
        scopeKey: scopeKeyFor(EP, { model: "gw/x" }),
        endpoint: EP,
        servingModel: "gw/x",
        blockedStartedAt: "2026-10-01T00:00:00.000Z",
        waitMs: 61000,
        endedAt: "2026-10-01T01:00:00.000Z",
        callId: "c2",
      }),
    ]);
    expect(episodes).toHaveLength(2);
    const [exhausted, rateLimited] = episodes;
    expect(exhausted!.kind).toBe("exhausted");
    expect(exhausted!.recoveredAt).toBeUndefined(); // no recovery recorded — honest unknown
    expect(exhausted!.blockedCount).toBe(1);
    expect(rateLimited!.recoveredAt).toBe("2026-10-01T01:00:00.000Z");
    expect(rateLimited!.waitMs).toBe(61000);
    const summary = summarizeQuota(episodes, [], 3);
    expect(summary.exhausted).toBe(1);
    expect(summary.rateLimited).toBe(1);
    expect(summary.open).toBe(1);
    expect(summary.recovered).toBe(1);
    expect(summary.waitMs).toBe(61000);
  });

  it("marks a fallback recovery when the recovering model differs from the blocked one", () => {
    const events = [
      quotaEventsFromProviderError({ endpoint: EP, errorKind: "quota_exhausted", servingModel: "gw/a", observedAt: "2026-10-01T00:00:00.000Z", callId: "c1", attemptId: "a1" })[1]!,
      quotaRecoveryEvent({
        scopeKey: scopeKeyFor(EP, { model: "gw/a" }),
        endpoint: EP,
        servingModel: "gw/b",
        blockedStartedAt: "2026-10-01T00:00:00.000Z",
        usedFallback: true,
        endedAt: "2026-10-01T00:01:00.000Z",
        callId: "c1",
      }),
    ];
    const episodes = quotaEpisodes(events);
    expect(episodes[0]!.usedFallback).toBe(true);
    expect(summarizeQuota(episodes, [], 0).fallbackRecoveries).toBe(1);
  });

  it("a recovery with no recorded block pairs with nothing — it never invents an episode", () => {
    const episodes = quotaEpisodes([
      quotaRecoveryEvent({ scopeKey: scopeKeyFor(EP), endpoint: EP, blockedStartedAt: "2026-10-01T00:00:00.000Z" }),
    ]);
    expect(episodes).toHaveLength(0);
  });
});

describe("quota contradictions (#1100)", () => {
  it("flags two overlapping observations of the same scope+window whose limits disagree", () => {
    const a = observationsFromQuotaReport(
      { source: "official", windows: [{ label: "monthly", used: 10, limit: 100 }] },
      { endpoint: EP, observedAt: "2026-10-01T00:00:00.000Z" },
    )[0]!;
    const b = observationsFromQuotaReport(
      { source: "official", windows: [{ label: "monthly", used: 20, limit: 200 }] },
      { endpoint: EP, observedAt: "2026-10-02T00:00:00.000Z" },
    )[0]!;
    expect(quotaContradictions([a, b])).toHaveLength(1);
    // Same limit twice: no contradiction.
    expect(quotaContradictions([a, a!])).toHaveLength(0);
    // Non-overlapping validity: the earlier declaration expired before the later.
    const expired = { ...a, validUntil: "2026-10-01T12:00:00.000Z" };
    expect(quotaContradictions([expired, b])).toHaveLength(0);
    // Different scopes never contradict.
    const otherScope = { ...b, scopeKey: scopeKeyFor(endpointIdentity("anthropic", undefined), {}) };
    expect(quotaContradictions([a, otherScope])).toHaveLength(0);
  });
});

describe("commercial declarations (#1100)", () => {
  it("records the user's declaration redacted and time-bounded; refuses an inverted window", () => {
    const result = commercialDeclarationEvent(
      "my-endpoint",
      { plan: "Team Plan", price: 100, currency: "usd", billingPeriod: "monthly", promotion: "  50% off first month  ", overagePolicy: "metered", validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2026-12-31T00:00:00.000Z" },
      "2026-10-01T00:00:00.000Z",
    );
    if (!("event" in result)) throw new Error("declaration should be valid");
    const event = result.event;
    expect(event.endpoint).toBe("my-endpoint");
    expect(event.plan).toBe("Team Plan");
    expect(event.promotion).toBe("50% off first month");
    expect(event.validFrom).toBe("2026-01-01T00:00:00.000Z");
    expect(declarationInForce(event, "2026-06-01T00:00:00.000Z")).toBe(true);
    expect(declarationInForce(event, "2027-06-01T00:00:00.000Z")).toBe(false);
    expect(declarationInForce(event, "2025-06-01T00:00:00.000Z")).toBe(false);
    const bad = commercialDeclarationEvent("my-endpoint", { validFrom: "2026-06-01T00:00:00.000Z", validUntil: "2026-01-01T00:00:00.000Z" });
    expect("error" in bad).toBe(true);
  });
});

describe("the loop records quota state (#1100)", () => {
  it("a quota-exhausted failure then a success produce observation, block and recovery with observed wait", async () => {
    let call = 0;
    const provider = providerOf("gw/gpt-x", async function* (): AsyncGenerator<StreamEvent> {
      call += 1;
      yield { type: "model_call_start", model: "gw/gpt-x", endpoint: EP };
      if (call === 1) throw new ProviderError("quota_exhausted", "limit reached", undefined, { retryAfterMs: 2000 });
      yield { type: "text_delta", text: "ok" };
      yield { type: "finish", reason: "stop" };
    });
    const s = session(provider);
    // First turn hits the wall (route-less provider: the turn errors).
    const failed = await s.send("go");
    expect(failed.status).toBe("error");
    // Second turn recovers.
    const done = await s.send("go again");
    expect(done.status).toBe("done");

    const events = s.history();
    const observations = of(events, "quota_observation");
    expect(observations).toHaveLength(1);
    expect(observations[0]!.source).toBe("provider-error");
    expect(observations[0]!.errorKind).toBe("quota_exhausted");
    expect(observations[0]!.limit).toBeUndefined();
    const episodes = of(events, "quota_episode");
    expect(episodes.map((e) => e.phase)).toEqual(["exhausted", "recovered"]);
    const recovered = episodes[1]!;
    expect(recovered.waitMs).toBeGreaterThanOrEqual(0);
    expect(recovered.usedFallback).toBe(false);
  });

  it("a non-quota failure records no quota events", async () => {
    const provider = providerOf("gw/gpt-x", async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "model_call_start", model: "gw/gpt-x", endpoint: EP };
      throw new ProviderError("overloaded", "try later");
    });
    const s = session(provider);
    await s.send("go");
    expect(of(s.history(), "quota_observation")).toHaveLength(0);
    expect(of(s.history(), "quota_episode")).toHaveLength(0);
  });
});

describe("quota pressure query and aggregate rollup (#1100)", () => {
  it("reconstructs pressure, first block, wait, recovery and overage spend from a written log", async () => {
    let call = 0;
    const provider = providerOf("gw/gpt-x", async function* (): AsyncGenerator<StreamEvent> {
      call += 1;
      yield { type: "model_call_start", model: "gw/gpt-x", endpoint: EP };
      if (call === 1) throw new ProviderError("quota_exhausted", "limit reached");
      yield { type: "text_delta", text: "ok" };
      yield { type: "finish", reason: "stop" };
    });
    const s = session(provider, [
      { name: "gw", type: "openai-compat", baseUrl: "https://api.example.com/v1", commercial: { price: 1, currency: "usd", overagePolicy: "metered" } },
    ]);
    await s.send("go");
    await s.send("go again");
    s.recordQuota("gw", { source: "official", windows: [{ label: "usd", used: 12, limit: 10 }] }, { model: "gw/gpt-x", unit: "usd" });

    const rows = quotaPressure(s.history());
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.firstObservedBlock).toBeDefined();
    expect(row.recoveryTime).toBeDefined();
    expect(row.quotaPressure).toBe(120); // usd window: 12/10
    expect(row.overageSpendUsd).toBe(2); // usd-unit allowance exceeded by 2, user priced it

    // The aggregate rollup counts episodes, not raw error events.
    const dir = mkdtempSync(join(tmpdir(), "moh-quota-"));
    try {
      const slugDir = join(dir, "moh-home", ".moh", "projects", "manual-slug");
      mkdirSync(slugDir, { recursive: true });
      writeFileSync(join(slugDir, "s.jsonl"), s.history().map((e) => JSON.stringify(e)).join("\n"));
      const report = aggregateTelemetry({ cwd: join(dir, "proj"), home: join(dir, "moh-home"), slug: "manual-slug" });
      expect(report.quota.exhausted).toBe(1);
      expect(report.quota.recovered).toBe(1);
      expect(report.quota.observations).toBe(2);
      expect(report.quota.contradictions).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

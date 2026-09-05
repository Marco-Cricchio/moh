/**
 * #499: quota seam tests. Fixture-driven per-provider parsers (one
 * fixture per provider, plus a shape-drift case degrading to `null`),
 * source-badge mapping, getQuota dispatch/fallback, and local usage
 * aggregation from event-log fixtures.
 */
import { describe, expect, test } from "bun:test";
import { getQuota } from "../src/quota";
import { aggregateLocalUsage, type LocalUsageRow } from "../src/quota/local";
import type { QuotaFetch } from "../src/quota/types";
import type { AgentEvent } from "../src/types";
import type { EndpointProfile } from "../src/config";

/** Scripted GET seam: records (url, headers), replays canned responses. */
function scriptedFetch(
  results: Array<{ status: number; text: string }>,
): QuotaFetch & { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let i = 0;
  const fn: QuotaFetch = async (url, headers) => {
    calls.push({ url, headers });
    return results[i++] ?? { status: 500, text: "" };
  };
  return Object.assign(fn, { calls });
}

function profile(partial: Partial<EndpointProfile>): EndpointProfile {
  return { name: "test", type: "anthropic", ...partial } as EndpointProfile;
}

describe("getQuota — dispatch", () => {
  test("unknown kind and google return null without probing", async () => {
    const f = scriptedFetch([]);
    expect(await getQuota(profile({ type: "google" }), { fetchImpl: f })).toBeNull();
    expect(await getQuota(profile({ type: "not-a-kind" }), { fetchImpl: f })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  test("no credential returns null without probing", async () => {
    const f = scriptedFetch([]);
    expect(await getQuota(profile({ type: "anthropic", auth: { kind: "subscription" } }), { fetchImpl: f, configFile: "/nonexistent", env: {} })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  test("unsupported api-key kinds (anthropic, xai, kimi) return null without probing", async () => {
    const f = scriptedFetch([]);
    const env = {};
    for (const type of ["anthropic", "xai", "kimi-coding"] as const) {
      expect(await getQuota(profile({ type, apiKey: "sk-test" }), { fetchImpl: f, env })).toBeNull();
    }
    expect(f.calls).toHaveLength(0);
  });

  test("HTTP failure and malformed JSON degrade to null", async () => {
    const f = scriptedFetch([{ status: 503, text: "nope" }, { status: 200, text: "<html>not json</html>" }]);
    const tokenFile = await tokenStoreFixture();
    const ep = profile({ type: "anthropic", auth: { kind: "subscription" } });
    expect(await getQuota(ep, { fetchImpl: f, configFile: tokenFile, env: {} })).toBeNull();
    expect(await getQuota(ep, { fetchImpl: f, configFile: tokenFile, env: {} })).toBeNull();
  });
});

describe("getQuota — anthropic OAuth", () => {
  test("parses 5h + weekly windows with percent and reset", async () => {
    const f = scriptedFetch([
      {
        status: 200,
        text: JSON.stringify({
          five_hour: { utilization: 0.42, resets_at: 1700003600 },
          seven_day: { utilization: 73.5, resets_at: 1700600000 },
        }),
      },
    ]);
    const configFile = await tokenStoreFixture();
    const report = await getQuota(profile({ type: "anthropic", auth: { kind: "subscription" } }), {
      fetchImpl: f,
      configFile,
      env: {},
    });
    expect(report).not.toBeNull();
    expect(report!.source).toBe("undocumented");
    expect(report!.windows).toHaveLength(2);
    expect(report!.windows[0]).toMatchObject({ label: "5h window", percent: 42, resetAt: 1700003600000 });
    expect(report!.windows[1]).toMatchObject({ label: "weekly window", percent: 73.5 });
    expect(f.calls[0]!.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
  });
});

describe("getQuota — openai", () => {
  test("native ChatGPT grant parses percent_left windows", async () => {
    const f = scriptedFetch([
      {
        status: 200,
        text: JSON.stringify({
          five_hour: { percent_left: 80 },
          weekly: { percent_left: 25.5 },
        }),
      },
    ]);
    const report = await getQuota(
      profile({ type: "openai", auth: { kind: "subscription" } }),
      // direct token injection via inline apiKey is skipped; use store
      { fetchImpl: f, configFile: await nativeOpenaiStoreFixture(), env: {} },
    );
    expect(report).not.toBeNull();
    expect(report!.source).toBe("undocumented");
    expect(report!.windows[0]).toMatchObject({ label: "5h window", percent: 20 });
    expect(report!.windows[1]).toMatchObject({ label: "weekly window", percent: 74.5 });
  });

  test("minted-key grants and plain API keys return null (no admin key)", async () => {
    const f = scriptedFetch([]);
    expect(await getQuota(profile({ type: "openai", apiKey: "sk-x" }), { fetchImpl: f, env: {} })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });
});

describe("getQuota — copilot", () => {
  test("parses premium interactions entitlement/remaining with editor headers", async () => {
    const f = scriptedFetch([
      {
        status: 200,
        text: JSON.stringify({
          quota_snapshots: {
            chat: { entitlement: 300, remaining: 100, reset_date: "2026-10-01T00:00:00Z" },
          },
        }),
      },
    ]);
    const report = await getQuota(profile({ type: "github-copilot", auth: { kind: "subscription" } }), {
      fetchImpl: f,
      configFile: await copilotStoreFixture(),
      env: {},
    });
    expect(report).not.toBeNull();
    expect(report!.source).toBe("undocumented");
    expect(report!.windows[0]).toMatchObject({ used: 200, limit: 300 });
    expect(f.calls[0]!.headers["User-Agent"]).toBeDefined();
  });
});

describe("getQuota — openrouter (official)", async () => {
  test("parses key limit/usage + credits with the official badge", async () => {
    const f = scriptedFetch([
      { status: 200, text: JSON.stringify({ data: { limit: 120, usage: 45.5, rate_limit: { requests: 20, interval: "10m" } } }) },
      { status: 200, text: JSON.stringify({ data: { total_credits: 50, total_usage: 12.25 } }) },
    ]);
    const report = await getQuota(profile({ type: "openrouter", apiKey: "or-key" }), { fetchImpl: f, env: {} });
    expect(report).not.toBeNull();
    expect(report!.source).toBe("official");
    expect(report!.windows).toHaveLength(3);
    expect(report!.windows[0]).toMatchObject({ label: "limit", used: 45.5, limit: 120 });
    expect(report!.windows[2]).toMatchObject({ label: "credits", used: 12.25, limit: 50 });
  });
});

describe("getQuota — xai / kimi / z.ai", () => {
  test("xai parses remaining/total into a percent", async () => {
    const f = scriptedFetch([{ status: 200, text: JSON.stringify({ credits: { remaining_credits: 250, total_credits: 1000 } }) }]);
    const report = await getQuota(profile({ type: "xai", auth: { kind: "subscription" } }), {
      fetchImpl: f,
      configFile: await tokenStoreFixture(),
      env: {},
    });
    expect(report).not.toBeNull();
    expect(report!.windows[0]).toMatchObject({ label: "current period", percent: 75 });
  });

  test("kimi parses used/limit per window", async () => {
    const f = scriptedFetch([
      {
        status: 200,
        text: JSON.stringify({
          five_hour: { used: 12, limit: 100, reset_time: 1700003600 },
          weekly: { used: 400, limit: 1000 },
        }),
      },
    ]);
    const report = await getQuota(profile({ type: "kimi-coding", auth: { kind: "subscription" } }), {
      fetchImpl: f,
      configFile: await tokenStoreFixture(),
      env: {},
    });
    expect(report).not.toBeNull();
    expect(report!.windows[0]).toMatchObject({ label: "5h window", used: 12, limit: 100 });
    expect(report!.windows[1]).toMatchObject({ label: "weekly window", used: 400, limit: 1000 });
  });

  test("z.ai compat host parses percent windows; other compat hosts return null", async () => {
    const f = scriptedFetch([
      { status: 200, text: JSON.stringify({ data: { five_hour: { percent_used: 61 }, weekly: { percent_used: 12 } } }) },
    ]);
    const report = await getQuota(profile({ type: "openai-compat", apiKey: "z-key", baseUrl: "https://api.z.ai/api/coding/paas/v4" }), {
      fetchImpl: f,
      env: {},
    });
    expect(report).not.toBeNull();
    expect(report!.source).toBe("undocumented");
    expect(report!.windows[0]).toMatchObject({ label: "5h window", percent: 61 });

    const f2 = scriptedFetch([]);
    expect(await getQuota(profile({ type: "openai-compat", apiKey: "k", baseUrl: "https://example.com/v4" }), { fetchImpl: f2, env: {} })).toBeNull();
    expect(f2.calls).toHaveLength(0);
  });

  test("shape drift degrades to null (z.ai unstable schema)", async () => {
    const f = scriptedFetch([{ status: 200, text: JSON.stringify({ weird: { shape: true } }) }]);
    const report = await getQuota(profile({ type: "openai-compat", apiKey: "z-key", baseUrl: "https://api.z.ai/api/coding/paas/v4" }), {
      fetchImpl: f,
      env: {},
    });
    expect(report).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Local aggregation

describe("aggregateLocalUsage", () => {
  test("sums model_call usage per model, skips failed calls", () => {
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "p" },
      { type: "model_call", model: "m-1", usage: { inputTokens: 100, outputTokens: 20 } },
      { type: "model_call", model: "m-1", usage: { inputTokens: 50, outputTokens: 10 } },
      { type: "model_call", model: "m-2", usage: { inputTokens: 7, outputTokens: 3 } },
      { type: "model_call", model: "m-3", usage: { inputTokens: 999, outputTokens: 999 }, failed: true },
    ];
    const rows: LocalUsageRow[] = aggregateLocalUsage(events);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ model: "m-1", calls: 2, inputTokens: 150, outputTokens: 30 });
    expect(rows[1]).toMatchObject({ model: "m-2", calls: 1, inputTokens: 7, outputTokens: 3 });
  });

  test("empty log yields empty rows", () => {
    expect(aggregateLocalUsage([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Auth-store fixtures

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tempConfig(): string {
  return join(mkdtempSync(join(tmpdir(), "moh-quota-")), "config.json");
}

function writeStore(file: string, endpoint: string, token: Record<string, unknown>): string {
  writeFileSync(
    file,
    JSON.stringify({ auth: { tokens: { [endpoint]: { ...token, updatedAt: 1 } } } }),
  );
  return file;
}

async function tokenStoreFixture(endpoint = "test"): Promise<string> {
  const file = tempConfig();
  return writeStore(file, endpoint, { accessToken: "at-test", expiresAt: 9999999999999 });
}

async function nativeOpenaiStoreFixture(): Promise<string> {
  const file = tempConfig();
  return writeStore(file, "test", { accessToken: "chatgpt-token", grant: { minted: false, provider: "openai" }, expiresAt: 9999999999999 });
}

async function copilotStoreFixture(): Promise<string> {
  const file = tempConfig();
  return writeStore(file, "test", { accessToken: "gho-test", grant: { provider: "github-copilot" } });
}

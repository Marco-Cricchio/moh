/**
 * #1429 characterization: pins the fetch/parse edges of every quota probe
 * (non-200, invalid JSON, literal `null`/number bodies, throwing fetch,
 * non-finite numbers, out-of-range percents) so merging the probes into one
 * module cannot change `getQuota`'s outcome.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getQuota } from "../src/quota";
import type { QuotaFetch, QuotaReport } from "../src/quota/types";
import type { EndpointProfile } from "../src/config";

type Reply = { status: number; text: string } | "throw";

function scripted(replies: Reply[]): QuotaFetch & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fn: QuotaFetch = async (url) => {
    calls.push(url);
    const r = replies[i++] ?? { status: 500, text: "" };
    if (r === "throw") throw new Error("network down");
    return r;
  };
  return Object.assign(fn, { calls });
}

function store(endpoint: string, token: Record<string, unknown>): string {
  const file = join(mkdtempSync(join(tmpdir(), "moh-quota-probes-")), "config.json");
  writeFileSync(file, JSON.stringify({ auth: { tokens: { [endpoint]: { ...token, updatedAt: 1 } } } }));
  return file;
}

const sub = { auth: { kind: "subscription" } } as const;
const plain = { accessToken: "at-test", expiresAt: 9999999999999 };

interface Provider {
  name: string;
  run(f: QuotaFetch): Promise<QuotaReport | null>;
}

function ep(partial: Partial<EndpointProfile>): EndpointProfile {
  return { name: "test", type: "anthropic", ...partial } as EndpointProfile;
}

const providers: Provider[] = [
  { name: "anthropic", run: (f) => getQuota(ep({ type: "anthropic", ...sub }), { fetchImpl: f, configFile: store("test", plain), env: {} }) },
  {
    name: "openai",
    run: (f) =>
      getQuota(ep({ type: "openai", ...sub }), {
        fetchImpl: f,
        configFile: store("test", { accessToken: "t", grant: { minted: false, provider: "openai" }, expiresAt: 9999999999999 }),
        env: {},
      }),
  },
  {
    name: "copilot",
    run: (f) =>
      getQuota(ep({ type: "github-copilot", ...sub }), {
        fetchImpl: f,
        configFile: store("test", { accessToken: "gho", grant: { provider: "github-copilot" } }),
        env: {},
      }),
  },
  { name: "openrouter", run: (f) => getQuota(ep({ type: "openrouter", apiKey: "or-key" }), { fetchImpl: f, env: {} }) },
  { name: "xai", run: (f) => getQuota(ep({ type: "xai", ...sub }), { fetchImpl: f, configFile: store("test", plain), env: {} }) },
  { name: "kimi", run: (f) => getQuota(ep({ type: "kimi-coding", ...sub }), { fetchImpl: f, configFile: store("test", plain), env: {} }) },
  {
    name: "zai",
    run: (f) => getQuota(ep({ type: "openai-compat", apiKey: "z", baseUrl: "https://api.z.ai/api/coding/paas/v4" }), { fetchImpl: f, env: {} }),
  },
];

describe("quota probes — fetch/parse edges", () => {
  for (const p of providers) {
    describe(p.name, () => {
      test("status != 200 degrades to null", async () => {
        const f = scripted([{ status: 503, text: "{}" }, { status: 503, text: "{}" }]);
        expect(await p.run(f)).toBeNull();
        expect(f.calls.length).toBeGreaterThan(0);
      });
      test("invalid JSON degrades to null", async () => {
        expect(await p.run(scripted([{ status: 200, text: "<html>" }, { status: 200, text: "<html>" }]))).toBeNull();
      });
      test("literal null body degrades to null", async () => {
        expect(await p.run(scripted([{ status: 200, text: "null" }, { status: 200, text: "null" }]))).toBeNull();
      });
      test("numeric body (42) degrades to null", async () => {
        expect(await p.run(scripted([{ status: 200, text: "42" }, { status: 200, text: "42" }]))).toBeNull();
      });
      test("string body degrades to null", async () => {
        expect(await p.run(scripted([{ status: 200, text: '"x"' }, { status: 200, text: '"x"' }]))).toBeNull();
      });
      test("a throwing fetch degrades to null", async () => {
        expect(await p.run(scripted(["throw", "throw"]))).toBeNull();
      });
    });
  }

  describe("openrouter — two requests", () => {
    const key = { status: 200, text: JSON.stringify({ data: { limit: 10, usage: 2 } }) };
    const credits = { status: 200, text: JSON.stringify({ data: { total_credits: 5, total_usage: 1 } }) };
    const run = (r: Reply[]) => providers[3]!.run(scripted(r));

    test("valid /key then throwing /credits is null, not the /key window", async () => {
      const f = scripted([key, "throw"]);
      expect(await providers[3]!.run(f)).toBeNull();
      expect(f.calls).toHaveLength(2);
    });
    test("throwing /key is null and /credits is never requested", async () => {
      const f = scripted(["throw", credits]);
      expect(await providers[3]!.run(f)).toBeNull();
      expect(f.calls).toHaveLength(1);
    });
    test("valid /key with failing /credits keeps the /key window", async () => {
      const r = await run([key, { status: 500, text: "" }]);
      expect(r?.source).toBe("official");
      expect(r?.windows).toEqual([{ label: "limit", used: 2, limit: 10 }]);
    });
    test("invalid /key with valid /credits keeps the credits window", async () => {
      const r = await run([{ status: 200, text: "nope" }, credits]);
      expect(r?.windows).toEqual([{ label: "credits", used: 1, limit: 5 }]);
    });
    test("/key null body with valid /credits keeps the credits window", async () => {
      const r = await run([{ status: 200, text: "null" }, credits]);
      expect(r?.windows).toEqual([{ label: "credits", used: 1, limit: 5 }]);
    });
    test("non-object `data` is ignored", async () => {
      expect(await run([{ status: 200, text: '{"data":7}' }, { status: 200, text: '{"data":"x"}' }])).toBeNull();
    });
    test("non-finite limit is dropped", async () => {
      expect(await run([{ status: 200, text: '{"data":{"limit":1e999,"usage":1}}' }, { status: 500, text: "" }])).toBeNull();
    });
  });

  describe("non-finite numbers and percent clamping", () => {
    const ok = (obj: string): Reply => ({ status: 200, text: obj });
    const byName = (n: string) => providers.find((p) => p.name === n)!;

    test("kimi drops a non-finite used value", async () => {
      expect(await byName("kimi").run(scripted([ok('{"five_hour":{"used":1e999,"limit":100}}')]))).toBeNull();
    });
    test("zai drops a non-finite percent", async () => {
      expect(await byName("zai").run(scripted([ok('{"five_hour":{"percent_used":1e999}}')]))).toBeNull();
    });
    test("zai clamps percent to 0-100", async () => {
      const r = await byName("zai").run(scripted([ok('{"five_hour":{"percent_used":150},"weekly":{"percent_used":-5}}')]));
      expect(r?.windows.map((w) => w.percent)).toEqual([100, 0]);
    });
    test("openai clamps percent to 0-100 and drops non-finite", async () => {
      const r = await byName("openai").run(
        scripted([ok('{"five_hour":{"percent_left":-50},"weekly":{"percent_left":150},"monthly":{"utilization":1e999}}')]),
      );
      expect(r?.windows.map((w) => [w.label, w.percent])).toEqual([
        ["5h window", 100],
        ["weekly window", 0],
      ]);
    });
    test("xai clamps percent_used to 0-100; non-finite saturates to 100 (today's behaviour)", async () => {
      const r1 = await byName("xai").run(scripted([ok('{"credits":{"percent_used":150}}')]));
      expect(r1?.windows[0]?.percent).toBe(100);
      const r2 = await byName("xai").run(scripted([ok('{"percent_used":-3}')]));
      expect(r2?.windows[0]?.percent).toBe(0);
      const r3 = await byName("xai").run(scripted([ok('{"credits":{"percent_used":1e999}}')]));
      expect(r3?.windows[0]?.percent).toBe(100);
    });
    test("anthropic ignores a non-finite utilization", async () => {
      expect(await byName("anthropic").run(scripted([ok('{"five_hour":{"utilization":1e999}}')]))).toBeNull();
    });
    test("anthropic scales utilization <= 1 by 100 and passes larger values through", async () => {
      const r = await byName("anthropic").run(scripted([ok('{"five_hour":{"utilization":0.5},"seven_day":{"utilization":150}}')]));
      expect(r?.windows.map((w) => w.percent)).toEqual([50, 150]);
    });
    test("copilot keeps a non-finite entitlement as is (no isFinite guard)", async () => {
      const r = await byName("copilot").run(scripted([ok('{"quota_snapshots":{"chat":{"entitlement":1e999,"remaining":1}}}')]));
      expect(r?.windows[0]?.limit).toBe(Infinity);
    });
    test("copilot drops an unparseable reset_date", async () => {
      const r = await byName("copilot").run(
        scripted([ok('{"quota_snapshots":{"chat":{"entitlement":10,"remaining":4,"reset_date":"soon"}}}')]),
      );
      expect(r?.windows[0]).toEqual({ label: "premium interactions", used: 6, limit: 10 });
    });
  });
});

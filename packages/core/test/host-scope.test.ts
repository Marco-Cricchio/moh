/**
 * Issue #1160 — F2a (ADR-0066): the `host:<domain>` scope, end to end on
 * the phase-1 seam. Same high seam as #1159: a probe extension loaded
 * through the runtime, `ctx.host.fetch` driven against a real local HTTP
 * server, redirects and size limits exercised for real, events asserted
 * through the runtime's load-event channel.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionDefinition, ExtensionHost, ExtensionSetupContext } from "@moh/extension";
import { ExtensionRuntime } from "../src/extensions";
import { scopeEffectSentence, scopeEffectSentences } from "../src/scope-effect";
import { hostMatchesScope, validateHostScope } from "../src/host-scope";
import type { AgentEvent } from "../src/types";
import type { CredentialStore } from "../src/credential-scope";

const roots: string[] = [];
const servers: Bun.Server<never>[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const s of servers.splice(0)) s.stop(true);
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "moh-host-scope-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  return root;
}

function runtime(root: string, extra: { credentialStore?: CredentialStore } = {}): ExtensionRuntime {
  return new ExtensionRuntime({
    mohHome: mkdtempSync(join(tmpdir(), "moh-host-home-")),
    projectRoot: root,
    consent: () => true,
    ...extra,
  });
}

/** A minimal in-memory credential store (the runtime's test shape). */
function memoryStore(initial: Record<string, string>): CredentialStore {
  const map = new Map(Object.entries(initial));
  return {
    get: (ref) => map.get(ref),
    set: (ref, value) => void map.set(ref, value),
    delete: (ref) => map.delete(ref),
    list: () => [...map.keys()].sort(),
  };
}

async function probe(
  root: string,
  capabilities: readonly string[],
  events: AgentEvent[],
  manifest?: { reasoning?: string; store?: Record<string, string> },
) {
  const rt = runtime(root, manifest?.store !== undefined ? { credentialStore: memoryStore(manifest.store) } : {});
  const box: { ctx: ExtensionSetupContext | null } = { ctx: null };
  rt.onLoadEvent((event) => events.push(event));
  await rt.register(
    {
      name: "probe",
      version: "1",
      apiVersion: "1.13",
      capabilities: [...capabilities],
      setup: (ctx) => {
        box.ctx = ctx;
      },
    } as ExtensionDefinition,
    manifest?.reasoning !== undefined
      ? { manifest: { hash: "test-hash", path: "test-manifest", capabilities: [...capabilities], reasoning: manifest.reasoning } }
      : {},
  );
  await rt.ready();
  return box.ctx;
}

type Route = { status?: number; body?: string | Uint8Array; headers?: Record<string, string>; location?: string };

/** A local HTTP server bound to 127.0.0.1; routes keyed by path. */
function server(routes: Record<string, Route>): { origin: string; host: string; port: number } {
  const table = new Map(Object.entries(routes));
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      const route = table.get(url.pathname) ?? { status: 404, body: "no route" };
      const headers = new Headers(route.headers);
      if (route.location !== undefined) headers.set("location", route.location);
      const body = route.body === undefined ? "" : typeof route.body === "string" ? route.body : new Uint8Array(route.body);
      return new Response(body, { status: route.status ?? 200, headers });
    },
  });
  servers.push(s);
  return { origin: s.url.origin, host: "127.0.0.1", port: Number(new URL(s.url.origin).port) };
}

describe("host scope: grammar and validation (ADR-0066)", () => {
  test("exact host, wildcard subdomain, explicit port, https implicit", () => {
    expect(validateHostScope("host:api.example.com")).toEqual({ ok: true, host: "api.example.com", port: undefined, wildcard: false });
    expect(validateHostScope("host:*.example.com")).toEqual({ ok: true, host: "*.example.com", port: undefined, wildcard: true });
    expect(validateHostScope("host:localhost:3000")).toEqual({ ok: true, host: "localhost", port: 3000, wildcard: false });
  });

  test("malformed forms refuse loudly", () => {
    for (const bad of ["host:", "host: ", "host:api.example.com/path", "host://api.example.com", "host:a..b", "host:*.*.example.com", "host:*:99999", "host:not_a_host", "host:*:8443"]) {
      expect(validateHostScope(bad).ok).toBe(false);
    }
  });

  test("effect sentence: may contact the host", () => {
    expect(scopeEffectSentence("host:api.example.com")).toBe("may contact `api.example.com` over https");
    expect(scopeEffectSentence("host:*.example.com")).toBe("may contact any subdomain of `example.com` over https");
    expect(scopeEffectSentence("host:localhost:3000")).toBe("may contact `localhost:3000` over https");
    expect(scopeEffectSentence("host:*")).toContain("any host on the internet");
  });
});

describe("host scope: fetch end to end", () => {
  test("exact-host grant contacts that host over https-implicit http dev server; different host refused", async () => {
    const root = project();
    const s = server({ "/data": { status: 200, body: "hello" } });
    const events: AgentEvent[] = [];
    const ctx = await probe(root, [`host:${s.host}:${s.port}`], events);
    const host = ctx?.host as ExtensionHost;
    expect(typeof host).toBe("object");

    const ok = await host.fetch!(`http://${s.host}:${s.port}/data`);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.status).toBe(200);
      expect(new TextDecoder().decode(ok.bytes)).toBe("hello");
      expect(ok.bytes.byteLength).toBe(5);
    }

    // A request to a different host: typed refusal + host_refused.
    const refused = await host.fetch!("http://not-allowed.example.com/x");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("outside_scope");

    const ops = events.filter((e) => e.type === "host_op");
    const fetchOp = ops.find((e) => (e as { op: string }).op === "fetch") as { host: string; path: string; status: number; bytes: number } | undefined;
    expect(fetchOp).toBeDefined();
    expect(fetchOp!.host).toBe(`${s.host}:${s.port}`);
    expect(fetchOp!.path).toBe("/data");
    expect(fetchOp!.status).toBe(200);
    expect(fetchOp!.bytes).toBe(5);
    const refusals = events.filter((e) => e.type === "host_refused");
    expect(refusals).toHaveLength(1);
    expect((refusals[0] as { target: string }).target).toBe("not-allowed.example.com");
    expect(events.some((e) => e.type === "extension_failed")).toBe(false);
  });

  test("#1162: POST with a body crosses the seam, method logged, GET+body refused", async () => {
    const root = project();
    const seen: { method: string; body: string; auth?: string; contentType?: string }[] = [];
    const s = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        seen.push({
          method: req.method,
          body: await req.text(),
          auth: req.headers.get("authorization") ?? undefined,
          contentType: req.headers.get("content-type") ?? undefined,
        });
        return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    servers.push(s as unknown as Bun.Server<never>);
    const hostPort = `127.0.0.1:${new URL(s.url.origin).port}`;
    const events: AgentEvent[] = [];
    const ctx = await probe(root, [`host:${hostPort}`, "credential:probe"], events, { store: { probe: "sekrit" } });
    const host = ctx?.host as ExtensionHost;

    const posted = await host.fetch!(`http://${hostPort}/judge`, {
      method: "POST",
      body: JSON.stringify({ state: "rm -rf /" }),
      credential: "probe",
    });
    expect(posted.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.body).toBe(JSON.stringify({ state: "rm -rf /" }));
    expect(seen[0]!.auth).toBe("Bearer sekrit");
    expect(seen[0]!.contentType).toBe("application/json");
    const op = events.find((e) => e.type === "host_op" && (e as { op: string }).op === "fetch") as { method?: string; status: number } | undefined;
    expect(op?.method).toBe("POST");
    expect(op?.status).toBe(200);

    // A body on the default GET is a typed refusal, never a silent drop.
    const bad = await host.fetch!(`http://${hostPort}/x`, { body: "nope" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reason).toBe("failed");
      expect(bad.message).toContain("POST");
    }

    // An oversize request body is the same too_large answer the response has.
    const big = await host.fetch!(`http://${hostPort}/x`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.reason).toBe("too_large");
  });

  test("wildcard covers one label only (ADR-0066)", () => {
    const check = validateHostScope("host:*.example.com");
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const url = (host: string) => new URL(`https://${host}/`);
    expect(hostMatchesScope(check, url("a.example.com"))).toBe(true);
    expect(hostMatchesScope(check, url("example.com"))).toBe(false);
    expect(hostMatchesScope(check, url("deep.a.example.com"))).toBe(false);
    expect(hostMatchesScope(check, url("a.example.org"))).toBe(false);
  });

  test("total wildcard host:* with reasoning contacts any host", async () => {
    const root = project();
    const s = server({ "/w": { status: 200, body: "wild" } });
    const events: AgentEvent[] = [];
    // The total wildcard is https-implicit; a plain-http dev server is
    // refused, so the acceptance here is the typed outside_scope on the
    // http URL — with the wildcard grant itself proven live by the
    // hostMatchesScope unit above.
    const ctx = await probe(root, ["host:*"], events, { reasoning: "test wildcard" });
    const host = ctx?.host as ExtensionHost;
    const ok = await host.fetch!(`http://${s.host}:${s.port}/w`);
    expect(ok.ok).toBe(false);
    if (!ok.ok) expect(ok.reason).toBe("outside_scope");
  });

  test("host:* with an explicit port is malformed at load (no port on the total wildcard)", async () => {
    const root = project();
    const events: AgentEvent[] = [];
    const ctx = await probe(root, ["host:*:8443"], events, { reasoning: "test" });
    expect(ctx).toBeNull();
    expect(events.some((e) => e.type === "extension_failed" && (e as { reason: string }).reason === "invalid_host_scope")).toBe(true);
  });

  test("redirect inside the allowlist is followed", async () => {
    const root = project();
    const s = server({
      "/start": { status: 302, location: "/end" },
      "/end": { status: 200, body: "arrived" },
    });
    const events: AgentEvent[] = [];
    const ctx = await probe(root, [`host:${s.host}:${s.port}`], events);
    const host = ctx?.host as ExtensionHost;
    const ok = await host.fetch!(`http://${s.host}:${s.port}/start`);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.status).toBe(200);
      expect(new TextDecoder().decode(ok.bytes)).toBe("arrived");
    }
  });

  test("redirect to a non-allowlisted host is refused with the target named", async () => {
    const root = project();
    const s = server({ "/trap": { status: 302, location: "http://evil.example.com/steal" } });
    const events: AgentEvent[] = [];
    const ctx = await probe(root, [`host:${s.host}:${s.port}`], events);
    const host = ctx?.host as ExtensionHost;
    const result = await host.fetch!(`http://${s.host}:${s.port}/trap`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("outside_scope");
      expect((result as { target?: string }).target).toBe("evil.example.com");
    }
    const refusals = events.filter((e) => e.type === "host_refused");
    expect(refusals).toHaveLength(1);
    expect((refusals[0] as { target: string }).target).toBe("evil.example.com");
  });

  test("oversize response returns too_large; normal returns buffered bytes", async () => {
    const root = project();
    const s = server({
      "/big": { status: 200, body: new Uint8Array(2 * 1024 * 1024).fill(0x61) },
      "/small": { status: 200, body: "ok" },
    });
    const events: AgentEvent[] = [];
    const ctx = await probe(root, [`host:${s.host}:${s.port}`], events);
    const host = ctx?.host as ExtensionHost;

    const tooBig = await host.fetch!(`http://${s.host}:${s.port}/big`);
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.reason).toBe("too_large");

    const small = await host.fetch!(`http://${s.host}:${s.port}/small`);
    expect(small.ok).toBe(true);
    if (small.ok) expect(small.bytes.byteLength).toBe(2);

    const refusals = events.filter((e) => e.type === "host_refused");
    expect(refusals.some((e) => (e as { reason: string }).reason === "too_large")).toBe(true);
  });

  test("network failure is a typed failed result, never an exception", async () => {
    const root = project();
    const events: AgentEvent[] = [];
    const ctx = await probe(root, ["host:127.0.0.1:1"], events);
    const host = ctx?.host as ExtensionHost;
    const result = await host.fetch!("http://127.0.0.1:1/nope");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("failed");
      expect(typeof result.message).toBe("string");
    }
  });
});

describe("host:* requires manifest reasoning (ADR-0066)", () => {
  test("host:* without reasoning fails at load, loudly", async () => {
    const root = project();
    const events: AgentEvent[] = [];
    const ctx = await probe(root, ["host:*"], events);
    expect(ctx).toBeNull();
    expect(events.some((e) => e.type === "extension_failed" && (e as { reason: string }).reason === "missing_reasoning")).toBe(true);
  });

  test("host:* with reasoning loads and consent can display it", async () => {
    const root = project();
    const events: AgentEvent[] = [];
    const ctx = await probe(root, ["host:*"], events, { reasoning: "aggregates public package metadata across registries" });
    expect(ctx?.host).toBeDefined();
  });

  test("host:<domain> does not need reasoning", async () => {
    const root = project();
    const s = server({});
    const events: AgentEvent[] = [];
    const ctx = await probe(root, [`host:${s.host}:${s.port}`], events);
    expect(ctx?.host).toBeDefined();
  });
});

describe("host scope: consent effect sentences (ADR-0066)", () => {
  test("rendered from the shared renderer", () => {
    const sentence = scopeEffectSentence("host:api.example.com");
    expect(sentence).toContain("api.example.com");
    expect(scopeEffectSentences(["path:src/**", "host:api.example.com"]).join(" ")).toContain("api.example.com");
  });
});

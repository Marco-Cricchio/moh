/**
 * Issue #1161 — F2b (ADR-0069): the `credential:<ref>` scope, end to end.
 * Same high seam as #1159/#1160: a probe extension loaded through the
 * runtime, `ctx.host.fetch(url, { credential })` driven against a real
 * local HTTP server, the store injected (in-memory), events asserted
 * through the runtime's load-event channel. The 0600-file fallback is
 * asserted as storage behavior; the keychain path is the injected seam's
 * default, never exercised by tests.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionDefinition, ExtensionHost, ExtensionSetupContext } from "@moh/extension";
import { ExtensionRuntime } from "../src/extensions";
import {
  scopeEffectSentence,
} from "../src/host-scope";
import {
  credentialScopeRef,
  isCredentialScope,
  validateCredentialScope,
  fileCredentialStore,
  type CredentialStore,
} from "../src/credential-scope";
import type { AgentEvent } from "../src/types";

const roots: string[] = [];
const servers: Bun.Server<never>[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const s of servers.splice(0)) s.stop(true);
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "moh-cred-scope-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  return root;
}

function runtime(root: string, store?: CredentialStore): ExtensionRuntime {
  return new ExtensionRuntime({
    mohHome: mkdtempSync(join(tmpdir(), "moh-cred-home-")),
    projectRoot: root,
    consent: () => true,
    ...(store ? { credentialStore: store } : {}),
  });
}

async function probe(root: string, capabilities: readonly string[], events: AgentEvent[], store?: CredentialStore) {
  const rt = runtime(root, store);
  const box: { ctx: ExtensionSetupContext | null } = { ctx: null };
  rt.onLoadEvent((event) => events.push(event));
  await rt.register({
    name: "probe",
    version: "1",
    apiVersion: "1.13",
    capabilities: [...capabilities],
    setup: (ctx) => {
      box.ctx = ctx;
    },
  } as ExtensionDefinition);
  await rt.ready();
  return box.ctx;
}

type Route = { status?: number; body?: string | Uint8Array; headers?: Record<string, string>; location?: string; seen?: { auth?: string } };

/** A local HTTP server bound to 127.0.0.1; routes keyed by path. */
function server(routes: Record<string, Route>): { origin: string; host: string; port: number } {
  const table = new Map(Object.entries(routes));
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      const route = table.get(url.pathname) ?? { status: 404, body: "no route" };
      if (route.seen) route.seen.auth = req.headers.get("authorization") ?? undefined;
      const headers = new Headers(route.headers);
      if (route.location !== undefined) headers.set("location", route.location);
      const body = route.body === undefined ? "" : typeof route.body === "string" ? route.body : new Uint8Array(route.body);
      return new Response(body, { status: route.status ?? 200, headers });
    },
  });
  servers.push(s);
  return { origin: s.url.origin, host: "127.0.0.1", port: Number(new URL(s.url.origin).port) };
}

function memoryStore(secrets: Record<string, string>): CredentialStore {
  const map = new Map(Object.entries(secrets));
  return {
    get: (ref) => map.get(ref),
    set: (ref, value) => void map.set(ref, value),
    delete: (ref) => map.delete(ref),
    list: () => [...map.keys()],
  };
}

describe("credential scope: grammar and validation (ADR-0069)", () => {
  test("a ref is a non-empty name; malformed forms refuse loudly", () => {
    expect(isCredentialScope("credential:deploy-key")).toBe(true);
    expect(isCredentialScope("path:src/**")).toBe(false);
    expect(validateCredentialScope("credential:deploy-key")).toEqual({ ok: true, ref: "deploy-key" });
    for (const bad of ["credential:", "credential: ", "credential:a b", "credential:a\nb"]) {
      expect(validateCredentialScope(bad).ok).toBe(false);
    }
    expect(credentialScopeRef("credential:deploy-key")).toBe("deploy-key");
  });

  test("effect sentence: may use the credential <ref>", () => {
    expect(scopeEffectSentence("credential:deploy-key")).toBe("may use the credential `deploy-key`");
    expect(scopeEffectSentence("credential:no-such")).toBe("may use the credential `no-such`");
  });
});

describe("credential store: the injected seam", () => {
  test("the 0600-file fallback stores, lists and deletes; the file is owner-only", () => {
    const home = mkdtempSync(join(tmpdir(), "moh-cred-store-"));
    roots.push(home);
    const store = fileCredentialStore({ home });
    expect(store.list()).toEqual([]);
    store.set("deploy-key", "s3cret");
    expect(store.get("deploy-key")).toBe("s3cret");
    expect(store.list()).toEqual(["deploy-key"]);

    const file = join(home, ".moh", "secrets.json");
    expect(existsSync(file)).toBe(true);
    const { statSync } = require("node:fs") as typeof import("node:fs");
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    // Separate namespace: not the user-config file the auth store owns.
    expect(existsSync(join(home, ".moh", "config.json"))).toBe(false);

    expect(store.delete("deploy-key")).toBe(true);
    expect(store.get("deploy-key")).toBeUndefined();
    expect(store.delete("deploy-key")).toBe(false);
  });
});

describe("credential scope: fetch end to end", () => {
  test("a set secret authenticates the fetch; the value never reaches extension code", async () => {
    const root = project();
    const seen: { auth?: string } = {};
    const s = server({ "/api": { status: 200, body: "ok", seen } });
    const events: AgentEvent[] = [];
    const ctx = await probe(root, [`host:${s.host}:${s.port}`, "credential:deploy-key"], events, memoryStore({ "deploy-key": "s3cret" }));
    const host = ctx?.host as ExtensionHost;
    expect(typeof host).toBe("object");

    const res = await host.fetch!(`${s.origin}/api`, { credential: "deploy-key" });
    expect(res.ok).toBe(true);
    expect(seen.auth).toBe("Bearer s3cret");

    // The typed surface offers no way to read the value back.
    expect("readCredential" in host).toBe(false);
    expect("getCredential" in host).toBe(false);

    // The log carries the ref name, never a value.
    const op = events.find((e) => e.type === "host_op" && e.op === "fetch") as Extract<AgentEvent, { type: "host_op" }>;
    expect(op.credential).toBe("deploy-key");
    expect(JSON.stringify(events)).not.toContain("s3cret");
  });

  test("an unknown ref is a loud typed refusal with its host_refused event", async () => {
    const root = project();
    const s = server({ "/api": { status: 200, body: "ok" } });
    const events: AgentEvent[] = [];
    const ctx = await probe(root, [`host:${s.host}:${s.port}`, "credential:deploy-key"], events, memoryStore({}));
    const host = ctx?.host as ExtensionHost;

    const res = await host.fetch!(`${s.origin}/api`, { credential: "deploy-key" });
    expect(res).toEqual({ ok: false, reason: "unknown_credential" });
    const refused = events.find((e) => e.type === "host_refused" && e.reason === "unknown_credential") as Extract<AgentEvent, { type: "host_refused" }>;
    expect(refused.credential).toBe("deploy-key");
  });

  test("with only host: granted, an authenticated request is refused; anonymous still works", async () => {
    const root = project();
    const seen: { auth?: string } = {};
    const s = server({ "/api": { status: 200, body: "ok", seen } });
    const events: AgentEvent[] = [];
    const ctx = await probe(root, [`host:${s.host}:${s.port}`], events, memoryStore({ "deploy-key": "s3cret" }));
    const host = ctx?.host as ExtensionHost;

    const res = await host.fetch!(`${s.origin}/api`, { credential: "deploy-key" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("outside_scope");
    expect(seen.auth).toBeUndefined();
    const refused = events.find((e) => e.type === "host_refused" && e.credential === "deploy-key") as Extract<AgentEvent, { type: "host_refused" } | undefined>;
    expect(refused).toBeDefined();

    // Anonymous requests under host: alone are unchanged.
    const anon = await host.fetch!(`${s.origin}/api`);
    expect(anon.ok).toBe(true);
    expect(seen.auth).toBeUndefined();
  });

  test("a granted credential scope without a matching host scope still refuses the request on the host check", async () => {
    const root = project();
    const s = server({ "/api": { status: 200, body: "ok" } });
    const events: AgentEvent[] = [];
    const ctx = await probe(root, ["credential:deploy-key"], events, memoryStore({ "deploy-key": "s3cret" }));
    const host = ctx?.host as ExtensionHost;
    expect(typeof host).toBe("object"); // the seam exists: a credential scope is a scope

    const res = await host.fetch!(`${s.origin}/api`, { credential: "deploy-key" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("outside_scope");
  });

  test("two extensions granted the same ref share the secret", async () => {
    const root = project();
    const seen: { auth?: string } = {};
    const s = server({ "/api": { status: 200, body: "ok", seen } });
    const store = memoryStore({ "deploy-key": "s3cret" });
    const events: AgentEvent[] = [];
    const ctxA = await probe(root, [`host:${s.host}:${s.port}`, "credential:deploy-key"], events, store);
    const ctxB = await probe(root, [`host:${s.host}:${s.port}`, "credential:deploy-key"], events, store);
    const rA = await (ctxA?.host as ExtensionHost).fetch!(`${s.origin}/api`, { credential: "deploy-key" });
    const rB = await (ctxB?.host as ExtensionHost).fetch!(`${s.origin}/api`, { credential: "deploy-key" });
    expect(rA.ok).toBe(true);
    expect(rB.ok).toBe(true);
    expect(seen.auth).toBe("Bearer s3cret");
  });

  test("the credential rides every redirect hop in scope", async () => {
    const root = project();
    const seen: { auth?: string } = {};
    const s = server({
      "/start": { status: 302, location: "/finish" },
      "/finish": { status: 200, body: "done", seen },
    });
    const events: AgentEvent[] = [];
    const ctx = await probe(root, [`host:${s.host}:${s.port}`, "credential:deploy-key"], events, memoryStore({ "deploy-key": "s3cret" }));
    const host = ctx?.host as ExtensionHost;
    const res = await host.fetch!(`${s.origin}/start`, { credential: "deploy-key" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(new TextDecoder().decode(res.bytes)).toBe("done");
    expect(seen.auth).toBe("Bearer s3cret");
  });
});

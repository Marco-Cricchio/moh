import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authSectionSchema, authMethodKindSchema, authTokenSchema, endpointAuthSchema } from "../src/auth/types";
import { bindStoredApiKeyOrigin, clearStoredApiKey, clearTokens, getStoredApiKey, getStoredApiKeyOrigin, getStoredToken, readStoredTokens, saveStoredApiKey, saveTokens } from "../src/auth/store";
import { loadMergedConfig, upsertUserEndpoint } from "../src/provider-config";
import { updateUserConfigFile, userConfigFile } from "../src/user-config";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "moh-auth-")), "config");
}

const token = {
  accessToken: "at-1",
  refreshToken: "rt-1",
  expiresAt: 4102444800000,
  scopes: ["user:inference"],
  account: { email: "me@example.com" },
  grant: { inferenceOnly: true },
  updatedAt: 1700000000000,
};

describe("auth schemas", () => {
  test("AuthMethodKind accepts both kinds", () => {
    expect(authMethodKindSchema.parse("api-key")).toBe("api-key");
    expect(authMethodKindSchema.parse("subscription")).toBe("subscription");
    expect(authMethodKindSchema.safeParse("oauth").success).toBe(false);
  });

  test("endpointAuthSchema: { kind } only", () => {
    expect(endpointAuthSchema.parse({ kind: "subscription" })).toEqual({ kind: "subscription" });
    expect(endpointAuthSchema.safeParse({ kind: "nope" }).success).toBe(false);
  });

  test("authTokenSchema: accessToken + updatedAt required, extras optional", () => {
    expect(authTokenSchema.safeParse({ accessToken: "a", updatedAt: 1 }).success).toBe(true);
    expect(authTokenSchema.safeParse({ accessToken: "a" }).success).toBe(false);
    expect(authTokenSchema.parse(token)).toEqual(token);
  });

  test("authSectionSchema: tokens and optional wizard-stored api keys keyed by endpoint name", () => {
    expect(authSectionSchema.parse({ tokens: { myend: token } })).toEqual({ tokens: { myend: token } });
    expect(authSectionSchema.parse({ tokens: {}, apiKeys: { myend: "sk-live" } }).apiKeys).toEqual({ myend: "sk-live" });
    expect(authSectionSchema.safeParse({ tokens: { x: { accessToken: "a" } } }).success).toBe(false);
  });
});

describe("auth store", () => {
  test("save/get roundtrip; unrelated keys and sections survive", () => {
    const file = tmpFile();
    updateUserConfigFile(file, (d) => {
      d.mode = "dev";
      d.endpoints = [{ name: "other", type: "openai", apiKey: "k" }];
    });
    saveTokens(file, "claude", token);
    expect(getStoredToken(file, "claude")).toEqual(token);
    expect(getStoredToken(file, "missing")).toBeUndefined();

    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.mode).toBe("dev");
    expect(raw.endpoints).toHaveLength(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("stored api key roundtrip is guardian-owned and does not disturb tokens (SEC-06)", () => {
    const file = tmpFile();
    saveTokens(file, "claude", token);
    saveStoredApiKey(file, "openai", "sk-live");
    expect(getStoredApiKey(file, "openai")).toBe("sk-live");
    expect(getStoredToken(file, "claude")).toEqual(token);
    clearStoredApiKey(file, "openai");
    expect(getStoredApiKey(file, "openai")).toBeUndefined();
    expect(getStoredToken(file, "claude")).toEqual(token);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("api key origin binding: save with origin persists it (#1256)", () => {
    const file = tmpFile();
    saveStoredApiKey(file, "acme", "sk-live", {}, { type: "openai-compat", baseUrl: "https://api.acme.com/v1" });
    expect(getStoredApiKey(file, "acme")).toBe("sk-live");
    expect(getStoredApiKeyOrigin(file, "acme")).toEqual({ type: "openai-compat", baseUrl: "https://api.acme.com/v1" });
  });

  test("api key origin binding: origin optional; replacing a key without one drops the stale binding (#1256)", () => {
    const file = tmpFile();
    saveStoredApiKey(file, "acme", "sk-live");
    expect(getStoredApiKeyOrigin(file, "acme")).toBeUndefined();
    saveStoredApiKey(file, "acme", "sk-live", {}, { type: "openai-compat", baseUrl: "https://api.acme.com/v1" });
    saveStoredApiKey(file, "acme", "sk-rotated");
    expect(getStoredApiKey(file, "acme")).toBe("sk-rotated");
    expect(getStoredApiKeyOrigin(file, "acme")).toBeUndefined();
  });

  test("bindStoredApiKeyOrigin binds an existing key; no-op when no key is stored (#1256)", () => {
    const file = tmpFile();
    bindStoredApiKeyOrigin(file, "acme", { type: "anthropic" });
    expect(getStoredApiKey(file, "acme")).toBeUndefined();
    saveStoredApiKey(file, "acme", "sk-live");
    bindStoredApiKeyOrigin(file, "acme", { type: "anthropic", baseUrl: "https://api.acme.com" });
    expect(getStoredApiKeyOrigin(file, "acme")).toEqual({ type: "anthropic", baseUrl: "https://api.acme.com" });
  });

  test("clearStoredApiKey removes the key and its origin binding (#1256)", () => {
    const file = tmpFile();
    saveStoredApiKey(file, "acme", "sk-live", {}, { type: "anthropic" });
    clearStoredApiKey(file, "acme");
    expect(getStoredApiKey(file, "acme")).toBeUndefined();
    expect(getStoredApiKeyOrigin(file, "acme")).toBeUndefined();
  });

  test("save replaces per-endpoint tokens without touching others", () => {
    const file = tmpFile();
    saveTokens(file, "a", { ...token, accessToken: "a-1" });
    saveTokens(file, "b", { ...token, accessToken: "b-1" });
    saveTokens(file, "a", { ...token, accessToken: "a-2" });
    const tokens = readStoredTokens(file);
    expect(tokens.a.accessToken).toBe("a-2");
    expect(tokens.b.accessToken).toBe("b-1");
  });

  test("clearTokens removes one endpoint; no-op when absent", () => {
    const file = tmpFile();
    saveTokens(file, "a", token);
    saveTokens(file, "b", token);
    clearTokens(file, "a");
    clearTokens(file, "nope");
    expect(readStoredTokens(file)).toEqual({ b: token });
    clearTokens(file, "b");
    expect(readStoredTokens(file)).toEqual({});
  });

  test("missing file reads as {}; invalid auth section throws", () => {
    expect(readStoredTokens(join(tmpdir(), `nope-${Date.now()}`, "config"))).toEqual({});
    const file = tmpFile();
    updateUserConfigFile(file, (d) => void (d.auth = { tokens: "not-an-object" }));
    expect(() => readStoredTokens(file)).toThrow(/auth section/);
    expect(() => saveTokens(file, "a", token)).toThrow(/auth section/);
  });

  test("auth is never a merge candidate and survives provider writes", () => {
    const file = tmpFile();
    saveTokens(file, "claude", token);
    upsertUserEndpoint(file, { name: "claude", type: "anthropic", auth: { kind: "subscription" } });
    // merged config carries no token material anywhere (auth never merges)
    const home = mkdtempSync(join(tmpdir(), "moh-auth-home-"));
    const homeConfig = userConfigFile(home);
    updateUserConfigFile(homeConfig, (d) => {
      d.auth = JSON.parse(readFileSync(file, "utf8")).auth;
      d.endpoints = [{ name: "claude", type: "anthropic" }];
    });
    const merged = loadMergedConfig(tmpdir(), { home });
    expect(merged.endpoints?.[0]).toEqual({ name: "claude", type: "anthropic" });
    expect(JSON.stringify(merged)).not.toContain("at-1");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.auth.tokens.claude).toEqual(token);
    expect(raw.endpoints[0].auth).toEqual({ kind: "subscription" });
  });
});

// #1431 (expand phase of S4.1): real-file coverage of the auth store ahead of
// the removal of the `read` / `io` seam (#1434). The store has no injected-I/O
// tests; these pin what each function does today on a malformed section.
describe("auth store — real file (#1431)", () => {
  const raw = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
  const seedFile = (body: unknown, fileMode = 0o644): string => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify(body));
    chmodSync(file, fileMode);
    return file;
  };
  const BAD = { keep: 1, auth: { tokens: "x" } };

  test("readers throw the module's `auth section` error on a malformed section (real file)", () => {
    const file = seedFile(BAD);
    expect(() => readStoredTokens(file)).toThrow(/auth section/);
    expect(() => getStoredToken(file, "a")).toThrow(/auth section/);
    expect(() => getStoredApiKey(file, "a")).toThrow(/auth section/);
    expect(() => getStoredApiKeyOrigin(file, "a")).toThrow(/auth section/);
    expect(raw(file)).toEqual(BAD);
  });

  test("saveTokens refuses a malformed section with its own message and leaves the file untouched (real file)", () => {
    const file = seedFile(BAD);
    expect(() => saveTokens(file, "a", token)).toThrow(/fix or remove it before saving tokens/);
    expect(raw(file)).toEqual(BAD);
  });

  test("on a malformed section the other writers do not throw: they keep the bad value and add their own keys (real file)", () => {
    // characterization of today's behavior, not an endorsement of it
    const keyed = seedFile(BAD);
    saveStoredApiKey(keyed, "a", "k");
    expect(raw(keyed)).toEqual({ keep: 1, auth: { tokens: "x", apiKeys: { a: "k" }, apiKeyOrigins: {} } });

    const cleared = seedFile(BAD);
    clearStoredApiKey(cleared, "a");
    expect(raw(cleared)).toEqual({ keep: 1, auth: { tokens: "x", apiKeys: {}, apiKeyOrigins: {} } });

    const bound = seedFile(BAD);
    bindStoredApiKeyOrigin(bound, "a", { type: "anthropic" });
    expect(raw(bound)).toEqual(BAD);

    const tokens = seedFile(BAD);
    clearTokens(tokens, "a");
    expect(raw(tokens)).toEqual({ keep: 1, auth: { tokens: { "0": "x" } } });
  });

  test("a non-object auth section: saveStoredApiKey replaces it, clearTokens leaves it (real file)", () => {
    const keyed = seedFile({ keep: 1, auth: 5 });
    saveStoredApiKey(keyed, "a", "k");
    expect(raw(keyed)).toEqual({ keep: 1, auth: { tokens: {}, apiKeys: { a: "k" }, apiKeyOrigins: {} } });
    const cleared = seedFile({ keep: 1, auth: 5 });
    clearTokens(cleared, "a");
    expect(raw(cleared)).toEqual({ keep: 1, auth: 5 });
  });

  test("unknown sections and unknown auth keys survive every writer; the whole file is read-modify-written (real file)", () => {
    const file = seedFile({ theme: "nord", futureSection: { x: [1] }, auth: { tokens: {}, overrides: { o: 1 } } });
    saveTokens(file, "a", token);
    saveStoredApiKey(file, "b", "k", {}, { type: "anthropic" });
    bindStoredApiKeyOrigin(file, "b", { type: "openai", baseUrl: "https://x/v1" });
    const data = raw(file);
    expect(data.theme).toBe("nord");
    expect(data.futureSection).toEqual({ x: [1] });
    expect(data.auth.overrides).toEqual({ o: 1 });
    expect(data.auth.tokens.a).toEqual(token);
    expect(data.auth.apiKeys).toEqual({ b: "k" });
    expect(data.auth.apiKeyOrigins).toEqual({ b: { type: "openai", baseUrl: "https://x/v1" } });
    clearStoredApiKey(file, "b");
    clearTokens(file, "a");
    expect(raw(file)).toEqual({
      theme: "nord",
      futureSection: { x: [1] },
      auth: { tokens: {}, overrides: { o: 1 }, apiKeys: {}, apiKeyOrigins: {} },
    });
  });

  test("final mode is 0600 after every writer, even over a pre-existing 0644 file (real file)", () => {
    const writers: Array<(f: string) => void> = [
      (f) => saveTokens(f, "a", token),
      (f) => clearTokens(f, "a"),
      (f) => saveStoredApiKey(f, "a", "k"),
      (f) => bindStoredApiKeyOrigin(f, "a", { type: "anthropic" }),
      (f) => clearStoredApiKey(f, "a"),
    ];
    for (const write of writers) {
      const file = seedFile({ auth: { tokens: {}, apiKeys: { a: "k" } } }, 0o644);
      write(file);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authSectionSchema, authMethodKindSchema, authTokenSchema, endpointAuthSchema } from "../src/auth/types";
import { clearTokens, getStoredToken, readStoredTokens, saveTokens } from "../src/auth/store";
import { updateUserConfigFile } from "../src/user-config";
import { loadMergedConfig } from "../src/provider-config";
import { upsertUserEndpoint } from "../src/provider-config";

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

  test("authSectionSchema: tokens keyed by endpoint name", () => {
    expect(authSectionSchema.parse({ tokens: { myend: token } })).toEqual({ tokens: { myend: token } });
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
  });

  test("auth is never a merge candidate and survives provider writes", () => {
    const file = tmpFile();
    saveTokens(file, "claude", token);
    upsertUserEndpoint(file, { name: "claude", type: "anthropic", auth: { kind: "subscription" } });
    // merged config carries no token material anywhere (auth never merges)
    const home = mkdtempSync(join(tmpdir(), "moh-auth-home-"));
    updateUserConfigFile(join(home, ".moh", "config"), (d) => {
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

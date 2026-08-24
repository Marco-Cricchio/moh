import { describe, expect, test } from "bun:test";
import {
  COPILOT_CLIENT_ID,
  COPILOT_DEFAULT_BASE_URL,
  COPILOT_EDITOR_HEADERS,
  CopilotLoginAborted,
  copilotAuthContext,
  copilotBaseUrl,
  copilotBaseUrlFromToken,
  exchangeCopilotToken,
  loginGitHubCopilot,
  normalizeGithubDomain,
  refreshCopilotToken,
  type CopilotEndpointFetch,
} from "../src/auth/github-copilot";
import { isSubscriptionKind } from "../src/auth/lifecycle";
import { resolveEndpointCredential } from "../src/auth/resolve";
import { saveTokens } from "../src/auth/store";
import { Endpoint } from "../src/route";
import type { AuthorizationIo } from "../src/auth/oauth";
import type { DeviceFlowClock } from "../src/auth/device-code";
import type { AuthToken } from "../src/auth/types";

const NOW = 1_700_000_000_000;
const fastClock: DeviceFlowClock = { now: () => NOW, sleep: async () => {} };

/** A pi-format copilot token with a proxy-ep. */
const COPILOT_TOKEN = "tid=1;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;sku=individual";

function scriptedEndpoint(
  results: Array<{ status: number; json: Record<string, unknown> }>,
): CopilotEndpointFetch & { calls: { url: string; init: { method?: string; body?: Record<string, string>; headers?: Record<string, string> } }[] } {
  const calls: { url: string; init: { method?: string; body?: Record<string, string>; headers?: Record<string, string> } }[] = [];
  let i = 0;
  const fn: CopilotEndpointFetch = async (url, init) => {
    calls.push({ url, init });
    return results[i++] ?? { status: 500, json: {} };
  };
  return Object.assign(fn, { calls });
}

const DEVICE = {
  status: 200,
  json: {
    device_code: "dc-1",
    user_code: "ABCD-1234",
    verification_uri: "https://github.com/login/device",
    interval: 5,
    expires_in: 900,
  },
};

const COP_TOKEN_RESPONSE = {
  status: 200,
  json: { token: COPILOT_TOKEN, expires_at: Math.floor(NOW / 1000) + 1800 },
};

describe("copilot constants + helpers", () => {
  test("client_id and editor headers match pi's captured values", () => {
    expect(COPILOT_CLIENT_ID).toBe("Iv1.b507a08c87ecfe98");
    expect(COPILOT_EDITOR_HEADERS["User-Agent"]).toBe("GitHubCopilotChat/0.35.0");
    expect(COPILOT_EDITOR_HEADERS["Editor-Version"]).toBe("vscode/1.107.0");
    expect(COPILOT_EDITOR_HEADERS["Copilot-Integration-Id"]).toBe("vscode-chat");
    expect(COPILOT_DEFAULT_BASE_URL).toBe("https://api.individual.githubcopilot.com");
  });

  test("proxy-ep parses to the api base URL; proxy. -> api.", () => {
    expect(copilotBaseUrlFromToken(COPILOT_TOKEN)).toBe("https://api.individual.githubcopilot.com");
    expect(copilotBaseUrl("no-proxy-ep-here", undefined)).toBe(COPILOT_DEFAULT_BASE_URL);
    expect(copilotBaseUrl(undefined, "company.ghe.com")).toBe("https://copilot-api.company.ghe.com");
    expect(copilotBaseUrl(COPILOT_TOKEN, "company.ghe.com")).toBe("https://api.individual.githubcopilot.com");
  });

  test("domain normalization accepts bare hosts and URLs", () => {
    expect(normalizeGithubDomain("company.ghe.com")).toBe("company.ghe.com");
    expect(normalizeGithubDomain("https://company.ghe.com/")).toBe("company.ghe.com");
    expect(normalizeGithubDomain("  ")).toBeNull();
    expect(normalizeGithubDomain("not a domain")).toBeNull();
  });
});

describe("exchangeCopilotToken", () => {
  test("GET with the GitHub bearer + editor headers; token stored skewed 5 minutes early", async () => {
    const fetchImpl = scriptedEndpoint([COP_TOKEN_RESPONSE]);
    const token = await exchangeCopilotToken("ghu_github", undefined, fetchImpl, NOW);
    expect(token.accessToken).toBe(COPILOT_TOKEN);
    expect(token.refreshToken).toBe("ghu_github");
    expect(token.expiresAt).toBe((Math.floor(NOW / 1000) + 1800) * 1000 - 5 * 60 * 1000);
    expect(token.grant).toEqual({ provider: "github-copilot" });
    expect(fetchImpl.calls[0]!.url).toBe("https://api.github.com/copilot_internal/v2/token");
    expect(fetchImpl.calls[0]!.init.method).toBe("GET");
    expect(fetchImpl.calls[0]!.init.headers?.authorization).toBe("Bearer ghu_github");
    expect(fetchImpl.calls[0]!.init.headers?.["Copilot-Integration-Id"]).toBe("vscode-chat");
  });

  test("enterprise domain is recorded in the grant and used for the exchange URL", async () => {
    const fetchImpl = scriptedEndpoint([COP_TOKEN_RESPONSE]);
    const token = await exchangeCopilotToken("ghu_ent", "company.ghe.com", fetchImpl, NOW);
    expect(token.grant).toEqual({ provider: "github-copilot", domain: "company.ghe.com" });
    expect(fetchImpl.calls[0]!.url).toBe("https://api.company.ghe.com/copilot_internal/v2/token");
  });

  test("failed exchange throws with status", async () => {
    const fetchImpl = scriptedEndpoint([{ status: 403, json: {} }]);
    await expect(exchangeCopilotToken("ghu", undefined, fetchImpl, NOW)).rejects.toThrow("HTTP 403");
  });
});

describe("loginGitHubCopilot", () => {
  test("declining the ToS aborts before any prompt or network I/O", async () => {
    const io: AuthorizationIo = { ask: async () => "n", info: async () => {} };
    await expect(loginGitHubCopilot(io, { clock: fastClock })).rejects.toBeInstanceOf(CopilotLoginAborted);
  });

  test("device flow + two-hop exchange (github.com default)", async () => {
    const answers = ["y", ""]; // ToS acknowledged, blank domain (github.com)
    const io: AuthorizationIo = { ask: async () => answers.shift() ?? "", info: async () => {} };
    const fetchImpl = scriptedEndpoint([
      DEVICE,
      { status: 200, json: { access_token: "ghu_github" } },
      COP_TOKEN_RESPONSE,
    ]);
    const token = await loginGitHubCopilot(io, { fetchImpl, now: NOW, clock: fastClock });
    expect(token.accessToken).toBe(COPILOT_TOKEN);
    expect(token.refreshToken).toBe("ghu_github");
    expect(fetchImpl.calls[0]!.url).toBe("https://github.com/login/device/code");
    expect(fetchImpl.calls[0]!.init.body).toEqual({ client_id: COPILOT_CLIENT_ID, scope: "read:user" });
    expect(fetchImpl.calls[1]!.init.body!.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
  });

  test("pending then token; invalid enterprise input aborts", async () => {
    const answers = ["y", "https://company.ghe.com"]; // ToS acknowledged, enterprise domain
    const io: AuthorizationIo = { ask: async () => answers.shift() ?? "", info: async () => {} };
    const fetchImpl = scriptedEndpoint([
      { ...DEVICE, json: { ...DEVICE.json, verification_uri: "https://github.company.ghe.com/login/device" } },
      { status: 400, json: { error: "authorization_pending" } },
      { status: 200, json: { access_token: "ghu_ent" } },
      COP_TOKEN_RESPONSE,
    ]);
    const token = await loginGitHubCopilot(io, { fetchImpl, now: NOW, clock: fastClock });
    expect(token.grant).toEqual({ provider: "github-copilot", domain: "company.ghe.com" });

    const badAnswers = ["y", "not a domain!!"];
    const badIo: AuthorizationIo = { ask: async () => badAnswers.shift() ?? "", info: async () => {} };
    await expect(loginGitHubCopilot(badIo, { clock: fastClock })).rejects.toThrow("Invalid GitHub Enterprise");
  });
});

describe("refreshCopilotToken + auth context", () => {
  const stored: AuthToken = {
    accessToken: "old-copilot",
    refreshToken: "ghu_github",
    expiresAt: NOW - 1,
    grant: { provider: "github-copilot" },
    updatedAt: NOW,
  };

  test("refresh re-runs the exchange with the stored GitHub token", async () => {
    const fetchImpl = scriptedEndpoint([COP_TOKEN_RESPONSE]);
    const fresh = await refreshCopilotToken(stored, { fetchImpl, now: NOW });
    expect(fresh.accessToken).toBe(COPILOT_TOKEN);
    expect(fresh.refreshToken).toBe("ghu_github");
  });

  test("auth context derives the transport: credential + proxy base + editor headers", () => {
    const ctx = copilotAuthContext(stored);
    expect(ctx.credential).toBe("old-copilot");
    expect(ctx.baseUrl).toBe("https://api.individual.githubcopilot.com");
    expect(ctx.headers).toEqual({ ...COPILOT_EDITOR_HEADERS });
  });

  test("missing GitHub token surfaces the re-login hint", async () => {
    await expect(refreshCopilotToken({ ...stored, refreshToken: undefined })).rejects.toThrow("moh provider login");
  });
});

describe("resolve integration", () => {
  test("github-copilot is a subscription kind", () => {
    expect(isSubscriptionKind("github-copilot")).toBe(true);
  });

  test("far-future token resolves to the copilot auth context, no refresh", async () => {
    const authFile = `/tmp/moh-test-copilot-far-${process.pid}.json`;
    await Bun.write(authFile, "{}");
    const endpoint = new Endpoint({ name: "copilot", kind: "github-copilot", auth: { kind: "subscription" } });
    saveTokens(authFile, "copilot", {
      accessToken: COPILOT_TOKEN,
      refreshToken: "ghu_github",
      expiresAt: NOW + 3600_000,
      grant: { provider: "github-copilot" },
      updatedAt: NOW,
    });
    const resolved = await resolveEndpointCredential({ endpoint, modelId: "claude-opus-4.6" }, { configFile: authFile, now: NOW });
    expect(typeof resolved).toBe("object");
    const ctx = resolved as { credential: string; baseUrl?: string; headers?: Record<string, string> };
    expect(ctx.credential).toBe(COPILOT_TOKEN);
    expect(ctx.baseUrl).toBe("https://api.individual.githubcopilot.com");
    expect(ctx.headers?.["Copilot-Integration-Id"]).toBe("vscode-chat");
  });
});

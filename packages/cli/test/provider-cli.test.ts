import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthToken, ConnectionTester, EndpointProfile, OnboardingIo } from "@moh/core";
import { providerCommand, PROVIDER_USAGE } from "../src/provider";
import type { SubscriptionLogin } from "@moh/core";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "moh-provider-cli-"));
  dirs.push(d);
  return d;
}

function fakeHome(): string {
  const dir = tmp();
  mkdirSync(join(dir, ".moh"), { recursive: true });
  writeFileSync(join(dir, ".moh", "config"), "{}");
  return dir;
}

async function run(
  argv: string[],
  opts: {
    cwd: string;
    home: string;
    io?: OnboardingIo;
    loginImpl?: SubscriptionLogin;
    tester?: ConnectionTester;
    subscriptionLogin?: Parameters<typeof providerCommand>[0]["subscriptionLogin"];
  },
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await providerCommand({
    argv,
    cwd: opts.cwd,
    home: opts.home,
    io: opts.io,
    loginImpl: opts.loginImpl,
    tester: opts.tester,
    subscriptionLogin: opts.subscriptionLogin,
    stdout: { write: (s: string) => out.push(s) } as unknown as NodeJS.WritableStream,
    stderr: { write: (s: string) => err.push(s) } as unknown as NodeJS.WritableStream,
  });
  return { code, out: out.join(""), err: err.join("") };
}

/** Scripted wizard IO: subscription login always "succeeds" with a fake token. */
function wizardIo(answers: string[], token: AuthToken): OnboardingIo & { said: string[] } {
  const said: string[] = [];
  let i = 0;
  return {
    ask: async (prompt: string) => {
      said.push(prompt);
      return answers[i++] ?? "";
    },
    info: async (line: string) => {
      said.push(line);
    },
    openUrl: async () => false,
    said,
  };
}

describe("moh provider", () => {
  test("no/unknown subcommand prints usage", async () => {
    const home = fakeHome();
    expect((await run([], { cwd: tmp(), home })).code).toBe(2);
    const r = await run(["frobnicate"], { cwd: tmp(), home });
    expect(r.code).toBe(2);
    expect(r.err).toContain(PROVIDER_USAGE);
  });

  test("add (subscription branch) saves the profile and stores tokens in ~/.moh/config", async () => {
    const cwd = tmp();
    const home = fakeHome();
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
    const token: AuthToken = {
      accessToken: "acc-xyz",
      refreshToken: "ref-xyz",
      expiresAt: 1_800_000_000_000,
      account: { email: "dev@example.test" },
      updatedAt: 1_700_000_000_000,
    };
    const io = wizardIo(["anthropic", "", "subscription", "claude-sonnet-4-5"], token);
    const r = await run(["add"], { cwd, home, io, subscriptionLogin: async () => token, tester: async () => ({ ok: true, modelId: "claude-sonnet-4-5" }) });
    expect(r.code).toBe(0);
    const moh = JSON.parse(readFileSync(join(cwd, "moh.json"), "utf8"));
    expect(moh.endpoints[0].auth).toEqual({ kind: "subscription" });
    expect(moh.provider).toBe("anthropic/claude-sonnet-4-5");
    const user = JSON.parse(readFileSync(join(home, ".moh", "config"), "utf8"));
    expect(user.auth.tokens.anthropic.accessToken).toBe("acc-xyz");
    // redaction: the success output never echoes token material
    expect(r.out).not.toContain("acc-xyz");
    expect(r.out).not.toContain("ref-xyz");
  });

  test("login <name> re-auths a known subscription endpoint; redacted output", async () => {
    const cwd = tmp();
    const home = fakeHome();
    writeFileSync(
      join(cwd, "moh.json"),
      JSON.stringify({
        provider: "anthropic/claude-sonnet-4-5",
        endpoints: [{ name: "anthropic", type: "anthropic", defaultModel: "claude-sonnet-4-5", auth: { kind: "subscription" } }],
      }),
    );
    const token2: AuthToken = {
      accessToken: "acc-new",
      account: { email: "dev@example.test" },
      updatedAt: 1_700_000_000_000,
    };
    const io = wizardIo(["y"], token2);
    const r = await run(["login", "anthropic"], {
      cwd,
      home,
      io,
      loginImpl: async () => token2,
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("dev@example.test");
    expect(r.out).not.toContain("acc-new");
    const user = JSON.parse(readFileSync(join(home, ".moh", "config"), "utf8"));
    expect(user.auth.tokens.anthropic.accessToken).toBe("acc-new");
  });

  test("login <unknown> fails with exit 1", async () => {
    const home = fakeHome();
    const cwd = tmp();
    const r = await run(["login", "nope"], { cwd, home, io: wizardIo([], {} as AuthToken) });
    expect(r.code).toBe(1);
    expect(r.err).toContain("nope");
  });

  test("logout <name> drops tokens; unknown endpoint reports cleanly", async () => {
    const cwd = tmp();
    const home = fakeHome();
    writeFileSync(join(home, ".moh", "config"), JSON.stringify({ auth: { tokens: { anthropic: { accessToken: "a", updatedAt: 1 } } } }));
    const r = await run(["logout", "anthropic"], { cwd, home });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, ".moh", "config"), "utf8")).auth.tokens).toEqual({});
    const r2 = await run(["logout", "anthropic"], { cwd, home });
    expect(r2.code).toBe(0);
    expect(r2.out).toContain("No stored tokens");
  });

  test("status lists endpoints with auth kind and token state; redacts secrets", async () => {
    const cwd = tmp();
    const home = fakeHome();
    const eps: EndpointProfile[] = [
      { name: "anthropic", type: "anthropic", defaultModel: "claude-sonnet-4-5", auth: { kind: "subscription" } },
      { name: "ollama", type: "openai-compat", baseUrl: "http://localhost:11434/v1", defaultModel: "qwen3" },
    ];
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock", endpoints: eps }));
    writeFileSync(
      join(home, ".moh", "config"),
      JSON.stringify({
        auth: {
          tokens: {
            anthropic: {
              accessToken: "acc-xyz",
              expiresAt: 1_800_000_000_000,
              account: { email: "dev@example.test" },
              updatedAt: 1,
            },
          },
        },
      }),
    );
    const r = await run(["status"], { cwd, home });
    expect(r.code).toBe(0);
    expect(r.out).toContain("anthropic");
    expect(r.out).toContain("subscription");
    expect(r.out).toContain("dev@example.test");
    expect(r.out).toContain("api-key");
    expect(r.out).not.toContain("acc-xyz");
  });
});

import { afterAll } from "bun:test";
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("moh provider fallback (ADR-0012 preferred model)", () => {
  test("sets the preferred model on a user-level endpoint and prints the chain verdict", async () => {
    const home = fakeHome();
    const cwd = tmp();
    writeFileSync(
      join(home, ".moh", "config"),
      JSON.stringify({ endpoints: [{ name: "zai", type: "zai", defaultModel: "glm-5.3-flash" }] }),
    );
    const r = await run(["fallback", "zai", "glm-5.4"], { cwd, home });
    expect(r.code).toBe(0);
    expect(r.out).toContain("fallback: zai → glm-5.4");
    expect(r.out).toContain("applies from the next session");
    const raw = JSON.parse(readFileSync(join(home, ".moh", "config"), "utf8"));
    expect(raw.endpoints[0].defaultModel).toBe("glm-5.4");
  });

  test("--clear drops the endpoint from the chain by removing the field", async () => {
    const home = fakeHome();
    const cwd = tmp();
    writeFileSync(
      join(home, ".moh", "config"),
      JSON.stringify({ endpoints: [{ name: "zai", type: "zai", defaultModel: "glm-5.3-flash", apiKey: "k" }] }),
    );
    const r = await run(["fallback", "zai", "--clear"], { cwd, home });
    expect(r.code).toBe(0);
    expect(r.out).toContain("removed from the chain");
    const endpoint = JSON.parse(readFileSync(join(home, ".moh", "config"), "utf8")).endpoints[0];
    expect("defaultModel" in endpoint).toBe(false);
    expect(endpoint.apiKey).toBe("k");
  });

  test("a project-declared endpoint is edited in moh.json, and never switches the active provider", async () => {
    const home = fakeHome();
    const cwd = tmp();
    writeFileSync(
      join(cwd, "moh.json"),
      JSON.stringify({
        provider: "anthropic/claude-sonnet-4-5",
        endpoints: [{ name: "openai", type: "openai", defaultModel: "gpt-5" }],
      }),
    );
    const r = await run(["fallback", "openai", "gpt-5.4"], { cwd, home });
    expect(r.code).toBe(0);
    const project = JSON.parse(readFileSync(join(cwd, "moh.json"), "utf8"));
    expect(project.endpoints[0].defaultModel).toBe("gpt-5.4");
    // The whole point: the active provider ref does not move.
    expect(project.provider).toBe("anthropic/claude-sonnet-4-5");
  });

  test("an unknown endpoint is a named error, not a silent write", async () => {
    const home = fakeHome();
    const cwd = tmp();
    const r = await run(["fallback", "ghost", "m"], { cwd, home });
    expect(r.code).toBe(1);
    expect(r.err).toContain('no endpoint "ghost"');
  });

  test("a model that still cannot be a stop says why", async () => {
    const home = fakeHome();
    const cwd = tmp();
    writeFileSync(
      join(home, ".moh", "config"),
      JSON.stringify({ endpoints: [{ name: "zai", type: "zai", fallbackEligible: false }] }),
    );
    const r = await run(["fallback", "zai", "glm-5.4"], { cwd, home });
    expect(r.code).toBe(0);
    expect(r.out).toContain("still not a fallback stop: excluded from the chain");
  });

  test("--exclude keeps the whole provider out of the chain while its model stays", async () => {
    const home = fakeHome();
    const cwd = tmp();
    writeFileSync(
      join(home, ".moh", "config"),
      JSON.stringify({ endpoints: [{ name: "zai", type: "zai", defaultModel: "glm-5.3-flash" }] }),
    );
    const r = await run(["fallback", "zai", "--exclude"], { cwd, home });
    expect(r.code).toBe(0);
    expect(r.out).toContain("fallback: zai excluded from the chain");
    const endpoint = JSON.parse(readFileSync(join(home, ".moh", "config"), "utf8")).endpoints[0];
    expect(endpoint.fallbackEligible).toBe(false);
    // Excluding is orthogonal to the model: it stays.
    expect(endpoint.defaultModel).toBe("glm-5.3-flash");
    // …and status reports the endpoint as excluded.
    const st = await run(["status"], { cwd, home });
    expect(st.out).toContain("(excluded from the chain)");
  });

  test("--include puts the provider back by removing the flag", async () => {
    const home = fakeHome();
    const cwd = tmp();
    writeFileSync(
      join(home, ".moh", "config"),
      JSON.stringify({ endpoints: [{ name: "zai", type: "zai", defaultModel: "m", fallbackEligible: false }] }),
    );
    const r = await run(["fallback", "zai", "--include"], { cwd, home });
    expect(r.code).toBe(0);
    expect(r.out).toContain("back in the chain");
    expect("fallbackEligible" in JSON.parse(readFileSync(join(home, ".moh", "config"), "utf8")).endpoints[0]).toBe(false);
  });

  test("--exclude and --include together are refused", async () => {
    const home = fakeHome();
    const cwd = tmp();
    const r = await run(["fallback", "zai", "--exclude", "--include"], { cwd, home });
    expect(r.code).toBe(2);
    expect(r.err).toContain("not both");
  });

  test("status prints each endpoint's preferred model", async () => {
    const home = fakeHome();
    const cwd = tmp();
    writeFileSync(
      join(home, ".moh", "config"),
      JSON.stringify({
        endpoints: [
          { name: "zai", type: "zai", defaultModel: "glm-5.3-flash", apiKey: "k" },
          { name: "bare", type: "anthropic", apiKey: "k" },
        ],
      }),
    );
    const r = await run(["status"], { cwd, home });
    expect(r.code).toBe(0);
    expect(r.out).toContain("fallback: 📌 glm-5.3-flash");
    expect(r.out).toContain("fallback: —");
    expect(r.out).toContain("(no preferred model set)");
  });
});

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
    const io = wizardIo(["anthropic", "", "subscription", "", "claude-sonnet-4-5"], token);
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

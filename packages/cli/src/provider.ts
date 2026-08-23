/**
 * `moh provider` (issue #138, spec docs/spec/oauth-subscription-auth.md):
 * - `add`     guided onboarding; asks `api-key | subscription` first for
 *             providers with a grant (ToS warning first, headless-safe)
 * - `login`   re-auth a subscription endpoint
 * - `logout`  drop its tokens (the only deleter besides re-login)
 * - `status`  per-endpoint auth kind, token expiry, best-effort usage
 *
 * Output is redacted: token and key material is never echoed.
 */
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import {
  addProviderToFile,
  loadMergedConfig,
  providerLogin,
  providerLogout,
  providerStatus,
  type OnboardingIo,
} from "@moh/core";
import { userConfigFile } from "@moh/core";

export const PROVIDER_USAGE = `usage: moh provider <command>

commands:
  add              guided provider onboarding (asks api-key or subscription
                   auth first; subscription runs the provider's OAuth flow)
  login <name>     re-authenticate a subscription endpoint
  logout <name>    drop a subscription endpoint's stored tokens
  status           per-endpoint auth kind, token expiry, plan usage

tokens live in ~/.moh/config (never in moh.json); \`logout\` and a
successful \`login\` are the only token deleters.`;

export interface ProviderCommandOptions {
  argv: string[];
  cwd: string;
  home?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** I/O seam (tests). Default: stdin/stdout readline + best-effort browser. */
  io?: OnboardingIo;
  /** Wizard subscription-grant seam (tests), for `add`. */
  subscriptionLogin?: NonNullable<Parameters<typeof addProviderToFile>[2]>["subscriptionLogin"];
  /** Connection-test seam (tests), for `add`. */
  tester?: NonNullable<Parameters<typeof addProviderToFile>[2]>["tester"];
  /** Login seam (tests): overrides the real subscription grant in `login`. */
  loginImpl?: NonNullable<Parameters<typeof providerLogin>[2]>["loginImpl"];
}

const out = (opts: ProviderCommandOptions): NodeJS.WritableStream => opts.stdout ?? process.stdout;
const errOut = (opts: ProviderCommandOptions): NodeJS.WritableStream => opts.stderr ?? process.stderr;

/** Best-effort browser open: never throws; returns false headless/unknown OS. */
async function openUrl(url: string): Promise<boolean> {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => resolve(true));
    } catch {
      resolve(false);
    }
  });
}

/** Real terminal I/O (the CLI wiring of the OnboardingIo seam). */
async function terminalIo(opts: ProviderCommandOptions): Promise<OnboardingIo> {
  if (opts.io) return opts.io;
  const rl = createInterface({ input: process.stdin, output: out(opts) });
  return {
    ask: (prompt: string) => rl.question(prompt),
    info: async (line: string) => {
      out(opts).write(`${line}\n`);
    },
    openUrl,
  };
}

function formatExpiry(expiresAt: number | undefined, now = Date.now()): string {
  if (expiresAt === undefined) return "no expiry recorded";
  const delta = expiresAt - now;
  if (delta <= 0) return `expired ${Math.round(-delta / 60000)} min ago`;
  return `expires in ${Math.round(delta / 3600000)} h`;
}

export async function providerCommand(opts: ProviderCommandOptions): Promise<number> {
  const [cmd, ...rest] = opts.argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    (cmd ? out(opts) : errOut(opts)).write(`${PROVIDER_USAGE}\n`);
    return cmd ? 0 : 2;
  }
  const authFile = userConfigFile(opts.home);

  if (cmd === "add") {
    if (rest.length) {
      errOut(opts).write(`moh provider add takes no arguments\n`);
      return 2;
    }
    const io = await terminalIo(opts);
    try {
      await addProviderToFile(io, join(opts.cwd, "moh.json"), {
        authFile,
        ...(opts.subscriptionLogin ? { subscriptionLogin: opts.subscriptionLogin } : {}),
        ...(opts.tester ? { tester: opts.tester } : {}),
      });
      return 0;
    } catch (err) {
      errOut(opts).write(`${(err as Error).message}\n`);
      return 1;
    }
  }

  if (cmd === "login" || cmd === "logout") {
    const [name] = rest;
    if (!name) {
      errOut(opts).write(`moh provider ${cmd} <name>\n`);
      return 2;
    }
    if (cmd === "logout") {
      const had = providerLogout(name, { authFile });
      out(opts).write(had ? `Dropped tokens for "${name}".\n` : `No stored tokens for "${name}".\n`);
      return 0;
    }
    const endpoints = loadMergedConfig(opts.cwd, opts.home !== undefined ? { home: opts.home } : {}).endpoints ?? [];
    const endpoint = endpoints.find((e) => e.name === name);
    if (!endpoint) {
      errOut(opts).write(`moh: no endpoint named "${name}" (configured: ${endpoints.map((e) => e.name).join(", ") || "none"})\n`);
      return 1;
    }
    const io = await terminalIo(opts);
    try {
      const token = await providerLogin(endpoint, io, { authFile, ...(opts.loginImpl ? { loginImpl: opts.loginImpl } : {}) });
      const who = token.account?.email ?? token.account?.name ?? "unknown account";
      out(opts).write(`Logged in to "${name}" (${who}).\n`);
      return 0;
    } catch (err) {
      errOut(opts).write(`${(err as Error).message}\n`);
      return 1;
    }
  }

  if (cmd === "status") {
    if (rest.length) {
      errOut(opts).write(`moh provider status takes no arguments\n`);
      return 2;
    }
    const endpoints = loadMergedConfig(opts.cwd, opts.home !== undefined ? { home: opts.home } : {}).endpoints ?? [];
    const rows = await providerStatus(endpoints, { authFile });
    for (const row of rows) {
      const parts = [row.name, row.type, row.authKind];
      if (row.authKind === "api-key") parts.push(`key: ${row.apiKeySource}`);
      if (row.subscription) {
        if (!row.subscription.loggedIn) parts.push("not logged in (run `moh provider login`)");
        else {
          parts.push(formatExpiry(row.subscription.expiresAt));
          if (row.subscription.account) parts.push(row.subscription.account);
          if (row.subscription.plan) parts.push(`plan: ${row.subscription.plan}`);
        }
      }
      out(opts).write(`${parts.join("  |  ")}\n`);
      if (row.subscription?.usage) out(opts).write(`  ${row.subscription.usage}\n`);
    }
    if (!rows.length) out(opts).write(`no endpoints configured (run \`moh provider add\`)\n`);
    return 0;
  }

  errOut(opts).write(`moh: unknown provider command "${cmd}"\n\n${PROVIDER_USAGE}\n`);
  return 2;
}

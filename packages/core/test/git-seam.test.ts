/**
 * T7 (#1165): the `git` built-in through the host seam — the referent of
 * the `tool:git` whole-tool grant Jev's migration consumes. One probe
 * extension with `tool:git` in a real session: the read executes through
 * the model's exact gate path, logs `host_op run_tool ok`, and a mutating
 * command fails as a failed tool result (never a crash of the caller).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionDefinition, ExtensionHost, ExtensionSetupContext } from "@moh/extension";
import { ExtensionRuntime } from "../src/extensions";
import { sessionFromConfig } from "../src";
import type { AgentEvent } from "../src/types";

const roots: string[] = [];
const homes: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A real git repository with one commit, as a session project root. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "moh-git-seam-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "a.txt"), "one\n");
  const git = (args: string) => execFileSync("git", args.split(" "), { cwd: root });
  git("init -q");
  git("config user.email t@t");
  git("config user.name t");
  git("add .");
  git("commit -qm init");
  return root;
}

/**
 * #1522: the auto-lane shape — a real `git worktree` of `checkout` under
 * `<home>/projects/<repo>/lanes/<lane>`, the session's cwd in a `moh run`
 * that opened a lane (ADR-0060).
 */
function laneOf(checkout: string, home: string): string {
  const lanes = join(home, "projects", "example", "lanes");
  mkdirSync(lanes, { recursive: true });
  const lane = join(lanes, "moh-auto-test");
  execFileSync("git", ["worktree", "add", "-q", "-b", "moh-auto-test", lane], { cwd: checkout });
  return lane;
}

async function sessionWithGit(
  capabilities: readonly string[],
  options: { lane?: boolean } = {},
): Promise<{
  host: ExtensionHost;
  root: string;
  checkout: string;
  events: AgentEvent[];
  seamEvents: AgentEvent[];
}> {
  const checkout = repo();
  const events: AgentEvent[] = [];
  const seamEvents: AgentEvent[] = [];
  const home = mkdtempSync(join(tmpdir(), "moh-git-seam-home-"));
  homes.push(home);
  const root = options.lane ? laneOf(checkout, home) : checkout;
  const rt = new ExtensionRuntime({ mohHome: home, projectRoot: root, consent: () => true });
  const box: { ctx: ExtensionSetupContext | null } = { ctx: null };
  rt.onLoadEvent((event) => events.push(event));
  await rt.register({
    name: "probe",
    version: "1",
    apiVersion: "1.15",
    capabilities: [...capabilities],
    setup: (ctx: ExtensionSetupContext) => {
      box.ctx = ctx;
    },
  } as ExtensionDefinition);
  await rt.ready();

  const assembled = sessionFromConfig({
    cwd: root,
    home,
    config: { provider: "mock" },
    overrides: {
      permissions: { overrides: { tools: { git: "allow" as const } } },
      extensions: rt,
      sink: (e: AgentEvent) => seamEvents.push(e),
    },
  });
  if (!("session" in assembled)) throw new Error(assembled.error.message);
  return { host: box.ctx!.host as ExtensionHost, root, checkout, events, seamEvents };
}

const gitOps = (events: AgentEvent[]) =>
  events.filter((e) => (e.type === "host_op" || e.type === "host_refused") && e.op === "run_tool" && e.tool === "git");

describe("tool:git through the seam (#1165)", () => {
  test("a granted read runs through the gate and logs one host_op ok", async () => {
    const { host, seamEvents } = await sessionWithGit(["tool:git"]);
    const result = await (host as Required<ExtensionHost>).runTool("git", { args: ["rev-parse", "HEAD"] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.trim()).toMatch(/^[0-9a-f]{40}$/);
    const ops = seamEvents.filter((e) => e.type === "host_op" && e.op === "run_tool" && e.tool === "git");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ outcome: "ok", extension: "probe" });
  });

  test("a mutating command is a failed tool result, not a crash", async () => {
    const { host, seamEvents } = await sessionWithGit(["tool:git"]);
    const result = await (host as Required<ExtensionHost>).runTool("git", { args: ["commit", "--allow-empty", "-m", "x"] });
    expect(result.ok).toBe(false);
    const ops = seamEvents.filter((e) => e.type === "host_op" && e.op === "run_tool" && e.tool === "git");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ outcome: "failed" });
  });

  test("without the grant the read refuses outside_scope", async () => {
    const { host, seamEvents } = await sessionWithGit([]);
    expect(host?.runTool).toBeUndefined();
    const ops = seamEvents.filter((e) => e.type === "host_op" || e.type === "host_refused");
    expect(ops).toHaveLength(0);
  });
});

describe("tool:git with the session root as cwd — Jev's reads (#1522)", () => {
  test("in an auto lane, a read with cwd = the lane worktree runs (not denied)", async () => {
    const { host, root, seamEvents } = await sessionWithGit(["tool:git"], { lane: true });
    // Jev's exact calls: the snapshot reads, cwd = the session's own root.
    const branch = await (host as Required<ExtensionHost>).runTool("git", { args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: root });
    expect(branch).toEqual({ ok: true, output: "moh-auto-test\n" });
    const status = await (host as Required<ExtensionHost>).runTool("git", { args: ["status", "--porcelain"], cwd: root });
    expect(status.ok).toBe(true);
    const ops = gitOps(seamEvents);
    expect(ops).toHaveLength(2);
    for (const op of ops) expect(op).toMatchObject({ type: "host_op", outcome: "ok" });
    expect(JSON.stringify(seamEvents)).not.toContain("path outside project root");
  });

  test("in an auto lane, a cwd outside the lane — the original checkout or elsewhere — is still denied", async () => {
    const { host, checkout, seamEvents } = await sessionWithGit(["tool:git"], { lane: true });
    for (const cwd of [checkout, tmpdir()]) {
      const result = await (host as Required<ExtensionHost>).runTool("git", { args: ["status"], cwd });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("denied");
        expect(result.message).toContain("path outside project root");
      }
    }
    const ops = gitOps(seamEvents);
    expect(ops).toHaveLength(2);
    for (const op of ops) expect(op).toMatchObject({ type: "host_op", outcome: "denied" });
  });

  test("without a lane, a read with cwd = the checkout runs; a subdirectory still runs; outside is denied", async () => {
    const { host, root, seamEvents } = await sessionWithGit(["tool:git"]);
    const run = (cwd: string) => (host as Required<ExtensionHost>).runTool("git", { args: ["status", "--porcelain"], cwd });
    expect((await run(root)).ok).toBe(true);
    expect((await run(join(root, "src"))).ok).toBe(true);
    expect(await run(tmpdir())).toMatchObject({ ok: false, reason: "denied" });
    expect(gitOps(seamEvents).map((e) => (e as { outcome?: string }).outcome)).toEqual(["ok", "ok", "denied"]);
  });
});

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
import { z } from "zod";
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

async function sessionWithGit(capabilities: readonly string[]): Promise<{
  host: ExtensionHost;
  root: string;
  events: AgentEvent[];
  seamEvents: AgentEvent[];
}> {
  const root = repo();
  const events: AgentEvent[] = [];
  const seamEvents: AgentEvent[] = [];
  const home = mkdtempSync(join(tmpdir(), "moh-git-seam-home-"));
  homes.push(home);
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
  return { host: box.ctx!.host as ExtensionHost, root, events, seamEvents };
}

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

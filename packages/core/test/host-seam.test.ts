/**
 * Issue #1159 — F1 (ADR-0064 + ADR-0065): the host-tool seam and the
 * `path:<glob>` scope, end to end. One seam tested at the high level:
 * a probe extension loaded through the runtime, `ctx.host` methods driven
 * directly, real files and real symlinks on a temp project root, events
 * asserted through the runtime's load-event channel.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
// existsSync kept: documents intent at the trueCaseRel walk boundary.
void existsSync;
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionDefinition, ExtensionHost, ExtensionSetupContext } from "@moh/extension";
import { ExtensionRuntime } from "../src/extensions";
import { scopeEffectSentence } from "../src/host-scope";
import type { AgentEvent } from "../src/types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "moh-host-seam-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  return root;
}

/** A runtime whose consent always grants, rooted at the temp project. */
function runtime(root: string): ExtensionRuntime {
  return new ExtensionRuntime({
    mohHome: mkdtempSync(join(tmpdir(), "moh-host-home-")),
    projectRoot: root,
    consent: () => true,
  });
}

/** Loads a probe extension and captures its setup context + the events. */
async function probe(root: string, capabilities: readonly string[], events: AgentEvent[]) {
  const rt = runtime(root);
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
  return box.ctx!;
}

describe("host-tool seam: ctx.host presence (enforcement by absence, ADR-0064)", () => {
  test("absent without a path scope; present with one", async () => {
    const events: AgentEvent[] = [];
    const plain = await probe(project(), [], events);
    expect(plain.host).toBeUndefined();

    const granted = await probe(project(), ["path:src/**"], events);
    expect(typeof granted.host).toBe("object");
  });
});

describe("path scope: the whole file family under the glob (ADR-0065)", () => {
  test("read, write, append, rename, delete inside src/**; each logs one host_op", async () => {
    const root = project();
    const events: AgentEvent[] = [];
    const host = (await probe(root, ["path:src/**"], events)).host as ExtensionHost;

    const read = await host.readFile("src/a.ts");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.content).toBe("export const a = 1;\n");

    const write = await host.writeFile("src/b.ts", "b");
    expect(write.ok).toBe(true);
    expect(readFileSync(join(root, "src", "b.ts"), "utf8")).toBe("b");
    if (write.ok) expect(write.bytes).toBe(1);

    const append = await host.appendFile("src/b.ts", "c");
    expect(append.ok).toBe(true);
    expect(readFileSync(join(root, "src", "b.ts"), "utf8")).toBe("bc");

    const rename = await host.rename("src/b.ts", "src/c.ts");
    expect(rename.ok).toBe(true);
    expect(existsSync(join(root, "src", "c.ts"))).toBe(true);

    const del = await host.delete("src/c.ts");
    expect(del.ok).toBe(true);
    expect(existsSync(join(root, "src", "c.ts"))).toBe(false);

    const ops = events.filter((e) => e.type === "host_op");
    expect(ops.map((e) => (e as { op: string }).op).sort()).toEqual(["append", "delete", "read", "rename", "write"]);
    // Every op names the extension and the resolved project-relative target.
    expect(ops.every((e) => (e as { extension: string }).extension === "probe")).toBe(true);
    expect(ops.some((e) => String((e as { path: string }).path).endsWith("/src/a.ts"))).toBe(true);
  });
});

describe("path scope: containment follows the real filesystem", () => {
  test("outside the glob: typed refusal + host_refused, never an exception", async () => {
    const root = project();
    writeFileSync(join(root, "secret.txt"), "s3cret");
    const events: AgentEvent[] = [];
    const host = (await probe(root, ["path:src/**"], events)).host as ExtensionHost;

    const result = await host.readFile("secret.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("outside_scope");

    const refusals = events.filter((e) => e.type === "host_refused");
    expect(refusals).toHaveLength(1);
    expect((refusals[0] as { reason: string }).reason).toBe("outside_scope");
    // Never an extension_failed: a refusal is a policy answer, not a fault.
    expect(events.some((e) => e.type === "extension_failed")).toBe(false);
  });

  test("a symlink inside the glob pointing outside resolves to the checked target and is refused", async () => {
    const root = project();
    writeFileSync(join(root, "outside.txt"), "x");
    symlinkSync(join(root, "outside.txt"), join(root, "src", "link.ts"));
    const events: AgentEvent[] = [];
    const host = (await probe(root, ["path:src/**"], events)).host as ExtensionHost;

    const result = await host.readFile("src/link.ts");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("outside_scope");
    // The log records the resolved target, never the requested path.
    const refusals = events.filter((e) => e.type === "host_refused");
    expect(String((refusals[0] as { resolved: string }).resolved).endsWith("/outside.txt")).toBe(true);
  });

  test("`..` segments are rejected before resolution", async () => {
    const events: AgentEvent[] = [];
    const host = (await probe(project(), ["path:src/**"], events)).host as ExtensionHost;
    const result = await host.readFile("src/../secret.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("outside_scope");
  });

  test("case follows the filesystem (APFS-insensitive: a mis-cased grant match still works)", async () => {
    const root = project();
    writeFileSync(join(root, "src", "MixedCase.ts"), "m");
    const events: AgentEvent[] = [];
    const host = (await probe(root, ["path:src/**"], events)).host as ExtensionHost;
    // On a case-insensitive FS the file opens; on a sensitive one it is a
    // miss — either way no crash and no grant escape.
    const result = await host.readFile("src/mixedcase.ts");
    if (result.ok) expect(result.content).toBe("m");
  });
});

describe("the user's deny rules beat the grant per call", () => {
  test("a deny on a covered path is a typed refusal, not the grant", async () => {
    const root = project();
    const rt = runtime(root);
    (rt as { bindPathDeny(f: (abs: string) => boolean): void }).bindPathDeny(
      (abs) => abs.endsWith("/src/a.ts"),
    );
    const events: AgentEvent[] = [];
    rt.onLoadEvent((event) => events.push(event));
    const box: { ctx: ExtensionSetupContext | null } = { ctx: null };
    await rt.register({
      name: "probe",
      version: "1",
      apiVersion: "1.13",
      capabilities: ["path:src/**"],
      setup: (ctx) => {
        box.ctx = ctx;
      },
    } as ExtensionDefinition);
    await rt.ready();
    const host = box.ctx!.host as ExtensionHost;

    const result = await host.readFile("src/a.ts");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("denied");
    const refusals = events.filter((e) => e.type === "host_refused");
    expect((refusals[0] as { reason: string }).reason).toBe("denied");
  });
});

describe("manifest validation and consent sentences", () => {
  test("an absolute path in a capability fails loudly at load", async () => {
    const root = project();
    const events: AgentEvent[] = [];
    const rt = runtime(root);
    rt.onLoadEvent((event) => events.push(event));
    const box: { ctx: ExtensionSetupContext | null } = { ctx: null };
    await rt.register({
      name: "probe",
      version: "1",
      apiVersion: "1.13",
      capabilities: ["path:/etc/passwd"],
      setup: (ctx) => {
        box.ctx = ctx;
      },
    } as ExtensionDefinition);
    await rt.ready();
    expect(box.ctx).toBeNull();
    const failed = events.find((e) => e.type === "extension_failed") as { reason: string; message: string };
    expect(failed.reason).toBe("invalid_path_scope");
    expect(failed.message).toContain("absolute");
  });

  test("the consent sentence names the family, not the naked string", () => {
    const sentence = scopeEffectSentence("path:src/**");
    expect(sentence).toContain("read and modify files under `src/**`");
    expect(sentence).toContain("rename");
    expect(scopeEffectSentence("veto")).toBeNull();
  });
});

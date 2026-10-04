/**
 * Issue #1159 — F1 (ADR-0064 + ADR-0065): the host-tool seam and the
 * `path:<glob>` scope, end to end. One seam tested at the high level:
 * a probe extension loaded through the runtime, `ctx.host` methods driven
 * directly, real files and real symlinks on a temp project root, events
 * asserted through the runtime's load-event channel.
 *
 * The case-matching regressions (issue #1160 follow-up) live here too:
 * a case-insensitive match folds the glob's literal letters without
 * rewriting its classes (`[!A-z]` keeps excluding `_`), and the FS case
 * answer is per path component so a sensitive ancestor (`SRC` vs `src`)
 * is never matched on an insensitive descendant's answer. The
 * mixed-filesystem shapes a plain temp directory cannot produce are
 * driven through the tests-only `matchesPathScopes` seam.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionDefinition, ExtensionHost, ExtensionSetupContext } from "@moh/extension";
import { ExtensionRuntime } from "../src/extensions";
import { scopeEffectSentence } from "../src/scope-effect";
import { foldGlobCase, matchesPathScopes } from "../src/host-scope";
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

  test("uppercase grant follows actual filesystem case behavior, including missing targets", async () => {
    const root = project();
    const insensitive = existsSync(join(root, "SRC", "A.TS"));
    const events: AgentEvent[] = [];
    const host = (await probe(root, ["path:SRC/**/*.TS"], events)).host as ExtensionHost;
    const read = await host.readFile("src/a.ts");
    expect(read.ok).toBe(insensitive);
    if (read.ok) expect(read.content).toContain("export const a");
    else expect(read.reason).toBe("outside_scope");
    const write = await host.writeFile("src/new/deep/b.ts", "new");
    expect(write.ok).toBe(insensitive);
    expect(existsSync(join(root, "src/new/deep/b.ts"))).toBe(insensitive);
    expect(events.filter((e) => e.type === "host_refused")).toHaveLength(insensitive ? 0 : 2);
  });

  test("lowercase grant covers differently cased requests only on insensitive filesystems", async () => {
    const root = project();
    const insensitive = existsSync(join(root, "SRC", "A.TS"));
    const host = (await probe(root, ["path:src/**/*.ts"], [])).host as ExtensionHost;
    const result = await host.writeFile("SRC/new/B.TS", "new");
    expect(result.ok).toBe(insensitive);
    if (!result.ok) expect(result.reason).toBe("outside_scope");
  });

  test("nonexistent targets beneath an escaping symlink remain outside scope", async () => {
    const root = project();
    const outside = project();
    symlinkSync(outside, join(root, "src", "escape"));
    const events: AgentEvent[] = [];
    const host = (await probe(root, ["path:src/**"], events)).host as ExtensionHost;
    expect(await host.writeFile("src/escape/missing/deep.ts", "no")).toMatchObject({ ok: false, reason: "outside_scope" });
    expect(existsSync(join(outside, "missing/deep.ts"))).toBe(false);
    expect(events.filter((e) => e.type === "host_refused")).toHaveLength(1);
  });
});

describe("path scope: case matching preserves glob syntax (regression)", () => {
  test("a case-insensitive match folds literal letters, never the classes: [!A-z] keeps excluding `_`", async () => {
    const root = project();
    writeFileSync(join(root, "_.txt"), "under");
    writeFileSync(join(root, "0.txt"), "zero");
    const events: AgentEvent[] = [];
    const host = (await probe(root, ["path:[!A-z].txt"], events)).host as ExtensionHost;

    // `_` sits inside the written range A–z, so the class excludes it on
    // every filesystem. The bug was lowering the pattern to `[!a-z]` — a
    // different set that admits `_` — and granting on an insensitive FS.
    expect(await host.readFile("_.txt")).toMatchObject({ ok: false, reason: "outside_scope" });
    // The class still grants what it does name: `0` is outside A–z.
    expect(await host.readFile("0.txt")).toMatchObject({ ok: true });
    expect(events.filter((e) => e.type === "host_refused")).toHaveLength(1);
  });

  test("foldGlobCase expands literal letters and copies classes, ranges, braces and wildcards verbatim", () => {
    expect(foldGlobCase("SRC/**/*.TS")).toBe("[sS][rR][cC]/**/*.[tT][sS]");
    expect(foldGlobCase("[!A-z].txt")).toBe("[!A-z].[tT][xX][tT]");
    expect(foldGlobCase("{src,lib}/**")).toBe("{[sS][rR][cC],[lL][iI][bB]}/**");
    expect(foldGlobCase("src/a[bc]?.ts")).toBe("[sS][rR][cC]/[aA][bc]?.[tT][sS]");
    // An escape cannot be expanded without changing what it means: stay exact.
    expect(foldGlobCase("a\\b")).toBeNull();
  });

  test("a folded match keeps the class's written set — no over-grant, and no case-folded classes", () => {
    expect(matchesPathScopes("_.txt", ["path:[!A-z].txt"], [true])).toBe(false);
    expect(matchesPathScopes("0.txt", ["path:[!A-z].txt"], [true])).toBe(true);
    expect(matchesPathScopes("src/a.ts", ["path:SRC/**/*.TS"], [true, true, true])).toBe(true);
    expect(matchesPathScopes("src/a.ts", ["path:{SRC,lib}/**"], [true, true])).toBe(true);
    // Conservative under-grant, never a widening: class membership is the
    // set the author wrote, not a case-folded one.
    expect(matchesPathScopes("A.txt", ["path:[a-z].txt"], [true])).toBe(false);
    expect(matchesPathScopes("a.txt", ["path:[A-Z].txt"], [true])).toBe(false);
  });

  test("an escaped pattern stays exact instead of guessing", () => {
    expect(matchesPathScopes("a.txt", ["path:\\A.txt"], [true])).toBe(false);
    expect(matchesPathScopes("A.txt", ["path:\\A.txt"], [true])).toBe(true);
  });

  test("a negated grant stays negated case-insensitively: !src/** still excludes SRC/**", () => {
    // On an insensitive filesystem `SRC/a.ts` is `src/a.ts`, so the
    // exclusion must hold; the exact reading alone would grant it.
    expect(matchesPathScopes("SRC/a.ts", ["path:!src/**"], [true, true])).toBe(false);
    expect(matchesPathScopes("src/a.ts", ["path:!src/**"], [true, true])).toBe(false);
    expect(matchesPathScopes("other.txt", ["path:!src/**"], [true])).toBe(true);
    // On a sensitive filesystem `SRC/` is a distinct directory and stays granted.
    expect(matchesPathScopes("SRC/a.ts", ["path:!src/**"], [false, false])).toBe(true);
  });
});

describe("path scope: case behavior is per component (regression)", () => {
  test("a sensitive ancestor is never matched on an insensitive descendant's answer", () => {
    // root sensitive; `src` under it sensitive; `leaf` on an insensitive
    // mount below: answers [false, true, true]. The old leaf-only probe
    // read `leaf`'s answer and folded the whole path, so `SRC/**` granted
    // `src/leaf/f.ts`.
    expect(matchesPathScopes("src/leaf/f.ts", ["path:SRC/**"], [false, true, true])).toBe(false);
    // The exact-case grant still works on the same mixed path.
    expect(matchesPathScopes("src/leaf/f.ts", ["path:src/leaf/**"], [false, true, true])).toBe(true);
  });

  test("a mixed path never widens, in either direction", () => {
    expect(matchesPathScopes("src/leaf/f.ts", ["path:SRC/LEAF/**"], [true, true, true])).toBe(true);
    expect(matchesPathScopes("src/leaf/f.ts", ["path:SRC/LEAF/**"], [false, true, true])).toBe(false);
    expect(matchesPathScopes("src/leaf/f.ts", ["path:SRC/leaf/**"], [true, false, true])).toBe(false);
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

#!/usr/bin/env bun
/**
 * `moh extension` (#1128, ADR-0061): install, list and remove extension
 * packages from exactly two immutable sources — npm scoped packages and
 * GitHub releases (repo + tag). Static checks only: the manifest is read
 * as bytes, the checksum verified against the source's own digest, and
 * package code is never executed. Installation never authorizes: the
 * capability consent happens at load, always.
 *
 * Prior art: `moh mcp add` (the shared add/list/remove seam).
 */
import { join } from "node:path";
import {
  installExtension,
  listInstalledExtensions,
  parseExtensionRef,
  removeInstalledExtension,
  type RegistryIo,
} from "@moh/core";

export const EXTENSION_USAGE = `usage: moh extension <command> [options]

commands:
  add <ref> [--user] [--cwd <dir>]
          install an extension package from an immutable source:
            @scope/name[@version]   npm scoped package
            github:owner/repo[@tag] GitHub release (repo + tag)
          Installed into <cwd>/extensions/ (project scope) or
          ~/.moh/extensions/<name>/ with --user. Static checks only —
          package code is never executed; installation never authorizes,
          the load-time consent decides. Raw URLs and tarballs are refused.
  list    show installed extensions (both scopes; duplicate identities
          report the ignored copy — project wins over the user dotdir)
  remove <name> [--cwd <dir>]
          remove an installed extension by name (project scope first)`;

export interface ExtensionOptions {
  argv: string[];
  cwd?: string;
  /** Home dir override (tests): user-scope packages live in <home>/.moh/extensions. */
  home?: string;
  /** Registry IO seam (tests): defaults to the real network + tar. */
  io?: RegistryIo;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** The real registry IO: fetch for text/bytes, system tar for extraction. */
async function realRegistryIo(): Promise<RegistryIo> {
  return {
    async fetchText(url: string) {
      try {
        const res = await fetch(url, { headers: { accept: "application/json" } });
        if (!res.ok) return { ok: false, status: res.status, message: `HTTP ${res.status} for ${url}` };
        return { ok: true, body: await res.text() };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
    async fetchBytes(url: string) {
      try {
        const res = await fetch(url);
        if (!res.ok) return { ok: false, status: res.status, message: `HTTP ${res.status} for ${url}` };
        return { ok: true, body: new Uint8Array(await res.arrayBuffer()) };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
    async extractTgz(tgz: Uint8Array, dir: string) {
      const proc = Bun.spawn(["tar", "-xzf", "-", "-C", dir], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
      });
      proc.stdin.write(tgz);
      proc.stdin.end();
      const code = await proc.exited;
      if (code !== 0) throw new Error(`tar extraction failed (exit ${code}): ${await new Response(proc.stderr).text()}`);
    },
  };
}

export async function extensionCommand(options: ExtensionOptions): Promise<number> {
  const out = options.stdout ?? process.stdout;
  const err = options.stderr ?? process.stderr;
  const [sub, ...rest] = options.argv;
  if (!sub || sub === "help" || sub === "--help") {
    out.write(EXTENSION_USAGE + "\n");
    return sub ? 0 : 2;
  }
  const cwd = join(options.cwd ?? process.cwd());
  const home = options.home ?? process.env.HOME ?? "";
  const mohHome = join(home, ".moh");
  try {
    if (sub === "add") return await add(rest, { cwd, mohHome, out, err, io: options.io });
    if (sub === "list") return list(rest, { cwd, mohHome, out });
    if (sub === "remove") return remove(rest, { cwd, mohHome, out, err });
  } catch (e) {
    err.write(`moh extension: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  err.write(`moh extension: unknown command "${sub}"\n\n${EXTENSION_USAGE}\n`);
  return 2;
}

async function add(
  argv: string[],
  ctx: { cwd: string; mohHome: string; out: NodeJS.WritableStream; err: NodeJS.WritableStream; io?: RegistryIo },
): Promise<number> {
  const user = argv.includes("--user");
  const positionals = argv.filter((a) => !a.startsWith("--"));
  const refInput = positionals[0];
  if (!refInput) {
    ctx.err.write("moh extension add: a package reference is required\n");
    return 2;
  }
  const parsed = parseExtensionRef(refInput);
  if (!parsed.ok) {
    ctx.err.write(`moh extension add: ${parsed.reason}\n`);
    return 2;
  }
  const destRoot = user ? join(ctx.mohHome, "extensions") : join(ctx.cwd, "extensions");
  const result = await installExtension({ ref: parsed.ref, destRoot, io: ctx.io ?? (await realRegistryIo()) });
  if (!result.ok) {
    ctx.err.write(`moh extension add: ${result.reason}\n`);
    if (result.expected && result.actual) {
      ctx.err.write(`  expected: ${result.expected}\n  actual:   ${result.actual}\n`);
    }
    return 1;
  }
  for (const warning of result.warnings) ctx.err.write(`warning: ${warning}\n`);
  for (const note of result.notes) ctx.out.write(`note: ${note}\n`);
  ctx.out.write(`installed ${result.name}@${result.version} into ${result.dir}\n`);
  return 0;
}

function list(
  argv: string[],
  ctx: { cwd: string; mohHome: string; out: NodeJS.WritableStream },
): number {
  void argv;
  const installed = listInstalledExtensions({ mohHome: ctx.mohHome, cwd: ctx.cwd });
  if (installed.length === 0) {
    ctx.out.write("no extensions installed (moh extension add <ref>)\n");
    return 0;
  }
  for (const ext of installed) {
    const caps = ext.capabilities.length ? ext.capabilities.join(", ") : "no capabilities declared";
    ctx.out.write(`${ext.name}@${ext.version}  [${ext.scope}, ${ext.path}]\n  entry: ${ext.entry.join(", ")} · capabilities: ${caps}\n`);
    for (const ignored of ext.ignoredDuplicates ?? []) {
      ctx.out.write(`  ignored duplicate: ${ignored} (project scope wins over the user dotdir)\n`);
    }
  }
  return 0;
}

function remove(
  argv: string[],
  ctx: { cwd: string; mohHome: string; out: NodeJS.WritableStream; err: NodeJS.WritableStream },
): number {
  const name = argv.filter((a) => !a.startsWith("--"))[0];
  if (!name) {
    ctx.err.write("moh extension remove: an extension name is required (see: moh extension list)\n");
    return 2;
  }
  const result = removeInstalledExtension(name, { mohHome: ctx.mohHome, cwd: ctx.cwd });
  if (!result.ok) {
    ctx.err.write(`moh extension remove: ${result.reason}\n`);
    return 1;
  }
  ctx.out.write(`removed "${name}" (${result.scope} scope) from ${result.path}\n`);
  return 0;
}

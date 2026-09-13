/**
 * `moh mpm` (#618): local CLI diagnostics for the Moh Project Map. Prints
 * the read-only diagnostics projection — status, coverage per declared
 * capability, freshness, pending background work, budgets, exclusions,
 * evictions, and fallback reasons — never source content or prompt text.
 *
 * This is a pure reader: it constructs (never mutates) the projection
 * service over the project's `project-map/` directory and resolves the
 * user/project config with the same precedence sessions use.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  MpmService,
  mpmDiagnostics,
  readMpmUserConfig,
  resolveMpmConfig,
  projectMapDir,
  loadMohConfig,
  userConfigFile,
  type MpmDiagnostics,
} from "@moh/core";
import { ArgError, parseArgs } from "./args";

export const MPM_USAGE = `usage: moh mpm [--cwd <dir>] [--json]

Local diagnostics for the Moh Project Map: what is mapped, how fresh it
is, what work is pending, and which budgets and exclusions apply.

  --cwd <dir>   project root to report on (default: process.cwd())
  --json        machine-readable output (the full diagnostics object)

Diagnostics are metadata only: paths, counts, and timings — never source
content. When MPM is disabled (MPM is opt-in: off unless the user default
or an explicit project override turns it on), the report says which side
disabled it.`;

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function fmtAge(builtAt: number | null): string {
  if (builtAt === null) return "never built";
  const s = Math.max(0, Math.round((Date.now() - builtAt) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)}min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function render(diag: MpmDiagnostics): string {
  const lines: string[] = [];
  const status = diag.disabled
    ? `MPM — disabled (${diag.disabledReason === "user" ? "user config" : "project config"})`
    : diag.status === "ready"
      ? "MPM ✓ ready"
      : diag.status === "updating"
        ? "MPM ↻ updating"
        : "MPM — unavailable";
  lines.push(status);
  if (diag.disabled) return lines.join("\n");

  lines.push(`files: ${diag.fileCount} mapped · ${diag.symbolCount} symbols · built ${fmtAge(diag.builtAt)}`);
  if (diag.coverage.length > 0) {
    lines.push(
      `coverage: ${diag.coverage.map((c) => `${c.language} ${c.files} (${c.symbols} sym)`).join(", ")}`,
    );
  }
  if (diag.staleCount > 0) lines.push(`freshness: ~${diag.staleCount} sampled files stale`);
  if (diag.pendingWork > 0) lines.push(`pending: ${diag.pendingWork} file(s) awaiting refresh`);
  if (diag.evictions > 0) lines.push(`evictions (this process): ${diag.evictions}`);
  lines.push(
    `budget: ${diag.budget.maxFiles.toLocaleString("en-US")} files · ${fmtBytes(diag.budget.maxTotalBytes)}`,
  );
  if (diag.exclusions.length > 0) lines.push(`exclusions: ${diag.exclusions.join(", ")}`);
  if (diag.fallbackReason) lines.push(`last plan fallback: ${diag.fallbackReason}`);
  return lines.join("\n");
}

export async function mpmCommand({
  argv,
  home,
  out,
  err,
}: {
  argv: string[];
  home?: string;
  out?: { write(s: string): void };
  err: { write(s: string): void };
}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv, { strings: ["cwd"], booleans: ["json"] });
  } catch (e) {
    if (e instanceof ArgError) {
      err.write(`moh mpm: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const cwd = parsed.strings["cwd"] ? resolve(parsed.strings["cwd"]) : process.cwd();
  const h = home ?? homedir();
  const stdout = out ?? process.stdout;

  // The same resolution sessions use: user default, project restrict-only.
  // A broken moh.json is a hard error here too (same as session assembly).
  let projectMpm;
  try {
    projectMpm = loadMohConfig(join(cwd, "moh.json")).mpm;
  } catch (e) {
    err.write(`moh mpm: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const config = resolveMpmConfig(readMpmUserConfig(userConfigFile(h)), projectMpm);
  const service = new MpmService(projectMapDir(join(h, ".moh"), cwd));
  try {
    service.load();
  } catch {
    // load is fail-safe by design; diagnostics degrade honestly.
  }
  const diag = mpmDiagnostics({
    service,
    root: cwd,
    config,
    // pendingWork/evictions/fallbackReason are session-process state; a
    // fresh CLI process can only report static projection facts. A live
    // client (TUI #619) passes them from its own lifecycle/orientation.
  });
  stdout.write(parsed.booleans["json"] ? `${JSON.stringify(diag, null, 2)}\n` : `${render(diag)}\n`);
  return 0;
}

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, posix } from "node:path";
import { discoverWorkspace, MPM_MAX_FILE_SIZE } from "./discover";
import { capabilityForPath } from "./capabilities";
import type { MpmFileRecord, MpmRelation } from "./types";

/**
 * MPM workspace extraction (#615): turn the discovered candidate set into
 * validated `MpmFileRecord`s ready for `MpmService.rebuild`. Deterministic:
 * discovery order, symbol order, and relation order are all stable for a
 * given workspace state. Only declared capability families produce
 * relations; relation targets are resolved against the discovered file set
 * (unresolvable specifiers are dropped — never invented).
 */

/** Directly verifiable reference/test relationship: a test file and its subject. */
function isTestPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    /(^|\/)__tests__\//.test(path) ||
    /(^|\/)test_[^/]+\.py$/.test(path) ||
    /_test\.go$/.test(path)
  );
}

/**
 * Resolve a relative import specifier to a workspace-root-relative path in
 * the discovered set. Only extensions the capability registry claims are
 * probed, and extensionless specifiers follow the TS/JS resolution order.
 */
function resolveSpecifier(specifier: string, fromPath: string, known: Set<string>): string | null {
  if (specifier.startsWith("/") || isAbsolute(specifier) || !specifier.startsWith(".")) return null;
  const fromDir = dirname(fromPath);
  const base = posix.normalize(posix.join(fromDir, specifier));
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"].map((ext) => `${base}${ext}`),
    ...[".ts", ".tsx", ".js", ".jsx"].map((ext) => `${base}/index${ext}`),
    // Tier A file-literal forms resolve exactly, no extension probing.
    ...[".c", ".h", ".cc", ".cpp", ".hpp", ".sh", ".lua", ".py"].map((ext) => `${base}${ext}`),
  ];
  for (const candidate of candidates) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

function normalizeConfigTarget(via: string, known: Set<string>): string | null {
  const base = posix.normalize(via.replace(/^\.\//, ""));
  return known.has(base) ? base : null;
}

/**
 * Extract the whole workspace. Returns records keyed by path; empty (but
 * never throws) when the root is unreadable.
 */
export function extractWorkspace(root: string): Map<string, MpmFileRecord> {
  const files = discoverWorkspace(root);
  const known = new Set(files);
  const records = new Map<string, MpmFileRecord>();

  for (const path of files) {
    const abs = join(root, path);
    let content: string;
    let size: number;
    try {
      size = statSync(abs).size;
      // Re-check the cap at extraction time: the file may have grown since
      // discovery (TOCTOU on the oversize boundary).
      if (size > MPM_MAX_FILE_SIZE) continue;
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const cap = capabilityForPath(path);
    const symbols: MpmFileRecord["symbols"] = [];
    const relations: MpmRelation[] = [];
    if (cap) {
      const extracted = cap.extract(content);
      symbols.push(...extracted.symbols);
      for (const rel of extracted.relations) {
        // Declared-families gate: a capability only emits relation kinds its
        // families still declare. Dropping the family silences the relation.
        if (!cap.families.has(rel.kind)) continue;
        if (rel.kind === "config-links" && !cap.resolveTarget) {
          const target = normalizeConfigTarget(rel.via, known);
          if (target) relations.push({ ...rel, target });
        } else if (cap.resolveTarget) {
          const target = cap.resolveTarget(rel.via, path, known, root);
          if (target) relations.push({ ...rel, target });
        } else {
          const target = resolveSpecifier(rel.via, path, known);
          if (target) relations.push({ ...rel, target });
        }
      }
      // Directly verifiable test relationship: a test file importing a
      // workspace file adds a `references` edge to its subject.
      if (cap.families.has("test-subjects") && isTestPath(path)) {
        const subjects = new Set(relations.filter((r) => r.kind === "imports").map((r) => r.target));
        for (const target of subjects) {
          if (!isTestPath(target) && !relations.some((r) => r.kind === "references" && r.target === target)) {
            relations.push({
              kind: "references",
              target,
              via: `test-subject:${target}`,
              line: relations.find((r) => r.target === target)!.line,
            });
          }
        }
      }
    }
    records.set(path, {
      path,
      hash: createHash("sha256").update(content).digest("hex"),
      size,
      language: cap?.name ?? "unsupported",
      symbols,
      relations,
    });
  }
  return records;
}

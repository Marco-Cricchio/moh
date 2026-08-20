/**
 * `--allow` / `--deny` rule grammar (#31). One grammar shared by the CLI,
 * moh.json and the TUI: `tool`, `bash:<command prefix>` (shell-word token
 * prefix), `write:<glob>` / `edit:<glob>` (root-anchored path glob). The
 * same matcher string works everywhere; CLI flags merge on top of moh.json
 * `permissions.overrides` (CLI wins at equal specificity).
 */
import { splitCommandSegments, type PermissionOverrides } from "@moh/core";

export class RuleError extends Error {}

const PATH_GLOB_TOOLS = new Set(["write", "edit"]);

/**
 * Parses one `--allow`/`--deny` rule string into a partial override.
 * Rules are additive across flags; later rules never remove earlier ones.
 */
export function parseRule(rule: string, effect: "allow" | "deny"): Partial<PermissionOverrides> {
  if (rule === "") throw new RuleError(`empty ${effect} rule`);
  const colon = rule.indexOf(":");
  if (colon === -1) {
    return { tools: { [rule]: effect } };
  }
  const tool = rule.slice(0, colon);
  const rest = rule.slice(colon + 1).trim();
  if (tool === "bash") {
    const segments = splitCommandSegments(rest);
    const tokens = segments[0];
    if (!tokens || segments.length > 1) {
      throw new RuleError(
        `invalid bash rule "${rule}": expected a single command prefix (compound commands need one --allow per segment)`,
      );
    }
    return effect === "allow" ? { bashAllow: [tokens] } : { bashDeny: [tokens] };
  }
  if (PATH_GLOB_TOOLS.has(tool)) {
    if (!rest) throw new RuleError(`invalid ${tool} rule "${rule}": missing path glob`);
    return effect === "allow" ? { pathAllow: [rest] } : { pathDeny: [rest] };
  }
  // Any other path-arg tool falls back to the shared path-glob rules.
  if (!rest) throw new RuleError(`invalid rule "${rule}": missing argument matcher`);
  return effect === "allow" ? { pathAllow: [rest] } : { pathDeny: [rest] };
}

/** Merges CLI rules on top of moh.json overrides. CLI wins for tool decisions; lists are unioned (CLI first). */
export function mergeOverrides(base: PermissionOverrides | undefined, cli: PermissionOverrides): PermissionOverrides {
  const merged: PermissionOverrides = {
    tools: { ...base?.tools, ...cli.tools },
    bashAllow: [...(cli.bashAllow ?? []), ...(base?.bashAllow ?? [])],
    bashDeny: [...(cli.bashDeny ?? []), ...(base?.bashDeny ?? [])],
    pathAllow: [...(cli.pathAllow ?? []), ...(base?.pathAllow ?? [])],
    pathDeny: [...(cli.pathDeny ?? []), ...(base?.pathDeny ?? [])],
  };
  return merged;
}

/** Builds the full CLI overrides from repeatable `--allow`/`--deny` flag values. */
export function overridesFromFlags(allow: string[], deny: string[]): PermissionOverrides {
  const merged: PermissionOverrides = {};
  const absorb = (rule: string, effect: "allow" | "deny"): void => {
    const partial = parseRule(rule, effect);
    if (partial.tools) Object.assign((merged.tools ??= {}), partial.tools);
    if (partial.bashAllow) (merged.bashAllow ??= []).push(...partial.bashAllow);
    if (partial.bashDeny) (merged.bashDeny ??= []).push(...partial.bashDeny);
    if (partial.pathAllow) (merged.pathAllow ??= []).push(...partial.pathAllow);
    if (partial.pathDeny) (merged.pathDeny ??= []).push(...partial.pathDeny);
  };
  for (const rule of allow) absorb(rule, "allow");
  for (const rule of deny) absorb(rule, "deny");
  return merged;
}

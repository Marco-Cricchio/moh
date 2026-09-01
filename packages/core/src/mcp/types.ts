import { z } from "zod";
import { readUserConfigFile, updateUserConfigFile, userConfigFile } from "../user-config";
import { dirname, resolve } from "node:path";
import { projectSlug } from "../session-store";

/** Handshake budget. A server that does not answer `initialize` in time fails. */
export const MCP_HANDSHAKE_TIMEOUT_MS = 10_000;

export const PROTOCOL_VERSION = "2025-06-18";

/** moh.json / ~/.moh/config `mcpServers` entry (per server, keyed by name). */
export const mcpServerEntrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    /** Legacy pre-#352 field. Tolerated on parse (old configs load), but
     * ignored: project trust lives in the user config `mcpTrust` section. */
    trusted: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("http"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    trusted: z.boolean().optional(),
  }),
]);

export type McpServerEntry = z.infer<typeof mcpServerEntrySchema>;

/** A resolved server declaration: entry + name + trust scope. */
export interface DeclaredMcpServer {
  name: string;
  /** "project" servers ask consent on first use; "user" servers never ask. */
  scope: "project" | "user";
  transport: McpServerEntry;
  /**
   * Resolved trust for project servers: a persisted "always" consent,
   * recorded by moh itself in the user config (`mcpTrust`, #352/SEC-01).
   * This is deliberately *not* the repo-controlled `trusted` field of the
   * project `moh.json` entry — that field is tolerated on parse but never
   * read; the repository cannot self-declare trust.
   */
  trusted?: boolean;
}

/** Server lifecycle states visible to clients (e.g. `moh mcp list`). */
export type McpServerState = "stopped" | "starting" | "running" | "crashed" | "failed" | "denied";

export type McpConsentAnswer = "yes" | "always" | "no";

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/**
 * Reads user-scope MCP servers from `~/.moh/config` (trusted, never ask).
 * Invalid entries are skipped: user chrome never hard-fails a session.
 * Reads go through the config guardian (ADR-0006).
 */
export function loadUserMcpServers(file = userConfigFile()): Record<string, McpServerEntry> {
  const servers = readUserConfigFile(file).mcpServers;
  if (typeof servers !== "object" || servers === null) return {};
  const out: Record<string, McpServerEntry> = {};
  for (const [name, value] of Object.entries(servers)) {
    const parsed = mcpServerEntrySchema.safeParse(value);
    if (parsed.success) out[name] = parsed.data;
  }
  return out;
}

/** User-scope servers as trusted declarations (they never ask for consent). */
export function declaredUserMcpServers(file?: string): DeclaredMcpServer[] {
  return Object.entries(loadUserMcpServers(file)).map(([name, transport]) => ({ name, scope: "user" as const, transport }));
}

/**
 * User-config section recording persisted "always" consent for *project*
 * MCP servers (#352 / audit SEC-01), keyed by stable project identity →
 * server names. It lives in `~/.moh/config` precisely because the
 * repository cannot write there: a `trusted: true` shipped in the
 * project's `moh.json` is ignored.
 */
export const MCP_TRUST_SECTION = "mcpTrust";

/** Whether the user already consented "always" to this project server. */
export function isProjectServerTrusted(file: string, projectPath: string, server: string): boolean {
  const section = readUserConfigFile(file)[MCP_TRUST_SECTION];
  if (typeof section !== "object" || section === null || Array.isArray(section)) return false;
  const keys = [projectSlug(projectPath, dirname(dirname(file))), resolve(projectPath)];
  return keys.some((key) => {
    const names = (section as Record<string, unknown>)[key];
    return Array.isArray(names) && names.includes(server);
  });
}

/** Persists an "always" consent under stable project identity via the guardian. */
export function persistProjectMcpTrust(file: string, projectPath: string, server: string): void {
  const key = projectSlug(projectPath, dirname(dirname(file)));
  updateUserConfigFile(file, (data) => {
    const current = data[MCP_TRUST_SECTION];
    const section =
      typeof current === "object" && current !== null && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
    const names = Array.isArray(section[key]) ? [...(section[key] as string[])] : [];
    if (!names.includes(server)) names.push(server);
    section[key] = names;
    data[MCP_TRUST_SECTION] = section;
  });
}

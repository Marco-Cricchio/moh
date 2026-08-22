import { z } from "zod";
import { readUserConfigFile, userConfigFile } from "../user-config";

/**
 * MCP integration (#15 / issue #35): external tool sources over stdio and
 * HTTP streamable transports. Servers are declared in moh.json (project
 * scope, consent on first use) or `~/.moh/config` (user scope, trusted).
 *
 * - Tools are registered as `mcp__<server>__<tool>` under the standard
 *   Tool contract and permission spine; unmatched names fall through the
 *   resolver to "ask" (stricter default than built-ins).
 * - Servers start lazily on first use (first turn) and shut down at
 *   session end. A crash makes the server's tools unavailable until a
 *   manual `restart()`; there is no auto-restart.
 * - Tools only: sampling, roots and elicitation requests from servers
 *   are refused cleanly (JSON-RPC -32601) and the refusal is recorded in
 *   the session log as an `mcp_refused` event.
 */

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
    /** Project servers only: consent already given and persisted ("always"). */
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

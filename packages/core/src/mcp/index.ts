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
 *
 * mcp/ barrel: the public surface of the former mcp.ts, re-exported
 * unchanged (ADR-0004, ADR-0008). Internal layout: types.ts, errors.ts,
 * json-rpc.ts, transport-stdio.ts, transport-http.ts, runtime.ts.
 */
export {
  MCP_HANDSHAKE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  mcpServerEntrySchema,
  mcpToolName,
  loadUserMcpServers,
  declaredUserMcpServers,
  type McpServerEntry,
  type DeclaredMcpServer,
  type McpServerState,
  type McpConsentAnswer,
} from "./types";
export { McpError, type McpErrorKind } from "./errors";
export { McpRuntime, type McpRuntimeOptions } from "./runtime";

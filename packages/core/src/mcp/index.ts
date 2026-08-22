/**
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

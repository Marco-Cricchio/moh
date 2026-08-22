/**
 * The MCP error taxonomy. Distinct from provider errors: these classify
 * transport/lifecycle failures of external tool sources. `handshake_timeout`
 * is the categorized 10s-timeout failure mode.
 */
export type McpErrorKind =
  | "start_failed" // process could not be spawned / endpoint unreachable
  | "handshake_timeout" // initialize not answered within the budget
  | "timeout" // post-handshake request timed out (e.g. tools/call)
  | "crashed" // running server died or the connection broke
  | "protocol" // well-formed transport, invalid MCP payloads
  | "unavailable"; // used after a crash/stop without a manual restart

export class McpError extends Error {
  constructor(
    readonly kind: McpErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

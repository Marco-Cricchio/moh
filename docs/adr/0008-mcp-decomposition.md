# 0008 — Decompose mcp.ts into an mcp/ directory

Date: 2026-08-30 · Status: accepted · Refs: issue #109, `docs/principles.md` (1), ADR-0003 (precedent), ADR-0004

## Context

`packages/core/src/mcp.ts` (631 lines, the largest file in the repo) did five
jobs in one module: the config contract (schemas, lifecycle states, consent
types), the error taxonomy, the shared JSON-RPC bookkeeping (pending map,
timers, message routing), the two transports (stdio process, streamable
HTTP+SSE), and the `McpRuntime` director (consent gate, lifecycle, tool
registration, crash tracking, restart, shutdown).

## Decision

Same restoration contract as ADR-0003: restructure, not redesign. `mcp.ts`
becomes `packages/core/src/mcp/` with five modules, one per job:

- `types.ts` — `mcpServerEntrySchema`, `DeclaredMcpServer`, lifecycle states,
  consent types, and the name/user-config helpers (`mcpToolName`,
  `loadUserMcpServers`, `declaredUserMcpServers`);
- `errors.ts` — `McpErrorKind`/`McpError` (kept as its own module, not folded
  into types.ts: both transports and the runtime import it, and it reads as
  the taxonomy, not the contract);
- `json-rpc.ts` — `JsonRpcConnection`, the abstract base owning the pending
  map, timers, message routing, `failPending`/`markCrashed`/`close`;
- `transport-stdio.ts` / `transport-http.ts` — `StdioConnection` and
  `HttpConnection`, the two physical languages;
- `runtime.ts` — `McpRuntime`, the director.

`mcp/index.ts` is the barrel re-exporting the former `mcp.ts` surface
unchanged; `@moh/core` public exports stay byte-identical per ADR-0004.
Internal collaborators are internal: nothing new is exported from the package
index.

## Consequences

- Each module is readable in isolation; the director no longer carries
  transport plumbing.
- Behavior is identical: same events in the same order, 10s handshake / 60s
  tool-call budgets, no-auto-restart, consent sequences — all byte-for-byte.
  Test edits were import-path-only.
- Pure restoration: known smells (orphaned session-id comment on
  `HttpConnection`, hardcoded "0.1.0" client version) are noted for a
  possible later touch-up and were not fixed here.
- CONTEXT.md glossary gains the internal collaborator names.

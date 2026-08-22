# Spec: Decompose mcp.ts into an mcp/ directory

Status: agreed · Origin: codebase-health campaign, volume 2 (successor to docs/spec/session-decomposition.md) · Related: `docs/principles.md` (1), ADR-0003 (precedent), ADR-0008 (to be written with this work)

## Problem

`packages/core/src/mcp.ts` (631 lines) — the largest file in the repo — does five jobs in one module: the config contract (schemas, types, lifecycle states), the error taxonomy, the shared JSON-RPC bookkeeping (pending requests, timeouts, message routing), the two transports (stdio process, streamable HTTP+SSE), and the McpRuntime director (consent, lifecycle, tool registration, crash tracking, restart, shutdown).

## Target shape

```
packages/core/src/mcp/
  types.ts            — schemas (mcpServerEntrySchema), DeclaredMcpServer, states, consent types
  errors.ts           — McpErrorKind, McpError (or folded into types.ts if the implementer prefers; keep it one decision, recorded)
  json-rpc.ts         — JsonRpcConnection abstract base: pending map, timers, message routing, failPending/markCrashed/close
  transport-stdio.ts  — StdioConnection (Bun.spawn, read loop)
  transport-http.ts   — HttpConnection (POST + SSE draining, session id)
  runtime.ts          — McpRuntime: consent gate, ensureStarted/#connect, tool wrapping, restart, shutdown
```

Existing helpers `mcpToolName`, `loadUserMcpServers`, `declaredUserMcpServers` move to their natural home (types/runtime) — the public surface re-exports them unchanged.

## Decisions (from grilling)

1. Map approved as-is: five jobs → five modules; transports separate (they speak different physical languages).
2. Same restoration contract as ADR-0003: behavior identical, same events in the same order (mcp_server_started/failed/stopped, mcp_refused, permission_* consent flow), all tests green (import-path-only edits allowed in tests), public surface byte-identical per ADR-0004.
3. Pure restoration: no improvements in flight. Small smells spotted during survey (orphaned comment on HttpConnection session-id, hardcoded client version "0.1.0") are noted for a possible later touch-up, NOT fixed here.
4. ADR-0008 records the why (same family as ADR-0003); CONTEXT.md glossary gains the internal collaborator names.

## Invariants

1. All tests + typecheck green; no test rewrites beyond import paths.
2. `@moh/core` public exports unchanged (re-export from the new layout).
3. The 10s handshake budget, 60s tool-call timeout, no-auto-restart policy, consent event sequences — all byte-for-byte.

## Delivery

One ticket, one PR to `develop`. Two-axis review before merge.

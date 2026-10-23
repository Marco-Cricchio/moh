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

## Amendment — ablation (2026-10-23)

The decision above is unchanged. This amendment records how the `packages/core/src/mcp/` layout and the `@moh/core` MCP names look after the ablation: #1414 (S2.3, phase 2, delivered by #1554, merge `8e65f279`) and #1453 (S7.3, phase 7, delivered by #1609, merge `d278f471`). It adds no decision.

### What changed

- The barrel is gone (#1414). `packages/core/src/mcp/index.ts` was deleted, so the sentence "`mcp/index.ts` is the barrel re-exporting the former `mcp.ts` surface unchanged" no longer describes the tree. `packages/core/src/index.ts` now exports the MCP names directly from the defining modules: `McpRuntime` and `McpRuntimeOptions` from `./mcp/runtime`; `mcpServerEntrySchema`, `isHttpMcpUrl`, `declaredUserMcpServers`, `DeclaredMcpServer` and `McpServerEntry` from `./mcp/types`. The other core-internal importers of the barrel were repointed to the defining module: `config.ts` to `./mcp/types`, `session/from-config.ts` to `../mcp/types`, `session/config.ts` to `../mcp/runtime`, `session/session.ts` to `../mcp/runtime` (it also imports `persistProjectMcpTrust` from `../mcp/types`), and `test/mcp.test.ts` to `../src/mcp/errors` and `../src/mcp/types` (the two were merged into `../src/mcp/types` by #1453, below). The 18 lines that #1554 added to `packages/core/src/mcp/runtime.ts` are the module's header comment, moved from the barrel; the sentence about the barrel was dropped and no code moved.
- `errors.ts` is folded into `types.ts` (#1453). `McpErrorKind` and `McpError` are appended at the end of `packages/core/src/mcp/types.ts`; their text is identical to the deleted `errors.ts`. `json-rpc.ts`, `transport-stdio.ts`, `transport-http.ts`, `runtime.ts` and `test/mcp.test.ts` now import them from `./types`. The reason given above for keeping `errors.ts` separate (both transports and the runtime import it; it reads as the taxonomy) is no longer applied by the layout: the taxonomy now lives in `types.ts`, next to the contract. #1609 also updated the layout comment at the top of `runtime.ts` (`b7730836`) to drop `errors.ts` from it.
- Four `mcp/` declarations lost `export` in #1556 (S2.4-core, merge `132d05f3`, `Refs #1416`; it applied the file-local inventory of #1415): `loadUserMcpServers` and `MCP_TRUST_SECTION` in `types.ts` (the first is named in the `types.ts` bullet above), `MCP_REQUEST_TIMEOUT_MS` in `transport-http.ts` and `MCP_MAX_LINE_BYTES` in `transport-stdio.ts`. They are file-local now.

### What stays

- The directory has five files: `json-rpc.ts`, `runtime.ts`, `transport-http.ts`, `transport-stdio.ts` and `types.ts`. The split by job is unchanged for the rest: `JsonRpcConnection` in `json-rpc.ts` is the base of both `StdioConnection` and `HttpConnection`, and `McpRuntime` stays in `runtime.ts`.
- The `types.ts` contents listed above (`mcpServerEntrySchema`, `DeclaredMcpServer`, lifecycle states, consent types, `mcpToolName`, `declaredUserMcpServers`) are still there; `loadUserMcpServers` is there but file-local (see above).
- #1554 left the `@moh/core` MCP names as they were (its recorded B1 result is identical). They were not changed by #1453 either: `McpError` is not exported from `packages/core/src/index.ts`.
- Behavior is untouched by both PRs: the 10s handshake and 60s tool-call budgets, no auto-restart and the consent sequences are not edited by either diff.
- The two known smells were not left for a later touch-up in the ablation: both were fixed earlier, by `9e74cd11` (`chore(mcp): fix small smells noted during decomposition`). `runtime.ts` sends `clientInfo.version` as `MOH_VERSION`, not the literal "0.1.0", and the session-id comment in `transport-http.ts` is now inside `send`, above the code that sets the headers. The sentence in Consequences describes the decomposition commit `d019a487` (#110); `9e74cd11` is its direct child.
- `CONTEXT.md` has the section "Internal MCP collaborators (ADR-0008)". Neither #1554 nor #1609 edits it.

### Public surface

The Decision's "byte-identical" sentence (which cites ADR-0004) concerns the move of `mcp.ts` into `mcp/`. The `@moh/core` entry was pruned afterwards, outside the MCP tickets. Two MCP names that the entry had at the first lock of `packages/core/test/entry-surface/core.txt` (#1388) are no longer in it: `isProjectServerTrusted` and `persistProjectMcpTrust`, removed from `packages/core/src/index.ts` by `dfecd515` (#1412, delivered by #1551, merge `9081e122`). Both are still defined in `mcp/types.ts`: `isProjectServerTrusted` is imported from `../mcp/types` by `session/from-config.ts`, and `persistProjectMcpTrust` by `session/session.ts`. The MCP names in the entry today are `DeclaredMcpServer`, `McpRuntime`, `McpRuntimeOptions`, `McpServerEntry`, `declaredMcpServers`, `declaredUserMcpServers`, `isHttpMcpUrl`, `mcpServerEntrySchema` and `upsertMcpServer`; `declaredMcpServers` and `upsertMcpServer` come from `config.ts`.

### References

Issues #1388, #1412, #1414, #1415, #1416, #1453, #1457; PRs #1551, #1554, #1556, #1609; ADR-0004.

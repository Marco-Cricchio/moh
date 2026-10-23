# Host-tool seam: the host performs what an extension asks for

The charting decision (host-owned tools) fixed the shape — the implementation lives in moh, the capability scopes are the parameters, moh executes and refuses outside scope. This ADR fixes the one seam through which every scope arc (`path:<glob>`, `host:<domain>`, credential, `tool:<name|*>`, `endpoint:<ref>`) is exercised, so no scope re-decides the surface, the grammar, the enforcement, the consent shape or the logging.

## Decision

- **Surface**: `ctx.host.*` on the extension setup context (`ExtensionSetupContext`), present only when the enable consent covers at least one scope — the same "enforcement by absence" mechanism as `registerCommand`/`registerPanel`. The extension API version bumps to **1.13**.
- **Scope grammar**: flat prefixed strings in the manifest's `capabilities` array (`"path:src/**"`, `"host:api.example.com"`), the same shape as the ADR-0007 permission-rule grammar. No structured objects: identity and comparison stay string equality, so the existing subset-check (`capabilitiesSubset`) and `capabilityDiff` re-ask work unchanged.
- **Refusal**: a typed result, never an exception — `{ ok: false, reason: "outside_scope", ... }` as the return value. Refusals are policy answers, not failures of the extension; they are recorded as a distinct `host_refused` chrome event and never reuse `extension_failed` (which reports extension faults, not host refusals).
- **Enforcement point**: one core module (`checkScope`) that every `ctx.host.*` method traverses before executing. A new scope inherits the seam; refusals are always the same type.
- **Log**: one chrome event per performed operation, success and refusal — `host_op { callId, extension, op, params, outcome, ... }` / `host_refused { callId, extension, op, target, reason }`. The host acted in the world; the owner can answer "what did this extension do?" without reconstruction. Secret redaction (ADR-0058) applies downstream.
- **Consent and revocation**: revocation at next start, through the existing path+hash mechanism — changed capabilities are changed bytes, hence a new question. The consent question translates each scope into one concrete effect sentence ("may read files under `src/**`", "may contact `api.example.com`"), never the naked string alone, and states the no-sandbox line.
- **Stated boundary (in print, consent + this ADR)**: no OS sandbox — consent is the whole boundary; the scope constrains requests to the seam, not the extension's own code; no rate limiting.

## Considered options

- `ctx.request`/`ctx.perform` instead of `ctx.host.*` — rejected: the name should say who executes.
- Structured capability objects — rejected: breaks the subset-check, the diff, and one-grammar consistency; no current scope needs named fields.
- Exceptions for refusals — rejected: a policy refusal is not an error path.
- Log refusals only + rollup — rejected: host-performed success is exactly the thing the owner must be able to audit.

## Consequences

Each scope arc now decides only its own cell — which operations exist, fine semantics (redirects, glob dialect, custody), scope-specific refusal reasons — and inherits everything decided here. The ADRs for `path`, `host`, credential, `tool` and `endpoint` land next; the seam ADR is their prerequisite.

## Amendment — ablation (2026-10-19)

The decision above is unchanged. This amendment records where its enforcement
point lives after #1424 (S3.2, delivered by #1571), the prerequisite recorded
for this ADR.

### What changed

- "One core module (`checkScope`)" is now `packages/core/src/scopes.ts`. It
  holds a table with one descriptor per scope kind — `path`, `host`, `tool`,
  `contribute-tool`, `endpoint`, `credential` — each carrying the prefix, the
  grammar validator, the check and the effect sentence.
- `checkScope` and `scopeEffectSentence` are lookups in that table: the first
  reads the entry for the request kind, the second walks the table by prefix,
  then renders `spawn-subagent` and returns `null` for anything else, as
  before. Their names, every refusal reason and the effect sentences are
  unchanged.
- `contribute-tool` is not exercised through `checkScope`: `checkScope` returns
  `undefined` for that kind, and the extension runtime reads it directly
  through `contributesTool`, as before. The text above lists five scope arcs
  and does not name `contribute-tool`.
- The modules `check-scope.ts`, `scope-effect.ts`, `tool-scope.ts`,
  `endpoint-scope.ts` and `credential-scope.ts` no longer exist. The credential
  stores are in `packages/core/src/credential-store.ts`; `host-scope.ts` keeps
  only the glob and filesystem helpers and the fetch limits (`MAX_FETCH_BYTES`,
  `MAX_REDIRECTS`).
- The `@moh/core` surface is unchanged: `scopeEffectSentence`,
  `validateCredentialScope`, `defaultCredentialStore` and `type CredentialStore`
  are exported as before, now from `scopes.ts` and `credential-store.ts`.

### What stays

- The table does not cover every scope-prefix dispatch. A second table, prefix
  to grammar validation, `SHIPPED_SCOPE_GRAMMARS` in
  `packages/core/src/extension-registry.ts`, was not part of #1424 (coordinator
  decision); only its import lines changed.

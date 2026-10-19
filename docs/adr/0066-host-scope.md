# Host scope: `host:<domain>` authorizes exact-host https contact

Under the host-tool seam (ADR-0064), the host scope decides what one `host:<domain>` grant authorizes when an extension asks the host to make a network request. Prior art weighed: Chrome's origin patterns (expressive, but a second grammar inside the string and warnings that mask each other) and Figma's `allowedDomains` + required `reasoning` (the model for the total wildcard).

## Decision

- **Exact host, https implicit**: `host:api.example.com` = that host, https, standard port. Subdomains are declared, never implied: `host:*.example.com` covers one level of wildcard per label as written. An explicit port is allowed for development (`host:localhost:3000`). No origin-pattern grammar inside the string — identity stays string equality, like every other scope.
- **Total wildcard allowed, with justification**: `host:*` exists, but the manifest must carry a `reasoning` string (the Figma model), which the consent question displays. The owner reads the author's justification and decides; moh does not verify it.
- **Every hop in scope**: a redirect to a host outside the allowlist is not followed — the refusal is `{ ok: false, reason: "outside_scope", target: "<redirect host>" }`, recorded as `host_refused`. The redirect is a way of asking for another host; an open redirect on an allowed host must not become a trampoline (exfiltration via query parameters) and must not empty the allowlist.
- **Finite redirect safety guard**: at most five redirects are followed, even when every hop remains in scope. Exceeding the cap refuses with `outside_scope` and a `more than 5 redirects` message. This bounds loops and request amplification; it does not replace the per-hop allowlist check.
- **Response**: fully buffered bytes with a fixed size limit (1 MiB default) — `{ ok: true, status, bytes }`; oversize is `{ ok: false, reason: "too_large" }`. No streaming in this phase.
- **Request side (#1162)**: `fetch` carries `method` (GET default, POST), a POST-only body capped by the same fixed limit as the response (`too_large` past it), `contentType` defaulting to `application/json` when a body is set, and `signal` for host-side abort. A POST replays its method and body across in-scope redirect hops — the hops are transport, the request was one operation. `host_op` and `host_refused` record the method. First consumer: Jev's TypeSafe judging calls.
- **Credentials are a second scope**: `ctx.host.fetch` under `host:` alone makes anonymous requests; an authenticated request requires the matching `credential:<ref>` scope too (non-cumulative scopes = `outside_scope`). The boundary is fixed here; custody and resolution belong to the credential ADR.
- **Log**: `host_op { extension, op: "fetch", host, path, status, bytes, outcome }` / `host_refused { extension, op, target, reason }` — per ADR-0064, one event per operation; redaction downstream.

Inherited without re-deciding: typed refusals, one check-scope module, revocation at next start, effect-sentence consent ("may contact `api.example.com`").

## Considered options

- Chrome origin patterns — rejected: schema/port embedded in the string duplicate what https-implicit + explicit-port already say, and Chrome's own docs show combined warnings hiding each other.
- Following redirects unchecked — rejected: silently turns "one host" into "the reachable web", enables silent exfiltration through allowed hosts' open redirects, and makes the consent sentence and the log lie.

## Consequences

The credential arc must resolve `credential:<ref>` host-side (injection into the request), never hand the value to extension code, and define the failure mode when a ref does not resolve.

## Amendment — ablation (2026-10-19)

The decision above is unchanged. This amendment records where the `host:` scope lives after #1424 (S3.2, delivered by #1571), the prerequisite recorded for this ADR. It adds no decision.

### What changed

- The `host:` grammar, validation, match and check are in `packages/core/src/scopes.ts`: `HOST_SCOPE_PREFIX`, `isHostScope`, `hostScopesOf`, `TOTAL_HOST_WILDCARD`, `HOST_SCOPE_REASONING_KEY`, `validateHostScope` and `hostMatchesScope` are exported from there; `checkHostScope` and `type HostFetchCheck` are file-local. The effect sentence ("may contact …", including the one for `host:*`) is in the `host` descriptor of the scope table (`prefix`, `validate`, `check`, `effectSentence`). The table and its descriptors are new in #1571.
- Before #1571 the grammar, validation, match and check were in `packages/core/src/host-scope.ts` (`checkHostScope` and `type HostFetchCheck` were exported there), and the effect sentence was in `packages/core/src/scope-effect.ts`. The dispatch went through `packages/core/src/check-scope.ts`.
- The line "one check-scope module", inherited from ADR-0064, now reads as `checkScope` in `scopes.ts`, which looks up the descriptor for the request kind; the module `check-scope.ts` no longer exists. The ADR-0064 amendment records that change for all scope kinds.
- `MAX_FETCH_BYTES` and `MAX_REDIRECTS` are still exported from `packages/core/src/host-scope.ts`. The redirect loop, the limit of five, the `more than ${MAX_REDIRECTS} redirects` message and the `too_large` size limits are in `packages/core/src/extensions.ts`, where #1571 changes only import lines.

### What stays

- The rules in the Decision section are unchanged: the function bodies of `hostScopesOf`, `validateHostScope`, `hostMatchesScope` and `checkHostScope` are identical before and after #1571, apart from `export` dropped from `checkHostScope`.
- The refusal reasons are unchanged. `checkHostScope` returns `outside_scope`, `invalid_url` or `denied`; load-time validation of a `host:` scope returns `malformed`. The runtime fetch in `extensions.ts` returns further reasons of its own (`too_large`, `failed`, `unknown_credential`, among others); the inherited line above names `outside_scope`, which is one reason among those.
- The effect sentences for `host:` scopes are unchanged.
- The `host_op` and `host_refused` log is not touched by #1571: in `extensions.ts`, which performs the request and writes both events, #1571 changes only import lines.

### Tracked separately

Two behaviors of `host:` scopes are tracked separately in #1573 and #1574, not changed by #1571. This amendment takes no position on them.

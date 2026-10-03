# Host scope: `host:<domain>` authorizes exact-host https contact

Under the host-tool seam (ADR-0064), the host scope decides what one `host:<domain>` grant authorizes when an extension asks the host to make a network request. Prior art weighed: Chrome's origin patterns (expressive, but a second grammar inside the string and warnings that mask each other) and Figma's `allowedDomains` + required `reasoning` (the model for the total wildcard).

## Decision

- **Exact host, https implicit**: `host:api.example.com` = that host, https, standard port. Subdomains are declared, never implied: `host:*.example.com` covers one level of wildcard per label as written. An explicit port is allowed for development (`host:localhost:3000`). No origin-pattern grammar inside the string — identity stays string equality, like every other scope.
- **Total wildcard allowed, with justification**: `host:*` exists, but the manifest must carry a `reasoning` string (the Figma model), which the consent question displays. The owner reads the author's justification and decides; moh does not verify it.
- **Every hop in scope**: a redirect to a host outside the allowlist is not followed — the refusal is `{ ok: false, reason: "outside_scope", target: "<redirect host>" }`, recorded as `host_refused`. The redirect is a way of asking for another host; an open redirect on an allowed host must not become a trampoline (exfiltration via query parameters) and must not empty the allowlist.
- **Response**: fully buffered bytes with a fixed size limit (1 MiB default) — `{ ok: true, status, bytes }`; oversize is `{ ok: false, reason: "too_large" }`. No streaming in this phase.
- **Credentials are a second scope**: `ctx.host.fetch` under `host:` alone makes anonymous requests; an authenticated request requires the matching `credential:<ref>` scope too (non-cumulative scopes = `outside_scope`). The boundary is fixed here; custody and resolution belong to the credential ADR.
- **Log**: `host_op { extension, op: "fetch", host, path, status, bytes, outcome }` / `host_refused { extension, op, target, reason }` — per ADR-0064, one event per operation; redaction downstream.

Inherited without re-deciding: typed refusals, one check-scope module, revocation at next start, effect-sentence consent ("may contact `api.example.com`").

## Considered options

- Chrome origin patterns — rejected: schema/port embedded in the string duplicate what https-implicit + explicit-port already say, and Chrome's own docs show combined warnings hiding each other.
- Following redirects unchecked — rejected: silently turns "one host" into "the reachable web", enables silent exfiltration through allowed hosts' open redirects, and makes the consent sentence and the log lie.

## Consequences

The credential arc must resolve `credential:<ref>` host-side (injection into the request), never hand the value to extension code, and define the failure mode when a ref does not resolve.

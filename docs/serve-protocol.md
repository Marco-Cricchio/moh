# moh serve — RPC protocol v1

`moh serve` drives one moh session from any external program over the
process's stdin/stdout, as LF-delimited JSON lines. It is not a network
server: the transport is the process's stdio, so there is no auth
surface. The session persists to the same JSONL log as `moh run`, so a
session can move freely between `moh run --session`, `moh serve`, and
TUI resume.

## Framing

- Each message is exactly one line, terminated by `\n` (LF, 0x0A).
  Strict LF splitting is required — do not use generic line readers
  that also split on CR or NUL.
- Every message is a JSON object: `{ "type": "...", ... }`.
- Requests carry a monotonically increasing integer `id`; responses and
  errors echo it back so a caller can correlate. Server-initiated
  messages (`permission_request`) have their own id namespace, separate
  from request ids.
- stderr carries human-readable warnings only; it is never part of the
  protocol.

## Version negotiation

The first client message must be `initialize` carrying
`protocolVersion` (an omitted version defaults to 1, the version this
build speaks). A mismatching version is rejected with a typed `error`
(code `"version"`) carrying the supported version, and the session is
not created.

## Messages: client → moh

| type | fields | notes |
| --- | --- | --- |
| `initialize` | `protocolVersion`, optional `cwd`, `provider`, `allow[]`, `deny[]` | required first message; assemble the session. Launch flags are defaults the initialize body overrides. |
| `send` | `text` | start a turn. While a turn is in flight: typed error `busy` (queueing is the caller's job). |
| `permission_response` | `id` (of the pending `permission_request`), `decision`: `"yes" \| "always" \| "no"` | unblocks the turn. |
| `interrupt` | — | cancel the in-flight turn; the turn ends with a `result` of status `"cancelled"` (exit semantics mirror `moh run`'s 130). |
| `ping` | — | answered by `pong`. |

Anything else is rejected with a typed `error` — no passthrough of
arbitrary core calls. `id` is a caller-side correlation concern; moh
echoes it back verbatim and never validates its format. `ping` works
even before `initialize` (liveness probe).

## Messages: moh → client

| type | fields | notes |
| --- | --- | --- |
| `ready` | `protocolVersion`, `sessionFile` | sent after a successful `initialize`. |
| `event` | `event` (an `AgentEvent`) | the session's events forwarded verbatim: the protocol does not redefine event shapes, it rides the event log. |
| `permission_request` | `id`, `tool`, `args` | the turn blocks until the matching `permission_response` (or the process exits). |
| `result` | `id`, `status`, `exitCode`, optional `reason`, `message` | turn end; `exitCode` mirrors `moh run` (0 completed, 1 error, 130 cancelled). |
| `error` | `id` (optional), `code`, `message` | typed protocol errors; the connection survives. |
| `pong` | `id` (optional) | answer to `ping`. |

## Error codes

`version`, `not_initialized`, `already_initialized`, `bad_message`,
`bad_json`, `bad_rule`, `busy`, `unknown_permission`, `not_pending`,
`session`, `cassette`, `config`, `provider`, `send_failed`, `internal`.

## Semantics

- One in-flight turn at a time; a `send` while busy is a typed `busy`
  error.
- Events are emitted through the same sink `moh run` uses: resume-seeded
  events are not re-emitted, and ordering matches what lands in the
  session JSONL.
- A `permission_request` stays open until answered or the process exits;
  on shutdown pending asks are denied so the core gate never hangs.
- Clean stdin EOF disposes the session and exits 0.

## Client recipe

1. spawn `moh serve` with piped stdio;
2. send `initialize`, wait for `ready`;
3. `send` a prompt, read `event` messages as they stream;
4. if a `permission_request` arrives, respond with
   `permission_response`;
5. read the `result`, then repeat from 3 (or close stdin to exit).

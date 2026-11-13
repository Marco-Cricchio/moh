# ADR-0083: Opt-in peer channels for composed teams

Status: accepted · Date: 2026-11-13
Related: #1743; ADR-0055, ADR-0074, ADR-0031, ADR-0037

## Context

ADR-0074 rejected peer mailboxes in favor of coordinator-only steering.
Issue #1743 requests direct critique and deliberation without copying all
peer traffic through the coordinator's model context. This changes that
coordination decision explicitly, while preserving the eight principles.

## Decision

The team extension owns composition and opts in per `compose` with
`peerMessaging: true`. The additional `peer-messaging` capability changes the
manifest and requires renewed consent. Existing compositions remain off.
The core owns only a generic child-group transport: `ExtensionSpawnSpec`
may supply `peerGroup: { id, members }` under both capability grants.

Membership is immutable within the parent host, extension and group id.
A fresh composition gets a fresh id. Only requested child spawns have seats;
another session, extension, group, plain subagent or unstarted name cannot
be reached. The tool's sender is bound to its child, never supplied in args.
Children do not inherit the coordinator's contributed tools or `spawn`.
Explicit tool allow-lists must include `team_message`; permissions and
extension vetoes run through the normal tool path, including denials in yolo.

A send returns a receipt immediately. A per-recipient queue waits for its
current turn, then uses the host concurrency semaphore and the same child's
synthetic-turn entry. No turn is interrupted; reciprocal sends cannot wait
on each other's replies. Spawn and coordinator-steer results wait for accepted
exchanges to settle and return the latest answer. At most 64 messages of
8000 characters are accepted per group, bounding autonomous reply loops.

Peer content is explicitly marked untrusted task data, not a user or lead
instruction. It can inform a member's work but grants no authority. Each
accepted send writes a `subagent_message` with immutable sender/recipient,
group and message id plus full text; its completion writes a matching outcome.
The child log retains its synthetic message and normal turn events. The TUI
shows a compact preview/status. These chrome events stay out of the parent's
model transcript; no automatic coordinator turn is triggered per exchange.

Stop revokes group seats and cancels queued and active peer work. Disposal
drains cancelled deliveries and disposes their sessions. Group queues are
live-session state, like existing steering seats: replay shows the historical
audit trail, but never resumes delivery; a resumed session must compose anew.

## Consequences

The star-only/non-goal clauses of ADR-0055 and ADR-0074 are superseded only
for these opt-in channels. Cross-group messaging and grandchildren remain
excluded. Roles, scopes and team policy stay in the extension; provider calls,
permissions and logs stay in core. No digest subscription or separate mailbox
service is added: compact audit records and final member results serve the
current caller.

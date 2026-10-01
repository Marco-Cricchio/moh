# ADR-0058: Secret redaction is an unconditional invariant of the session log writer

Status: accepted · Date: 2026-10-01 · Issue: #1105
Related: ADR-0032 (extension event redaction heuristic), ADR-0049 (evidence-driven diagnostic corpus), ADR-0056 (runtime invariants precedent)

## Context

The session event log (`~/.moh/projects/<slug>/<id>.jsonl`) is append-only and writes events as they are. Redaction exists only at narrower seams — extension events (`redactPayload`, ADR-0032), telemetry summaries, the connection-test failure trail (#1092), auth by construction — none of which covers the conversational content: user messages, assistant replies, tool results. A secret that enters the context (an API key echoed by a tool, a credential in a URL, contents of a `secrets/**` file) is persisted in cleartext, permanently and without the user's knowledge.

The owner's mandate: **no secret may ever be written in cleartext to the session JSONL logs.** This is a hard invariant of the log writer, not a user-configurable option — the user cannot opt in to plaintext secrets any more than they can opt out of append-only.

## Decision

**Redaction happens at the single write seam, at persistence only.** Every event payload passes through a redaction pass before it hits disk; the in-memory context stays untouched, so in-session behavior never changes. The accepted consequence: resume, fork and compaction reconstruct from the persisted log, so a model resuming a session sees `[redacted]` where the original turn saw the secret. Redaction-at-write means the invariant cannot re-widen: an entry once written stays redacted.

**No opt-out exists.** No config key, flag, or consent can disable the pass.

**Fixed `[redacted]` placeholder.** No hash, no partial masking. Two occurrences of the same secret are indistinguishable in the log; simplicity and zero partial leakage outrank auditability.

**Both layers ship together:** secret-shaped *keys* wherever they appear in the event structure (extending the ADR-0032 heuristic), and high-confidence secret *patterns* in free text (`sk-…`, `Bearer …`, `AKIA…`, `ghp_…`, `xoxb-…`, `api_key=`/`token=` params and assignments, PEM private key blocks). Precision over recall — the patterns must not corrupt legitimate code in tool output — and the corpus grows on evidence through a bounded, deduplicated miss-report file in the user's moh dotdir, on the ADR-0049 precedent: a string that looks like a secret and passed unmasked leaves one diagnostic line, never its content.

**One shared redaction module** serves the session store and the existing narrower seams (extension events, telemetry) — one heuristic, not several.

**Forward-only.** Existing JSONL files are not rewritten; the invariant applies to new writes. Prior logs are documented as potentially unredacted.

## Consequences

- Derived artifacts (handoff files, exports, child-tail reads) inherit the invariant, since they read from the already-redacted log.
- The append hot path gains a scan; no catastrophic-backtracking regexes, bounded scan for oversized events, and a performance test pin the cost qualitatively.
- The category on #1105 is `enhancement`: the log behaved as designed; this adds a new guarantee.

# Path scope: `path:<glob>` authorizes the whole file-operation family

Under the host-tool seam (ADR-0064), the path scope decides what one `path:<glob>` grant authorizes when an extension asks the host to touch project files. The owner grills: one grant must read the same in the consent sentence, in the log and in the refusal.

## Decision

- **One scope, whole family**: `path:src/**` authorizes read, write, append, rename and delete under the glob. No read/write split: the scope is a parameter, not a menu — an extension that only needs reading is granted only read-only paths, and the consent sentence states the family ("may read and modify files under `src/**`, including create, rename, delete").
- **Glob dialect**: picomatch-style (`*`, `**`, `?`, `[...]`, `{a,b}`), resolved **relative to the project root**. An absolute path in a manifest capability is invalid and fails loudly at load — a capability naming outside-the-project targets is exactly what consent must not hide.
- **Real-filesystem containment**: `..` segments are rejected before resolution; symlinks are resolved and the **resolved target** is checked against the scope, so a symlink escaping `src/**` is an outside-scope refusal; case sensitivity follows the real filesystem (insensitive on APFS, sensitive on Linux).
- **The user's permission rules always win**: a granted `path:<glob>` is the owner's capability grant to an extension; a deny rule is the user's per-call decision for moh itself, and it negates the host-performed operation too. Consistent with "the owner grants, the runtime performs" — grant and rule are two different bits, and the rule is never widened by the grant.
- **Log**: `host_op { extension, op, path, outcome, bytes? }` — the path as **resolved** (the real target after symlinks), never as requested; `bytes` present only when the operation touches content. Secret redaction applies downstream.

Inherited from ADR-0064 without re-deciding: typed `{ ok: false, reason: "outside_scope" }` refusal, `host_refused` events, one check-scope module, revocation at next start, effect-sentence consent.

## Consequences

The `host:<domain>` arc cannot borrow the family trick as-is (an HTTP request has no read/write family), and the containment rule here — resolved target, real filesystem — is the precedent the credential arc's injection boundary should cite rather than reinvent.

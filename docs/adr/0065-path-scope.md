# Path scope: `path:<glob>` authorizes the whole file-operation family

Under the host-tool seam (ADR-0064), the path scope decides what one `path:<glob>` grant authorizes when an extension asks the host to touch project files. The owner grills: one grant must read the same in the consent sentence, in the log and in the refusal.

## Decision

- **One scope, whole family**: `path:src/**` authorizes read, write, append, rename and delete under the glob. The implemented `readlink` operation belongs to the read family: it reads symlink metadata, not file content, under the same scope and deny checks; it is not a separate power. No read/write split: the scope is a parameter, not a menu — an extension that only needs reading is granted only read-only paths, and the consent sentence states the family ("may read and modify files under `src/**`, including create, rename, delete").
- **Glob dialect**: picomatch-style (`*`, `**`, `?`, `[...]`, `{a,b}`), resolved **relative to the project root**. An absolute path in a manifest capability is invalid and fails loudly at load — a capability naming outside-the-project targets is exactly what consent must not hide.
- **Real-filesystem containment**: `..` segments are rejected before resolution; symlinks are resolved and the **resolved target** is checked against the scope, so a symlink escaping `src/**` is an outside-scope refusal; case sensitivity follows the real filesystem (insensitive on APFS, sensitive on Linux), **per path component and never by rewriting the glob**. Each component is answered by the filesystem holding its directory, and only when every component of the resolved path sits on an insensitive filesystem is a build-time case-insensitive match attempted: it expands the glob's *literal letters* to two-case classes (`s` → `[sS]`) and copies classes, ranges, negations, braces and escapes untouched — lowercasing the whole pattern turned `[!A-z]` into `[!a-z]`, a different set that admitted `_.txt`, and one leaf-directory answer applied to the whole path let a sensitive ancestor `SRC` match `src`. A mixed path (a sensitive ancestor above an insensitive mount, or the reverse) and any pattern carrying an escape stay exact-case: the conservative answer is the spelling the scope wrote, never a widened grant on a partial answer.
- **The user's permission rules always win**: a granted `path:<glob>` is the owner's capability grant to an extension; a deny rule is the user's per-call decision for moh itself, and it negates the host-performed operation too. Consistent with "the owner grants, the runtime performs" — grant and rule are two different bits, and the rule is never widened by the grant.
- **Log**: `host_op { extension, op, path, outcome, bytes? }` — the path as **resolved** (the real target after symlinks), never as requested; `bytes` present only when the operation touches content. Secret redaction applies downstream.

Inherited from ADR-0064 without re-deciding: typed `{ ok: false, reason: "outside_scope" }` refusal, `host_refused` events, one check-scope module, revocation at next start, effect-sentence consent.

## Consequences

The `host:<domain>` arc cannot borrow the family trick as-is (an HTTP request has no read/write family), and the containment rule here — resolved target, real filesystem — is the precedent the credential arc's injection boundary should cite rather than reinvent.

## Amendment — ablation (2026-10-19)

The decision above is unchanged. This amendment records where the `path:` scope lives after #1424 (S3.2, delivered by #1571), the prerequisite recorded for this ADR. It adds no decision.

### What changed

- The `path:` grammar, validation, check and effect sentence are in `packages/core/src/scopes.ts`: `validatePathScope`, `validatePathGlob`, `checkPathScope` (file-local), `matchesPathScopes`, and the `path` descriptor of the scope table (`prefix`, `validate`, `check`, `effectSentence`). The table and its descriptors are new in #1571. Before #1571 the grammar, validation and check were in `packages/core/src/host-scope.ts`, and the effect sentence in `packages/core/src/scope-effect.ts`.
- The line "one check-scope module", inherited from ADR-0064, now reads as `checkScope` in `scopes.ts`, which looks up the descriptor for the request kind; the module `check-scope.ts` no longer exists. The ADR-0064 amendment records that change for all scope kinds.
- The glob and filesystem algorithms stay in `packages/core/src/host-scope.ts`: `globMatches`, `foldGlobCase`, `resolveReal` and `caseInsensitiveAt` are exported from there. `scopes.ts` imports `globMatches`, `resolveReal` and `caseInsensitiveAt`; `foldGlobCase` is called by `globMatches` inside `host-scope.ts`. `export` was added to `globMatches`, `resolveReal` and `caseInsensitiveAt`; `foldGlobCase` was already exported.
- `export` was dropped from `checkPathScope`, `pathScopeGlob` and `type PathScopeCheck`; all three are now file-local to `scopes.ts`.

### What stays

- The rules in the Decision section are unchanged: the function bodies of `validatePathScope`, `validatePathGlob`, `checkPathScope`, `matchesPathScopes`, `pathScopeGlob`, `globMatches`, `foldGlobCase`, `resolveReal` and `caseInsensitiveAt` are identical before and after #1571.
- The refusal reasons are unchanged. `checkPathScope` returns `outside_scope`, `invalid_path` or `denied`; load-time validation returns `malformed` or `absolute`. The inherited line above names `outside_scope`, which is one of the three check reasons for `path:`.
- The effect sentence for `path:<glob>` is unchanged: "may read and modify files under `<glob>`, including create, rename, delete".
- The `host_op` log is not touched by #1571: in `packages/core/src/extensions.ts`, which binds the user's deny rules and writes `host_op`, #1571 changes only import lines.

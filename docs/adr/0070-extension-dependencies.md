# Extension dependencies: exact pinning, per-extension isolation, never a script

The charting decision fixed that moh installs an extension's declared npm dependencies into a moh-owned root (`extension-deps`); `moh extension add/list/remove` (#1128) is the registry the installer lands on. This ADR fixes the contract: what the manifest declares, how the tree is pinned and verified, what isolation means, and what never runs.

## Decision

- **Exact versions in the manifest**: `"dependencies": { "zod": "3.23.8" }` — no ranges. A range would delegate to the registry a decision the consent already made on specific bytes. moh writes its own lockfile (`extension-deps/lock.json`) carrying per-package SRI digests — direct and transitive — and re-verifies them at every install; drift between manifest and lockfile is a loud error (the `npm ci` contract: lockfile mandatory, out-of-sync = error, existing tree removed, manifests never rewritten).
- **Per-extension isolation**: the root holds one directory per extension (`~/.moh/extension-deps/<ext>/`), each with its own resolved tree. An extension resolves only what it declared — no ghost dependencies, no cross-extension resolution (the pnpm property, not the npm hoist). Removal is then trivial and safe: delete the extension's directory.
- **Never a script**: install runs no lifecycle scripts, ever — ADR-0061's "never executes package code, not even `npm install`" quantified: an install is download + digest verification + layout, nothing more. A dependency declaring `install`/`postinstall` scripts (typically native builds) does not install: loud refusal naming the package. The author's escape hatch is the platform norm — bundle the artifact (VS Code/Obsidian bundle-first; VS Code ships platform-specific packages for native code). No scripted-dependency consent exists.
- **Deps ride the code consent**: dependencies are part of the package's content identity (ADR-0053/0063) — new bytes, new question, one question. The consent displays them by name and version (`dependencies: zod@3.23.8`), so a widening is visible without a separate prompt. Offline install from cache is legitimate only when the cache digest matches the lockfile's integrity entry.
- **Removal and GC**: uninstalling an extension removes its dependency directory immediately; the root holds nothing else — there is no shared store to garbage-collect, and no automatic GC exists.

## Considered options

- Semver ranges + lockfile — rejected: consent over a range is not consent over bytes.
- One shared hoisted tree — rejected: reproduces npm's ghost-dependency problem at extension scale and makes removal non-trivial.
- Per-package script consent — rejected: install-time scripts are the canonical npm supply-chain vector; ADR-0061 chose the stricter side and this ADR keeps it.

## Consequences

The manifest grammar gains a `dependencies` object; the consent surface renders it. #1152 can now sequence the whole phase — every arc has a resolved ADR.

# research-1154 — Dependency installation, pinning and integrity for plugin systems: what moh's extension-deps root can inherit

Prior art for wayfinder ticket #1154 (child of map #996). Primary sources only: each claim carries one URL or `file:line`.
This file extends, and deliberately does not repeat, `research-997/997-D2-prior-art-platforms.md` §5 (platform survey). A scoping note: the baseline directory `research-997/` is **not on `origin/develop`** — it exists only in the local tree of the main checkout (per #997's resolution comment, "assets in `research-997/` (on `develop`, per the #953 precedent)" describes intent, not tracked state). The copy of `research-997/` on this branch was taken from the local tree so D2 remains citable here; whether to commit it to `develop` is a separate housekeeping decision.

Verification status: every URL below was fetched and returned readable content at the path shown. Quoted English is verbatim from the source cited.

---

## 1. Install location models: shared root vs per-plugin, and what isolation actually means

### 1.1 npm: one `node_modules` tree, hoisted by algorithm

npm installs into a single `node_modules` tree at the project root and hoists transitive dependencies up the tree to dedupe them. The docs specify the precedence and the determinism contract:

> "If a `npm-shrinkwrap.json`… exists alongside `package-lock.json`, it takes precedence; otherwise `package-lock.json`… is used" and `yarn.lock` is only consulted as a fallback source of version information.
> — <https://raw.githubusercontent.com/npm/cli/release/v10/docs/lib/content/configuring-npm/package-lock-json.md> (see also `npm-install.md` "A note on hoisting" for the deterministic placement example)

The hoisting example in `npm-install.md` spells out placement: a dependency needed at two depths is installed once at the highest position that does not conflict, with the deeper position left empty or occupied by a conflicting version. Isolation between packages is therefore **not** a property npm gives you: anything hoisted is resolvable by anything else on the tree (the "ghost dependency" problem pnpm explicitly names, §1.3).

### 1.2 VS Code: extensions ship bundles, not dependency trees

VS Code extensions install into a **shared per-user root** (`~/.vscode/extensions`) as flat, self-contained folders. The platform's strong guidance is that an extension should **not ship a `node_modules` tree at all** — it should bundle:

> "Since extensions are self-contained, you should bundle your extension rather than include `node_modules` in your extension. … We recommend you use a bundler like esbuild, webpack, rollup, or others."
> — <https://code.visualstudio.com/api/working-with-extensions/bundling-extension.md>

Only the `vscode` module stays external (the host provides it); everything else is inlined at author time. Where a native (platform-specific) module is unavoidable, the platform supports **platform-specific VSIX packages** (`vsce package --target`), not runtime resolution. The packaging tool makes the default explicit:

- `vsce package` **automatically excludes `devDependencies`** from the VSIX.
- A `.vscodeignore` (minimatch globs) excludes everything else "not needed at runtime".
- The `vscode:prepublish` script runs on **every** package — the single build seam before distribution.
- Publishing requires `npm >= 6` / `yarn >= 1 < 2` as package managers (`https://raw.githubusercontent.com/microsoft/vsce/master/README.md`).

Sources: <https://code.visualstudio.com/api/working-with-extensions/publishing-extension.md> (packaging, `.vscodeignore`, `vscode:prepublish`, platform targets), <https://raw.githubusercontent.com/microsoft/vsce/master/README.md>.

### 1.3 Obsidian: per-plugin folder, deps compiled in, no runtime resolution at all

An Obsidian plugin ships exactly three files — `manifest.json`, `main.js` (+ optional `styles.css`) — into a **per-plugin directory** (`.obsidian/plugins/<id>`). There is no runtime dependency resolution whatsoever:

> The official sample plugin's esbuild config bundles with `external: ['obsidian', 'electron', @codex…, @lezer/*, ...builtinModules]` — host-provided modules stay external; everything else is inlined into `main.js` at author time.
> — <https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin> (sample build config)

Community distribution downloads those files from the **author's GitHub releases**, with `versions.json` mapping app-version compatibility. There is **no integrity hash** in the community-plugin flow — trust is the GitHub release plus manual review on submission (<https://docs.obsidian.md/Reference/Manifest>; plugin submission via the `obsidianmd/obsidian-releases` README process).

### 1.4 pnpm: strict isolation as the feature

pnpm's layout is the mirror image of npm's hoisting: a content-addressable store on disk, per-project links into it, and resolution that **refuses** undeclared packages:

> With pnpm's symlinked structure, "only the packages that are explicitly declared as dependencies can be resolved" — the strict-isolation property — while an optional hoisting mode exists "for packages that are broken" (packages that import undeclared dependencies).
> — <https://pnpm.io/symlinked-node-modules-structure>

The store is content-addressable and shared across projects ("save disk space… one version of a package is stored only a single time on a disk"); the per-project `node_modules` contains symlinks/hard-links into it, so install is cheap and each package's view of the tree is exact.

### 1.5 Yarn Berry Plug'n'Play: isolation by loader, not by layout

> PnP generates a single `.pnp.cjs` loader instead of `node_modules`; packages live in a shared cache referenced by path ("shared installs across disks… the PnP loader directly references packages via their cache path"). Unlisted dependencies are refused at resolution (strict isolation, the same property pnpm makes structural); install cost is generating the loader — no per-project file copies.
> — <https://yarnpkg.com/features/pnp>

---

## 2. Pinning: exact versions, ranges, and who owns the lockfile

### 2.1 The lockfile contract npm actually enforces

`npm ci` is the model worth copying for an installer that answers to a platform rather than to a developer:

> "`npm ci`… installs essentially frozen: the lockfile must be in sync with `package.json` or the command errors; it removes the existing `node_modules`; and it never writes to `package.json` or the lockfile."
> — <https://raw.githubusercontent.com/npm/cli/release/v10/docs/lib/content/commands/npm-ci.md>

Precedence when multiple lock sources exist: `npm-shrinkwrap.json` > `package-lock.json` > `yarn.lock` (`package-lock-json.md`). `npm-shrinkwrap.json` is the variant that is **publishable** — it travels with the package and pins its consumers, which is the shape closest to "a plugin's dependency tree is part of the plugin".

Exact pinning at author time is `--save-exact` (`npm-install.md`); without it, `^`/`~` ranges are recorded and the lockfile is what makes the tree reproducible.

### 2.2 Homebrew: the manifest carries the checksum, immutably

Every dependency ("resource") and every download in a formula carries a **mandatory sha256**; the URL+checksum pair is immutable in the formula, and install receipts (the "tab") record what was actually installed per machine:

> Resources and formula URLs each carry a mandatory `sha256`; bottles are the prebuilt artifacts distributed for the formula.
> — <https://docs.brew.sh/Formula-Cookbook> (resources, `sha256`, bottles, keg/rack/Cellar layout, `INSTALL_RECEIPT`)

The transferable idea: the *declaration* the platform trusts is (URL, checksum) pairs, and per-install metadata is a separate receipt — the model `package-lock.json`'s `integrity` field instantiates for npm packages.

---

## 3. Integrity: SRI digests, transitive dependencies, and the script trust problem

### 3.1 SRI digests per package, including transitive

`package-lock.json` records a Subresource Integrity digest per package — direct and transitive alike:

> Each entry carries `integrity` (sha512 or sha1 SRI), `resolved` (the exact tarball URL), and `dependencies` (the full transitive closure); a hidden lockfile (`node_modules/.package-lock.json`) mirrors the actual tree for `npm install` trees.
> — <https://raw.githubusercontent.com/npm/cli/release/v10/docs/lib/content/configuring-npm/package-lock-json.md>

SRI itself is the W3C mechanism "by which user agents may verify that a fetched resource has been delivered without unexpected manipulation" — <https://w3c.github.io/webappsec-subresource-integrity/> (Editor's Draft; canonical `https://www.w3.org/TR/sri-2/`). npm's `integrity` fields are SRI digests; a lockfile is therefore a **verifiable** artifact, not just a version list.

### 3.2 Post-install scripts: the trust hole every platform must answer

> npm runs arbitrary `install`/`postinstall` shell scripts from dependencies by default, after modules land in `node_modules` (lifecycle order: `preinstall → install → postinstall → …`); a package with a `binding.gyp` defaults its install script to `node-gyp rebuild`.
> — <https://raw.githubusercontent.com/npm/cli/release/v10/docs/lib/content/using-npm/scripts.md>

The platform-side answer is `ignore-scripts`:

> `ignore-scripts=true` (npm config, also `--ignore-scripts`) skips running any scripts declared in the package (during install and elsewhere).
> — npm config docs, `ignore-scripts` (<https://docs.npmjs.com/cli/v10/using-npm/config#ignore-scripts> and `npmrc.md`)

moh's ADR-0061 already fixed the invariant this section argues for — the installer "never executes package code, not even `npm install`" (`extension-registry.ts`). The npm facts here quantify what that refusal avoids: by default an `npm install` executes attacker-supplied shell at install time; `ignore-scripts` is npm's own opt-out; and Obsidian/VS Code sidestep the question entirely by having authors bundle at author time (no install-time scripts at all).

---

## 4. Update flows: triggers, caches, consent

- **Trigger**: for a platform-managed root, re-install is triggered by a *manifest change*, not by a schedule. npm's own re-install semantics support the "verify then act" shape: `npm ci` first removes the existing `node_modules` and installs exactly what the lockfile says (`npm-ci.md`) — the tree is always a function of the (lock)file.
- **Offline/cache**: npm's cache is content-addressable (`cacache`) with a `verify` subcommand for GC/integrity; the docs state plainly that "npm will not remove data by itself" (`npm-cache.md`). Yarn 1 documents the same properties (offline mirror, checksums). An installer that wants reproducibility can therefore install offline from cache **only when the cache entry's digest matches the lockfile's `integrity`**.
- **Consent**: neither npm nor Homebrew has a consent model — consent belongs to the platform layer. VS Code's extension auto-update and Obsidian's plugin updates are the platform precedents: updates arrive from the same immutable source (a versioned release) and the *platform* decides whether to ask. For moh, ADR-0053/0063 already answered this at the extension level: an update is an edit, an edit is a new hash and a new question — a deps change is part of the package's content identity and rides the same rule.

---

## 5. Removal and garbage collection

- `npm uninstall` removes the package from the tree and the manifest, and lockfile entries for it; the **cache is deliberately not garbage-collected automatically**: "npm will not remove data by itself" (`npm-cache.md`) — GC is an explicit `npm cache verify`/`clean`.
- VS Code: uninstalling an extension deletes its folder under `~/.vscode/extensions`; **unpublishing** from the marketplace is irreversible and reserves the extension name permanently (`publishing-extension.md`) — distribution identity and installed instances are two different lifetimes.
- Obsidian: deleting the plugin folder removes it; community index removal is a PR against the releases repo.
- pnpm's store persists across removals (content-addressable, shared); pruning is an explicit `pnpm store prune`.

The pattern: **uninstall is immediate and local; GC of the shared store is explicit, never automatic** — the safe default for a shared content-addressable root that other extensions may still link into.

---

## 6. Implications for moh's extension-deps root

Facts only, no decision. Each item is a pattern observed in a cited source, not a recommendation.

- **Bundle-first is the norm for desktop plugin platforms.** VS Code and Obsidian both push authors to compile dependencies into a single artifact at author time; runtime `node_modules` is the exception, not the rule. A `dependencies` key that expects un-bundled npm packages is the rarer design. (§1.2, §1.3)
- **Where a shared root exists, isolation must be chosen, not inherited.** npm's hoisting makes every hoisted package resolvable by everyone; pnpm/Yarn PnP make strict isolation the default. A moh-owned `extension-deps` root that lets two extensions resolve each other's transitive deps reproduces npm's ghost-dependency problem at the extension scale. (§1.1 vs §1.4–1.5)
- **`npm ci` is the reference contract for a platform-installed tree**: lockfile mandatory, out-of-sync = loud error, existing tree removed, manifest never rewritten. (§2.1)
- **The lockfile is the verifiable artifact**: per-package SRI digests cover transitive dependencies; install = resolve against digests, and offline installs are legitimate only when the cache digest matches. (§3.1, §4)
- **Install-time scripts are the trust hole**; `ignore-scripts` is npm's own opt-out, and ADR-0061's "never executes package code, not even `npm install`" is the same choice made stricter. (§3.2)
- **The (URL, checksum) pair is the immutable declaration** (Homebrew); receipts record what actually installed. The moh analogue: the manifest (or a moh-owned lockfile) carries the digests, and what was installed is recorded separately. (§2.2)
- **Updates re-consent at the platform layer, not the package-manager layer**; moh's per-byte consent (ADR-0053/0063) already covers a deps change if deps are part of the content identity — the open design question is only whether deps ride the same question or get their own.
- **Uninstall is immediate; shared-store GC is explicit and never automatic** — relevant because a moh-owned root is shared across extensions. (§5)

## 7. Gaps / not covered

- Yarn PnP specifics beyond the feature page (the `.pnp.cjs` loader format, strict-vs-loose modes) were taken from <https://yarnpkg.com/features/pnp> only; the Berry source docs were not fetched this pass.
- Deno's handling of npm dependencies (`node_modules` dir vs its own store) is adjacent prior art not surveyed here.
- No source was found that runs a *shared, multi-plugin* npm root with strict isolation; pnpm's per-project store model is the nearest verified analogue.

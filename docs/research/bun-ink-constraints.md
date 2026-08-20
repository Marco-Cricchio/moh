# Research: Bun `--compile` + Ink constraints for moh

Ticket: RESEARCH TICKET #4 · Date: 2025-08-20 · Bun tested: **1.2.19**, Ink: latest (yoga-layout).

## TL;DR

- `bun build --compile` works well, including a full Ink app, and can **load external `.ts`/`.tsx` extensions at runtime via `await import(path)`** — but resolution of *their* dependencies falls back to the user's `node_modules` / cwd.
- The npm name **`moh` is taken** (`moh@0.0.1`, published >1y ago by `ole3021`). Not available; scoped name (`@marcocricchio/moh`) or another name needed.
- Binary size is ~**56 MB minimum** (Bun runtime dominates); an Ink app ≈ 58 MB. Unavoidable with `--compile`.
- `--minify --bytecode` currently **fails on Ink** (top-level await in `yoga-layout`/ink build output).

## 1. `bun build --compile` + runtime-loaded extensions

**Works:** In a compiled binary, `await import(absolutePath)` of a file **not bundled at build time** loads it from disk at runtime; Bun transpiles TS/TSX on the fly (the runtime transpiler ships in the binary). Verified empirically: compiled `bin-loader` imported `ext.ts` from disk and executed it (`dynamic import ok: 42`).

**Works:** An external extension importing npm packages (`ink`, `react`) also loaded at runtime in the test env — but resolution happens from **cwd's `node_modules`**, not from the binary. Implication: user extensions that depend on npm packages need those packages installed next to the extension, OR moh must expose its bundled APIs to extensions (e.g. pass `render`/`Text` via an injection API rather than letting extensions import `ink` themselves).

**Caveats:**
- Module-not-found errors surface as `Cannot find module '<path>' from '/$bunfs/root/...'` — the virtual bundle FS leaks into error messages.
- Extensions must be plain JS/TS; native `.node` addons inside external extensions are not bundled and would need to resolve from disk (Bun docs support embedding `.node` only for build-time-known imports).
- `--no-bundle` is unsupported with `--compile`: Bun always bundles the entry. (Source: https://bun.com/docs/bundler/executables — "Unsupported CLI arguments".)
- `Bun.isStandaloneExecutable` detects compiled mode; `import.meta.dir` points into the virtual FS (`/$bunfs/root`), so extension discovery must use real paths (`process.argv[1]` dir, `$HOME`, etc.), never `import.meta.dir` for user data.
- `BUN_BE_BUN=1 ./binary` turns any compiled binary into the **full `bun` CLI** (verified: `--version` → 1.2.19). This is an official escape hatch: moh could shell out to *itself* to `bun install` dependencies for extensions without requiring a separate Bun install. (Docs: "Act as the Bun CLI", Bun ≥1.2.16.)

## 2. Ink inside a compiled binary

**Works.** A minimal Ink app (`render(<App/>)`) compiled and ran correctly (macOS arm64, Bun 1.2.19). Verified empirically.

**Quirk:** Ink's `devtools.js` imports `react-devtools-core` unconditionally; if not installed, `bun build` fails with *Could not resolve: "react-devtools-core"*. Fix: `bun add react-devtools-core` (dev dep) or mark it external. This is a known Ink packaging quirk, not a Bun bug.

**Broken:** `bun build --compile --minify --bytecode` fails on current Ink — parse errors on top-level `await` in `yoga-layout/dist/src/index.js` and `ink/build/reconciler.js` ("await can only be used inside an async function"). So **skip `--bytecode`** for an Ink app until upstream/Bun fix it. Plain `--minify` is fine.

## 3. Binary size (measured, Bun 1.2.19, macOS arm64)

| Artifact | Size |
|---|---|
| `console.log("hi")` compiled | **56 MB** |
| Loader (dynamic-import harness) | 56 MB |
| Ink app | **58 MB** |

The Bun runtime is the floor (~56 MB); app code adds little. Bun docs acknowledge: "Bun's binary is still way too big and we need to make it smaller." Mitigations: `--minify` (marginal), per-target single binaries, UPX (unsupported/risky). Plan around ~55–60 MB per platform artifact.

## 4. npm package vs binary distribution

Both are viable and complementary:

- **npm package**: smallest download (few hundred KB), runs on any Bun (and likely Node for the non-TUI parts if code is Node-compatible); no 56 MB per-platform matrix; `bunx moh` works. Requires Bun installed for TS source runs — or ship plain JS.
- **Compiled binaries**: zero runtime deps, fast startup (Bun moves transpile to build time), codesign for macOS (docs recommend JIT entitlements), Windows icon/console flags, cross-compile targets: darwin-x64/arm64, linux-x64/arm64 (+musl), windows-x64/arm64.
- **Hybrid (recommended)**: publish npm package as primary + attach compiled binaries to GitHub Releases (and/or `BUN_BE_BUN=1` trick to self-manage). Distribution matrix cost: 6+ binaries × ~57 MB.

## 5. User skill/extension installation

Feasible pattern given the above:

1. Extensions live in a real directory (e.g. `~/.moh/skills/<name>/skill.ts`), discovered via filesystem scan (not `import.meta.dir`).
2. Load with `await import(path)` — works in compiled binaries (verified).
3. If an extension needs npm deps: either (a) ship a `skills/package.json` and run `bun install` via `BUN_BE_BUN=1 <self>` — no separate Bun needed; or (b) require extensions to use only APIs moh injects (in-process `ink`, `fs`, etc.), keeping them dependency-free.
4. Vendor/3rd-party skill registries are just git/npm refs written into that directory.

## 6. npm name `moh`

**Taken.** `npm view moh` → `moh@0.0.1`, MIT, 0 deps, 1 version, published **over a year ago** by `ole3021` (github.com/ole3021/moh), no activity since. Options: contact maintainer (stale, single 0.0.1 release), pick a scoped name (`@<scope>/moh`), or rename the CLI (binary name can still be `moh` via `--outfile moh` / npm `bin` field even under a scoped package).

## Sources

- Bun docs — Single-file executable: https://bun.com/docs/bundler/executables (targets, embed assets, `--bytecode`, unsupported flags, `BUN_BE_BUN`, codesign, size comment)
- Ink repo: https://github.com/vadimdemedes/ink (devtools-core import in `build/devtools.js`)
- npm registry: `npm view moh` (2025-08-20)
- Empirical tests: /tmp/mohres, Bun 1.2.19, macOS arm64 (compile+run of Ink app; runtime `import()` of external TS; sizes; bytecode failure; `BUN_BE_BUN`)

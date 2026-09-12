# ADR-0025: MPM module-based language resolution and the per-language project-file seam

Status: accepted · Date: 2026-09-12 · Issue: #640

## Context

MPM's extraction contract (#615) emits only **directly verifiable** relations:
an emitted `imports` edge must point at a real workspace file proven from the
source text. Tier A (#639) covered languages where the import specifier *is* a
path (or resolves to one with a single well-known anchor like `go.mod`).

Tier B languages — Rust, C#, Swift, Kotlin — reference **modules and
namespaces**, not files. `use crate::store::Open`, `using App.Services`,
`import AppCore.Networking` name no file. Without extra structure these
languages would map with symbols but zero relations, and the "useful supported
coverage" MPM promises would be empty for them.

The extra structure exists: **project files** (`Cargo.toml`, `*.csproj`,
`Package.swift`, Gradle/Maven build files). They are the language-owned
mapping from module space to file space. Owner decision on #640: the
per-language project-file resolution mechanism is built **once, here**, and
the config capabilities deferred from #639 (`pyproject.toml`, `go.mod
replace`, `Makefile`, `composer.json`) may ride along **only if** the
mechanism generalizes to them without per-language special cases.

## Decision

1. **A shared project-file anchor seam, not per-language hacks.** Tier B
   capabilities resolve modules through one mechanism: find the *nearest
   project file* by walking up from the importing file (same rule Go already
   uses for `go.mod`), read from it only the few provable facts the language
   needs, and resolve against the discovered file set. A capability that
   cannot state its resolution in this shape does not ship.

2. **Resolution is confined to what the project file literally states.**
   - Rust: `mod name;` → `<dir>/name.rs` or `<dir>/name/mod.rs` (the compiler's
     own rule, purely local), **and only when a sibling file actually declares
     the module** — a file on disk that no `mod` statement declares is never a
     target. `use crate::<path>` resolves from the crate root (the
     `Cargo.toml`'s `src/`, containing `main.rs`/`lib.rs`), walking only
     declared modules; the final path segment may name an item inside a module
     file, in which case the module file is the target. `Cargo.toml` path
     dependencies (`foo = { path = "crates/foo" }`) emit `config-links` edges
     to the dep crate's `src/lib.rs`/`src/main.rs`.
   - C#: `using X.Y` / `namespace X.Y` resolve to a file only when a
     `*.csproj` exists up the tree **and exactly one** discovered `.cs` file
     declares that namespace (the declaring file is re-read to verify —
     literal text, not inference); ambiguous or anchor-less → silent.
   - Swift: `import Module` resolves only when the nearest `Package.swift`
     declares that target (line-anchored, comments skipped, `path:` overrides
     honored) and the target's source directory maps literally under
     `Sources/<Name>/`; otherwise silent.
   - Kotlin: `import a.b.C` / `package a.b` resolve only when a Gradle/Maven
     build file exists up the tree and the dotted path pins a unique `.kt`
     file under a literal source-set root (`src/main/kotlin`, …); otherwise
     silent.

3. **Unprovable stays silent — the rule does not bend.** Where the project
   file, convention, and source text do not jointly pin down a single target
   file, no relation is emitted. Symbols always map (coverage); relations
   never get approximated. This is the same partial-support-silence contract
   as #615; Tier B adds no exception, it adds *anchors* that make more
   relations provable.

4. **Deferred Tier A config capabilities ride along only if literal.**
   `go.mod replace` directives and `composer.json` PSR-4 maps are literal
   module→path statements and fit the seam; they are **out of scope** for
   this PR unless trivially expressible in the same anchor shape. `pyproject.toml`
   and `Makefile` add no file-level relations the source text doesn't already
   prove — they stay deferred indefinitely.

## Consequences

- `MpmLanguageCapability` gains no new required members: the existing
  `resolveTarget(via, fromPath, known, root)` seam from #615 is sufficient —
  Tier B resolvers read project files inside it. The seam is the whole
  extension point (see ADR-0004: no new public exports).
- Extraction cost: project-file anchors are read fresh per resolution (no
  cross-file state, extraction-order independent); Rust additionally reads
  the `.rs` files of the single directory being descended into to verify
  mod declarations. No source content is retained — only paths, hashes,
  symbols, and relations.
- Fixture corpora grow per language with both halves of the contract: what
  resolves, and what stays silent *because* the anchor is absent.
- A future dynamic/analysis-based extractor (LLM-assisted, compiler-backed)
  would be a new capability tier with its own ADR; nothing here pre-provisions it.

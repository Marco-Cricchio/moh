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
     own rule, purely local); `use crate::<path>` resolves only when the
     crate-rooted path lands on a module-declared file; `Cargo.toml` path
     dependencies (`foo = { path = "vendor/foo" }`) add cross-crate targets.
   - C#: `using X.Y` resolves to a file only when the containing `*.csproj`'s
     root namespace + folder layout make the mapping literal; otherwise
     silent.
   - Swift: `import Module` resolves only when the nearest `Package.swift`
     declares that target and the module name equals the target directory's
     sources; otherwise silent.
   - Kotlin: file relations only where the Gradle/Maven source-set layout
     makes a package-to-directory mapping literal; otherwise silent.

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
- Extraction cost grows by a small bounded read of project files per
  resolution, not per file: resolvers memoize nothing across calls, but the
  walk-up stops at the first anchor and the anchor set is sparse.
- Fixture corpora grow per language with both halves of the contract: what
  resolves, and what stays silent *because* the anchor is absent.
- A future dynamic/analysis-based extractor (LLM-assisted, compiler-backed)
  would be a new capability tier with its own ADR; nothing here pre-provisions it.

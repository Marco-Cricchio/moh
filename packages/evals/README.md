# @moh/evals

First-party eval harness (#524): repeatable task suites run against moh's real
headless path (`moh run --cassette` semantics) with deterministic, mechanical
scoring. No live providers — cassettes script the model side, so runs are free
and reproducible.

## Running

```sh
bun packages/evals/run.ts                    # all suites
bun packages/evals/run.ts --suite tools      # one suite
bun packages/evals/run.ts --filter resume    # cases whose name matches
bun packages/evals/run.ts --json             # machine-readable output (CI)
```

Exit code is non-zero when any assertion fails, including when a suite's
pinned pass count (`suites/<name>.suite.json`) no longer holds — a change that
breaks or alters case outcomes fails loudly.

## Case format

One JSON file per case in `suites/<suite>/<case>.json`. A case is data only —
no code. Two shapes:

### Single-run case

```jsonc
{
  "prompt": "the user turn",
  "cassette": [ /* MockProvider turns (deltas/finish/toolCalls) or a file path */ ],
  "permissions": { "allow": ["write:docs/**"], "deny": ["bash"] },
  "setup": { "seed.txt": "seeded content" },   // files created in the temp project root
  "assertions": { /* see below */ }
}
```

### Multi-run case (resume / fork)

```jsonc
{
  "steps": [
    { "prompt": "...", "cassette": [...], "assertions": {...} },                 // starts a session
    { "prompt": "...", "cassette": [...], "fork": true, "assertions": {...} }    // resumes; fork: true forks
  ],
  "sessionAssertions": {
    "toolCallOrder": ["read", "read"],          // ordered subset over the whole log
    "chromeEvents": ["session_resumed"],        // must appear
    "absentChromeEvents": ["permission_denied"] // must not appear
  }
}
```

### Assertions

| key | meaning |
| --- | --- |
| `toolCalls` | ordered subset-match on tool names, each with optional `argsInclude` (substrings of the JSON-serialized args) |
| `files` | expected files after the run: `path`, optional exact `content`, optional `absent: true` |
| `denials` | expected `permission_denied` events: `tool` + `reason` (`rule`, `headless`, `user`, `extension`); a failed `tool_result` must accompany them |
| `exitCode` | expected run exit code (default 0) |
| `forbiddenTools` | tool names that must not appear in any `tool_call` |
| `forbiddenPaths` | path fragments that must not be touched by write/edit calls |
| `replyIncludes` | substrings required in the assistant reply text |

## CI

A GitHub Actions job runs the harness on PRs touching `packages/core` or
`packages/cli` (all mock-backed, cheap). Add cases by dropping JSON files into
a suite directory and updating that suite's `expectedPass` pin.

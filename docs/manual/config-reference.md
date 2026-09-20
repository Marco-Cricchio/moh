# Config reference

Generated from the config schema and the user-config guardian's known
sections — never edit directly
(`bun packages/core/scripts/gen-manual-docs.ts` regenerates it).

moh reads two files:

- **`moh.json`** — the project config, at the project root. A missing or
  empty file is the empty config (moh works zero-config with the mock
  provider); an invalid one fails loudly.
- **`~/.moh/config`** — the user config, owned by the guardian (every
  read/write goes through it; unknown sections always survive writes).

## moh.json

```json
{
  "provider": "endpoint/model-id",
  "endpoints": [ { "name": "...", "type": "anthropic", "apiKey": "...", "baseUrl": "...", "defaultModel": "...", "fallbackEligible": true, "auth": { "kind": "subscription" }, "capabilities": { "caching": true, "parallelToolCalls": true, "multimodal": true, "thinking": { "format": "anthropic-effort", "levels": ["high"] }, "thinkingModels": { "model-id": { "format": "anthropic-effort", "levels": ["off", "high"] } } } } ],
  "permissions": {
    "overrides": {
      "tools": { "mcp__github__create_issue": "allow" },
      "bashAllow": [["git", "status"]],
      "bashDeny": [["git", "push"]],
      "pathAllow": ["src/**"],
      "pathDeny": ["secrets/**"]
    }
  },
  "extensions": ["./extensions/my-extension.ts"],
  "mcpServers": {
    "github": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "K": "V" } },
    "docs": { "type": "http", "url": "https://example.com/mcp", "headers": { "K": "V" } }
  },
  "agents": {
    "my-agent": { "name": "my-agent", "description": "...", "systemPrompt": "...", "allowedTools": ["bash"], "model": "...", "provider": "...", "maxIterations": 20, "context": "..." }
  },
  "memory": { "enabled": true, "intervalTurns": 5, "budgetTokens": 2000 },
  "handoff": { "transport": "gist", "onboarding": "dismissed" },
  "skillRouting": { "labels": { "my-label": { "command": "/implement", "priority": 1, "disabled": false, "suffix": "..." } } },
  "mpm": { "enabled": true, "quota": { "maxFiles": 5000, "maxTotalBytes": 33554432 }, "exclude": ["legacy/**"] },
  "browser": { "enabled": true, "headless": true, "allowedHosts": ["192.168.1.1"] },
  "maxIterations": 50
}
```

All keys are optional. Notes:

- `provider` — default route: `"mock"`, a custom registered id, or
  `"endpoint/model-id"` (or a bare `"endpoint"` using its defaultModel).
- `endpoints[].type` — built-in `"anthropic" | "openai" | "google" |
  "github-copilot" | "openrouter" | "kimi-coding" | "xai" |
  "deepseek" | "groq" | "cerebras" | "nvidia-nim" | "together" |
  "fireworks" | "huggingface" | "mistral" | "moonshot" | "minimax" |
  "zai" | "qwen" | "xiaomi-mimo" | "vercel-ai-gateway" |
  "cloudflare-ai-gateway" | "baseten" | "openai-compat"`, or a custom id
  registered via `registerProvider`.
- `endpoints[].apiKey` — falls back to the env var
  `MOH_ENDPOINT_<NAME>_API_KEY`, then a first-party profile's documented provider environment variable; prefer the guardian-stored key from the wizard over inlining secrets in moh.json.
- `endpoints[].auth` — absent = api-key; `{ "kind": "subscription" }`
  uses the plan's OAuth tokens.
- `capabilities.multimodal` — declares image input for endpoints without
  a catalog entry (openai-compat, custom); on catalog-backed endpoints
  `false` vetoes even a catalog grant. Absent = declared capability only
  (catalog modalities, else not multimodal) — never inferred (#490).
- `capabilities.thinking.format` — one of `openai-effort`,
  `openrouter-effort`, `anthropic-effort`, `google-thinking-level`;
  `levels` are canonical thinking levels (`off`, `low`, `medium`,
  `high`, `xhigh`, `max`).
- `permissions.overrides` — tier-2 rules (built-in defaults < these <
  in-session runtime rules); same grammar as the CLI `--allow/--deny`
  flags and the TUI prompt (see the Permissions page).
- `extensions` — extra extension modules for this project, relative to the
  project root (or absolute). A declaration is a **proposal**, never an
  activation: it loads only after you allow it, and the answer is tied to
  the file's exact contents (see the Extensions page). Editing the file
  asks again; a clone you never answered for loads nothing.
- `mcpServers` — project servers ask consent on first use; tools become
  `mcp__<server>__<tool>`.
- `routingPool` — #868: `<endpoint>/<model-id>` refs the Jev model router
  may rotate through when its tier target cannot serve (beyond its
  tier-bounded default). Absent = tier-bounded rotation only (see the
  Jev page).
- `handoff.transport` — absent = Not Set = off; `"gist"` enables
  publish-on-push session handoff.
- `mpm` — per-project Moh Project Map override (ADR-0026): an explicit
  `enabled` (either `true` or `false`) overrides the user default for
  this project only; absent means inherit (the global default is
  **disabled** — MPM is opt-in), `quota` tightens the
  storage bounds (`maxFiles`, `maxTotalBytes`), `exclude` adds
  gitignore-style workspace exclusion patterns.
- `browser` — the native browser tool (#774, ADR-0029), **off by
  default**: `enabled: true` registers the `browser` tool
  (`navigate`, `snapshot`, `read_text`, `close`, `screenshot`, plus the
  act tier: `click`, `fill`, `select`, `scroll`, `press_key`,
  `wait_for`, `upload`, `eval_js`) driving a headless
  Chromium via playwright-core. Requires the optional toolchain
  (`npm i -g playwright-core && npx playwright-core install chromium`);
  when missing, the tool is not registered and a visible
  `browser_unavailable` diagnostic is recorded at session start.
  `headless` (default `true`) runs a real Chrome window when `false`
  (same permission rules; the window is reaped when the session
  closes).
  Loopback URLs (`localhost` dev servers) are always allowed; other
  private/link-local addresses are blocked by default (prompt-injection
  SSRF guard) — including public hostnames that resolve to private
  addresses (DNS verification, checked per redirect hop) — and
  `allowedHosts` is the exact-host escape hatch (no wildcard subdomain
  matching; `MOH_FETCH_ALLOW_PRIVATE` does not apply here). Element
  addressing is exclusively by `[ref=eN]` from the latest snapshot.
  Act-tier actions ask by default (#777); acting on a stale ref
  returns a visible error with the fresh snapshot. `upload` sources
  must be inside the project root (out-of-root paths ask per
  occurrence and never persist as a rule); a required download asks
  with name + size and stages to `~/.moh/browser-downloads/<slug>/`
  (blocked entirely when refused or unattended — no silent writes).
- `maxIterations` — per-turn tool-call iteration cap (default 50). `0`
  is the unlimited sentinel (#498): no cap — the anti-runaway wrap-up
  never fires. Any integer 1–500 is accepted (the 50/100/200/500
  presets are a UI concern): manage it from the TUI settings row
  ("Max iterations/turn") or `moh run --max-iterations`.

## ~/.moh/config

Known sections (each schema owned by its domain; unknown sections are
preserved verbatim):

| Section | Owner | Keys |
| --- | --- | --- |
| TUI chrome | TUI (`tui/src/user-config.ts`) | `onboarded`, `mode` (`vibe`/`dev`), `theme`, `icons`, `filePreview` (`always`/`on-demand`/`none`), `answerLanguage` (`auto`/`en`/`it`), `telemetry`, `permissionMode` (`normal`/`auto-accept`), `editor`, `homeListMax` (3–10), `workflow.enabled`, `workflowOffered`, `showReasoning`, `reasoningNoticeShown`, `updateCheck`, `images.preview` (`auto`/`on`/`off`) |
| `provider` / `endpoints` | core (`provider-config.ts`) | same shape as moh.json's; strict when present; merged per-field, project wins field-by-field |
| `mcpServers` | core (`mcp/types.ts`) | user-scope servers — trusted, no consent prompt; stdio `{ command, args, env }` or http `{ url, headers }` |
| `auth` | core (ADR-0006) | subscription tokens keyed by endpoint name, plus `auth.overrides` for captured client_ids/issuers; never in moh.json, never logged |
| `mcpTrust` | core (`mcp/types.ts`) | recorded "always" consent for project MCP servers, keyed by project slug → server names (the repo's own `trusted` field is ignored) |
| `liveModels` | core (`live-model-catalog.ts`) | `enabled` (default `true`; `false` restores the fully static model catalog), `ttlHours` (default 24) for the `~/.moh/live-models.json` picker cache |
| `mpm` | core (`mpm/config.ts`) | the user default for the Moh Project Map: `enabled` (default `false` — MPM is opt-in; `true` enables it everywhere unless a project opts out), `quota` (`maxFiles`, `maxTotalBytes`), `exclude` (gitignore-style patterns) |
| `typesafe` | the Jev extension (`@moh/jev-guard`) | the bundled Jev (TypeSafe) integration (#784): `apiKey` (present = active, absent = nothing is registered — there is no toggle; entered from the TUI Settings panel entry `Jev (TypeSafe)`, never hand-edited), `timeoutMs` (per-call hook timeout in ms, default `2500`, configuration only), `routing` (per-turn model-routing opt-in, default `false`; changed from the same Settings entry and read when a session starts — the session command `/routing off|on` pauses and enables it for that session without touching this file), `tiers` (explicit tier labels for routing: `"<endpoint>/<model-id>"` → `economico` \| `bilanciato` \| `potente`; an unlabeled model is ranked by catalog price — see the Jev page), `injection` (anti-injection opt-in, default `false`: judges your message and every web result against prompt injection, sending the message text to TypeSafe — same Settings entry), `classification` (prompt classification, default `true` — turn it off with `false` to stop the per-turn task-type hints and the project-map gate; see the Jev page), `rerank` (MPM seed-rerank opt-in, default `false`: ranks over-threshold orientation candidates instead of discarding the plan — see the Jev page), `lint` (end-of-task quality-gate opt-in, default `false`: sends the changed code's diff plus the project's convention docs to TypeSafe — same Settings entry), `skills` (per-turn skill-suggestion opt-in, default `false`: ranks the skill roster and suggests at most one skill per turn, sending your message plus the roster to TypeSafe twice per judged turn — see the Jev page). User config only — a cloned project must not be able to activate an account |

The `typesafe` block lives in the user config only — never in moh.json: a
cloned repository must not be able to declare `apiKey` on your behalf. See
[Jev (TypeSafe)](./jev.md) for what the integration does and how it
degrades. It is
strict when present (a malformed block fails loudly at session start, like
`provider`/`endpoints`) and unknown keys inside it are stripped. The key is
entered from the TUI Settings panel (`Jev (TypeSafe)`), where it is validated
and stored; the presence of the key *is* the activation state, and
`timeoutMs` and `tiers` have no UI field (the use-case opt-ins,
`routing`, `injection`, `rerank`, `lint` and `skills`, have one each). See the Jev page.

The file is always written through the guardian: read-modify-write of
the whole JSON, temp file + rename, 0600 file / 0700 dir.

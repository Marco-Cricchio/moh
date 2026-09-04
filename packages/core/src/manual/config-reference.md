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
  "maxIterations": 50
}
```

All keys are optional. Notes:

- `provider` — default route: `"mock"`, a custom registered id, or
  `"endpoint/model-id"` (or a bare `"endpoint"` using its defaultModel).
- `endpoints[].type` — built-in `"anthropic" | "openai" | "google" |
  "github-copilot" | "openrouter" | "kimi-coding" | "xai" |
  "openai-compat"`, or a custom id registered via `registerProvider`.
- `endpoints[].apiKey` — falls back to the env var
  `MOH_ENDPOINT_<NAME>_API_KEY`; keep moh.json gitignored when inlining.
- `endpoints[].auth` — absent = api-key; `{ "kind": "subscription" }`
  uses the plan's OAuth tokens.
- `capabilities.thinking.format` — one of `openai-effort`,
  `openrouter-effort`, `anthropic-effort`, `google-thinking-level`;
  `levels` are canonical thinking levels (`off`, `low`, `medium`,
  `high`, `xhigh`, `max`).
- `permissions.overrides` — tier-2 rules (built-in defaults < these <
  in-session runtime rules); same grammar as the CLI `--allow/--deny`
  flags and the TUI prompt (see the Permissions page).
- `mcpServers` — project servers ask consent on first use; tools become
  `mcp__<server>__<tool>`.
- `handoff.transport` — absent = Not Set = off; `"gist"` enables
  publish-on-push session handoff.
- `maxIterations` — per-turn tool-call iteration cap (default 50).

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

The file is always written through the guardian: read-modify-write of
the whole JSON, temp file + rename, 0600 file / 0700 dir.

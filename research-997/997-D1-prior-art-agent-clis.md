# 997-D1 — Prior art: how agent CLIs define their extension platform

Research for wayfinder ticket **#997** (map **#996 "complete moh extensibility"**).

Scope: what six platforms (pi, Claude Code, Gemini CLI, opencode, Codex CLI, MCP) expose
as an extension surface, across twelve dimensions, and where moh's restriction-only rule
sits relative to them. Primary sources only; one citation URL per claim. Gaps are marked
**UNVERIFIED** rather than filled by invention.

Method note: platforms whose docs live outside the repo are cited at their canonical
documentation URL; repo-hosted docs and API surfaces are cited as raw-GitHub permalinks
where the docs site 404s or is a stub.

---

## 0. Reading key

| Marker | Meaning |
| --- | --- |
| **UNVERIFIED** | Claim not confirmed against a primary source in this pass |
| *(stub)* | The repo doc exists but only redirects to the vendor site |

The dimension set used below (twelve rows) is my instrument, not the ticket's; the ticket
asks which dimensions exist, and section 4(a) answers that by unioning them.

---

## 1. pi (`earendil-works/pi`)

Docs live in-repo (`pi.dev` 404s), so links are raw GitHub. The type file is the real
contract: `packages/coding-agent/src/core/extensions/types.ts`.

| Dimension | pi |
| --- | --- |
| Manifest shape | No manifest file. An extension is a TS/JS module exporting hook functions; discovery is by path. `~/.pi/agent/extensions` + project `.pi/extensions`, plus a `pi` key in `package.json`. [types.ts](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/extensions/types.ts) · [docs/extensions.md](https://raw.githubusercontent.com/earendil-works/pi/main/docs/extensions.md) |
| Tools | `registerTool` — an extension *adds* tools to the catalog, not just filters them. [types.ts](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/extensions/types.ts) |
| Commands | `registerCommand`, `registerShortcut`, `registerFlag` — slash commands, keybindings and CLI flags are all extension-addable. [types.ts](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/extensions/types.ts) |
| UI | `registerMessageRenderer`, `registerMarkdownTransformer`, `registerEntryRenderer` — the extension paints parts of the transcript. [types.ts](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/extensions/types.ts) |
| Providers | `registerProvider` / `unregisterProvider` — an extension can bring a whole backend. [types.ts](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/extensions/types.ts) |
| Prompt / context | `InputEventResult` (`transform` / `handled`) rewrites user input; `ContextEventResult.messages` rewrites the message array; `appendEntry` writes into the log. [types.ts](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/extensions/types.ts) |
| Session control | Imperative powers: `sendMessage`, `sendUserMessage`, `setActiveTools`, `setModel`, `setThinkingLevel`, `exec`, and an `events` subscription. An extension drives the session, it does not merely observe it. [types.ts](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/extensions/types.ts) |
| Packaging / distribution | `pi install npm:<pkg>` / `git:` / `./path`, one-shot `--extension`, and `pi update --extensions`. [docs/packages.md](https://raw.githubusercontent.com/earendil-works/pi/main/docs/packages.md) |
| Consent & trust | Project trust over `.pi/*`, with `--approve` as the explicit gesture. `/reload` re-reads extensions in-session. [docs/security.md](https://raw.githubusercontent.com/earendil-works/pi/main/docs/security.md) |
| Sandbox / isolation | **None.** Stated plainly in the security doc; the code runs in-process with the agent's privileges. [docs/security.md](https://raw.githubusercontent.com/earendil-works/pi/main/docs/security.md) |
| Versioning & compatibility | 31 event types in the `ExtensionEvent` union — a wide, typed surface; no documented semver/`apiVersion` gate for extension authors. [types.ts](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/extensions/types.ts) |
| Update / rollback | `pi update --extensions`; `/reload` for in-session pickup. No documented rollback. [docs/packages.md](https://raw.githubusercontent.com/earendil-works/pi/main/docs/packages.md) |
| Session storage / backends | Only a "Session storage" section in `sdk.md`; the hot-swappable session backend the ticket implies is **UNVERIFIED** for pi. |

**Key fact for section 4(c):** pi does not merely veto. `ToolCallEventResult.block` mutates
tool input in place, and `setActiveTools` changes the live tool set — pi can *grant and
reshape*, not only restrict. [types.ts](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/extensions/types.ts)

---

## 2. Claude Code

Docs at `code.claude.com/docs/en/...`, with `.md` variants and an `llms.txt` index.

| Dimension | Claude Code |
| --- | --- |
| Manifest shape | `.claude-plugin/plugin.json` — a full field table plus a `userConfig` schema. A marketplace level adds `.claude-plugin/marketplace.json` with reserved names and source types (including `command`). [manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference) · [marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference) |
| Tools | Plugins ship components (hooks, commands, agents, MCP servers) rather than raw tool registration; a plugin's `bin/` is added to `PATH`. [components](https://code.claude.com/docs/en/plugins/components) | 
| Commands | Slash commands and agents are declared components with path rules. [components](https://code.claude.com/docs/en/plugins/components) |
| UI | No transcript-renderer surface documented; UI effect is via `systemMessage` and permission-prompt text. [hooks](https://code.claude.com/docs/en/hooks) |
| Providers | Not a plugin surface. Provider choice lives in settings, not the plugin manifest. **UNVERIFIED** that a plugin can register a provider. |
| Prompt / context | `SessionStart` and `UserPromptSubmit` inject context; `PreToolUse` can rewrite tool input via `updatedInput`. [hooks](https://code.claude.com/docs/en/hooks) |
| Session control | ~35 hook events covering the lifecycle: `SessionStart`/`SessionEnd`, `SubagentStart`/`SubagentStop`, `PreCompact`, `PreModelSwitch`, `PreToolUse`, `PermissionRequest`. [hooks](https://code.claude.com/docs/en/hooks) |
| Packaging / distribution | Marketplaces: a plugin is installed from a marketplace entry; per-marketplace auto-update is on/off. [marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference) · [install](https://code.claude.com/docs/en/plugins/install) |
| Consent & trust | Scope model user/project/local; plugin install is a user gesture; a security page states the trust boundary. [loading](https://code.claude.com/docs/en/plugins/loading) · [security](https://code.claude.com/docs/en/plugins/security) |
| Sandbox / isolation | No OS sandbox for plugin code; hooks are consent-gated shell/HTTP/MCP processes. [security](https://code.claude.com/docs/en/plugins/security) |
| Versioning & compatibility | Version precedence: `plugin.json` > marketplace entry > commit SHA / SHA-256 / `unknown`. [marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference) |
| Update / rollback | Per-marketplace auto-update toggle; rollback is **UNVERIFIED** (no documented pin-and-revert). [marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference) |
| Handler kinds | `command | http | mcp_tool | prompt | agent` — five ways to implement a hook. [hooks](https://code.claude.com/docs/en/hooks) |

**Key fact for section 4(c):** `PermissionRequest` returns `updatedPermissions` (whose
`destination` is `session | localSettings | projectSettings | userSettings`) and can
`setMode`. A plugin can therefore *widen* permissions and persist that widening — the
strongest granting model in this survey. [hooks](https://code.claude.com/docs/en/hooks)

---

## 3. Gemini CLI

Docs at `raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/*.md`.

| Dimension | Gemini CLI |
| --- | --- |
| Manifest shape | `gemini-extension.json`, field by field: `mcpServers`, `contextFileName`, `excludeTools`, `settings[]` (with `envVar`/`sensitive`), `themes`, `plan`, `migratedTo`. [gemini-extension.json](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/index.md) |
| Tools | MCP servers are the tool door; `excludeTools` prunes with a typed syntax, e.g. `run_shell_command(rm -rf)`. [extensions/index.md](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/index.md) |
| Commands | `commands/*.toml` — declarative, not code. [extensions/index.md](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/index.md) |
| UI | `themes` in the manifest; no renderer API. [extensions/index.md](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/index.md) |
| Providers | Not a documented extension surface. **UNVERIFIED** that an extension can add a provider. |
| Prompt / context | `contextFileName` injects a context file; `skills/` ships skill prompts; `agents/` (preview) ships agent definitions. [extensions/index.md](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/index.md) |
| Session control | `hooks/hooks.json` gives lifecycle hooks; scope is narrower than Claude Code's ~35. [extensions/index.md](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/index.md) |
| Packaging / distribution | Install/update/disable/enable per scope; `--auto-update`. [extensions/index.md](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/index.md) |
| Consent & trust | `--consent` flag; env sanitisation; `settings[]` marks sensitive vars. [extensions/index.md](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/index.md) |
| Sandbox / isolation | No extension sandbox documented; isolation is env-var sanitisation. [extensions/index.md](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/index.md) |
| Versioning & compatibility | `migratedTo` is the declared forward-pointer from one extension to its successor — the only explicit migration field in this survey. [extensions/index.md](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/index.md) |
| Update / rollback | `update`, `disable`, `enable` per scope; `--auto-update`; rollback is disable, not version-pin. [extensions/index.md](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/index.md) |

**Key fact:** Gemini's tier-2 `policies/` explicitly **ignores** `allow` and `yolo`
decisions from an extension — an extension can only restrict. This is moh's rule, stated
by another vendor. [extensions/index.md](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/index.md)

---

## 4. opencode (`sst/opencode`)

The plugin API is a TypeScript `Hooks` interface; the docs describe discovery. Note the
directory is `plugins/` (plural), not `plugin/`.

| Dimension | opencode |
| --- | --- |
| Manifest shape | No manifest. A plugin is a JS/TS module exporting one or more plugin functions; `Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>`. Config declares npm plugins as `plugin: string[]` or `[name, options]` pairs. [plugin index.ts](https://raw.githubusercontent.com/sst/opencode/dev/packages/plugin/src/index.ts) |
| Tools | `Hooks.tool` — a map keyed by tool name to `ToolDefinition`. Plugins add tools. Custom tools are also a first-class doc topic. [plugin index.ts](https://raw.githubusercontent.com/sst/opencode/dev/packages/plugin/src/index.ts) |
| Commands | `"command.execute.before"` observes and can rewrite the parts a slash command produces. [plugin index.ts](https://raw.githubusercontent.com/sst/opencode/dev/packages/plugin/src/index.ts) |
| UI | No renderer registration; `tui?: never` on `PluginModule` states the server plugin cannot ship a TUI. [plugin index.ts](https://raw.githubusercontent.com/sst/opencode/dev/packages/plugin/src/index.ts) |
| Providers | `auth` hook (OAuth/API prompt flows) + `provider` hook with `models()` — plugins add providers, models and auth flows. [plugin index.ts](https://raw.githubusercontent.com/sst/opencode/dev/packages/plugin/src/index.ts) |
| Prompt / context | `experimental.chat.messages.transform` and `experimental.chat.system.transform` rewrite the message array and the system prompt. [plugin index.ts](https://raw.githubusercontent.com/sst/opencode/dev/packages/plugin/src/index.ts) |
| Session control | `event` hook over the whole event stream; `experimental.session.compacting` customises the compaction prompt; `experimental.compaction.autocontinue` toggles the synthetic continue turn; `tool.execute.before/after` wrap calls; `shell.env` injects env. [plugin index.ts](https://raw.githubusercontent.com/sst/opencode/dev/packages/plugin/src/index.ts) |
| Packaging / distribution | `.opencode/plugins/` (project) + `~/.config/opencode/plugins/` (global), or npm names in `opencode.json`; npm plugins are installed automatically with Bun into `~/.cache/opencode/node_modules/`. [plugins doc](https://opencode.ai/docs/plugins/) |
| Consent & trust | **None beyond installation.** Files in the plugin directories "are automatically loaded at startup"; npm plugins are installed and run at startup. There is no first-run prompt. [plugins doc](https://opencode.ai/docs/plugins/) |
| Sandbox / isolation | None documented; plugins run in the opencode server process. [plugins doc](https://opencode.ai/docs/plugins/) |
| Versioning & compatibility | Load order is specified (global config → project config → global plugin dir → project plugin dir); duplicate npm packages at the same name+version load once. No `apiVersion` gate. [plugins doc](https://opencode.ai/docs/plugins/) |
| Update / rollback | npm install at startup is the update path; no documented rollback. [plugins doc](https://opencode.ai/docs/plugins/) |
| Permission model (adjacent) | `permission` config resolves each rule to `allow | ask | deny`, with `--auto` auto-approving anything not explicitly denied. A plugin can also intercept: `"permission.ask"` sets `status: "ask" | "deny" | "allow"` — i.e. a plugin can *grant*. [permissions doc](https://opencode.ai/docs/permissions/) · [plugin index.ts](https://raw.githubusercontent.com/sst/opencode/dev/packages/plugin/src/index.ts) |

---

## 5. Codex CLI (`openai/codex`)

Repo `docs/` are largely *(stubs)* pointing at `developers.openai.com/codex/...`, whose
`.md` variants are the real text. There is no in-repo plugin doc and no `docs/hooks.md`.

| Dimension | Codex CLI |
| --- | --- |
| Manifest shape | No general plugin manifest in the repo docs. `config.toml` (user) + project `.codex/config.toml`, loaded only when the project is trusted. A `.codex-plugin/plugin.json` exists for hook bundling: `{ "name": "repo-policy", "hooks": "./hooks/hooks.json" }`. [config reference](https://developers.openai.com/codex/config-reference.md) · [hooks](https://developers.openai.com/codex/hooks.md) |
| Tools | No tool registration by extension. Tools are built-ins (`shell`, `apply_patch`, `exec_command`) plus MCP servers declared under `mcp_servers.<id>`. App/connector tools are gated per-tool. [config reference](https://developers.openai.com/codex/config-reference.md) |
| Commands | No command registration. Slash commands are built-in (`/hooks`, `/review`, `/model`, `/feedback`). [slash commands *(stub)*](https://raw.githubusercontent.com/openai/codex/main/docs/slash_commands.md) |
| UI | No renderer surface. Hooks influence the UI only through `systemMessage` and `statusMessage`. [hooks](https://developers.openai.com/codex/hooks.md) |
| Providers | `model_providers.<id>` declares a custom provider: `base_url`, `env_key`, `wire_api` (`responses` only), retries, optional command-backed `auth`. This is *config*, not plugin code — but it is provider extensibility. Built-in ids `openai`, `ollama`, `lmstudio` are reserved. [config reference](https://developers.openai.com/codex/config-reference.md) |
| Prompt / context | `AGENTS.md` for project instructions; `developer_instructions`; hooks return `additionalContext` (spilled to disk above ~2500 tokens). [config reference](https://developers.openai.com/codex/config-reference.md) · [hooks](https://developers.openai.com/codex/hooks.md) |
| Session control | Hooks: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `UserPromptSubmit`, `Stop`, `Interrupt`. `Stop`/`SubagentStop` can *continue* a turn by returning `decision: "block"` with a reason. Multi-agent: `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, `close_agent`; `agents.<name>` declares roles. [hooks](https://developers.openai.com/codex/hooks.md) · [config reference](https://developers.openai.com/codex/config-reference.md) |
| Packaging / distribution | `features.remote_plugin` (a remote plugin catalog, on by default) and `tool_suggest.discoverables` with `type = "connector" | "plugin"`. Plugin-bundled hooks are loaded from an enabled plugin. [config reference](https://developers.openai.com/codex/config-reference.md) · [hooks](https://developers.openai.com/codex/hooks.md) |
| Consent & trust | The strongest *review* model here: non-managed hooks must be **reviewed and trusted**, tracked against the hook definition's **hash**, via `/hooks`; changed hooks are skipped until re-trusted. `--dangerously-bypass-hook-trust` exists for automation. Admins set `allow_managed_hooks_only = true` in `requirements.toml`. [hooks](https://developers.openai.com/codex/hooks.md) |
| Sandbox / isolation | Real OS-level sandbox for *commands*: `sandbox_mode = read-only | workspace-write | danger-full-access`, writable roots, network proxy with domain allow/deny. Hooks themselves are not sandboxed. [config reference](https://developers.openai.com/codex/config-reference.md) |
| Versioning & compatibility | No extension `apiVersion`. Schema note: the linked `main` schemas may contain fields not in the current release; the docs page is the release reference. [hooks](https://developers.openai.com/codex/hooks.md) |
| Update / rollback | `check_for_update_on_startup`; hook trust is per-hash so an updated hook effectively rolls back to "untrusted" until reviewed. [config reference](https://developers.openai.com/codex/config-reference.md) |
| Handler kinds | `command` and `mcp_tool` supported; `prompt` and `agent` parsed but skipped. [hooks](https://developers.openai.com/codex/hooks.md) |

**Key fact for section 4(c):** `PreToolUse` returning `permissionDecision: "allow"` with
`updatedInput` rewrites a tool call's arguments — Codex grants *and rewrites*, and
`PermissionRequest` with `behavior: "allow"` lets a call proceed **without surfacing the
approval prompt**. Note the asymmetry: `updatedInput`, `updatedPermissions` and
`interrupt` on `PermissionRequest` are "reserved for future behavior and fail closed
today". [hooks](https://developers.openai.com/codex/hooks.md)

---

## 6. MCP (Model Context Protocol)

MCP is not a CLI extension platform; it is the wire over which one kind of extension
(a tool server) is spoken. It matters to #997 because three of the six platforms use it
as the tool door, and because it has the ecosystem's only *specified* consent vocabulary.

| Dimension | MCP |
| --- | --- |
| Manifest shape | None. Server capabilities are negotiated at initialize time ("server and client capability negotiation") — capability negotiation *is* the manifest. [spec index](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/index.mdx) |
| Tools | Server feature: "Functions for the AI model to execute". [spec index](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/index.mdx) |
| Commands | Server feature **Prompts**: "Templated messages and workflows for users" — user-invoked, the MCP analogue of a slash command. [spec index](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/index.mdx) |
| UI | Not in the 2025-06-18 core spec. MCP Apps / `ui://` is **UNVERIFIED** — not found in the spec index read this pass. |
| Providers | Out of scope. MCP says nothing about model providers. [spec index](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/index.mdx) |
| Prompt / context | Server feature **Resources**: "Context and data, for the user or the AI model to use". [spec index](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/index.mdx) |
| Session control | Client features back toward the server: **Sampling** (server-initiated LLM interactions), **Roots** (server asks the client for filesystem boundaries), **Elicitation** (server asks the user for more information). [spec index](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/index.mdx) |
| Packaging / distribution | Out of scope; each host invents its own. [spec index](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/index.mdx) |
| Consent & trust | The most explicit consent doctrine of the six: users "must explicitly consent to" data access and operations; hosts "must obtain explicit user consent before invoking any tool"; "descriptions of tool behavior such as annotations should be considered untrusted"; users must approve sampling and control the prompt sent and the results the server can see. [spec index](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/index.mdx) |
| Sandbox / isolation | "While MCP itself cannot enforce these security principles at the protocol level, implementors SHOULD build robust consent and authorization flows". Explicitly no enforcement. [spec index](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/index.mdx) |
| Versioning & compatibility | Dated spec revisions (`2025-06-18`); negotiation at initialize. [spec index](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/index.mdx) |
| Update / rollback | Out of scope. [spec index](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/index.mdx) |
| Authorization | HTTP transports SHOULD use OAuth 2.1: Protected Resource Metadata (RFC 9728) discovery, Authorization Server Metadata (RFC 8414), PKCE mandatory, `resource` parameter (RFC 8707) required on both authorization and token requests, token audience binding, token passthrough forbidden. STDIO transports SHOULD NOT use this and instead take credentials from the environment. Authorization is **OPTIONAL**. [authorization spec](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/basic/authorization.mdx) |

---

## 7. Synthesis

### (a) The union of dimensions — the candidate definition of "complete"

Unioning the twelve rows across all six platforms yields **fourteen** dimensions. The
first twelve are the survey instrument; the last two emerged only because a platform
actually has them.

1. **Manifest / declaration shape** — how an extension announces itself. Variants seen:
   none (pi, opencode; discovery by path or config list) · rich JSON manifest (Claude Code
   `plugin.json`, Gemini `gemini-extension.json`) · config-table declaration (Codex
   `mcp_servers`, `model_providers`) · negotiated capability set (MCP). A complete contract
   must choose one and say what is *not* discoverable.
2. **Tools** — add tools (pi `registerTool`, opencode `Hooks.tool`) vs. only reference
   external ones (Codex via `mcp_servers`, Gemini via `mcpServers`) vs. prune them
   (Gemini `excludeTools`).
3. **Commands** — add slash commands (pi `registerCommand`, Claude Code components, Gemini
   `commands/*.toml`) vs. no door (Codex).
4. **UI** — paint the transcript (pi's three renderer registrations) vs. text-only influence
   (Claude Code, Codex `systemMessage`) vs. theme-only (Gemini) vs. explicitly absent
   (opencode `tui?: never`).
5. **Providers** — register a backend (pi `registerProvider`, opencode `provider`/`auth`)
   vs. declare one in config (Codex `model_providers`) vs. no door (Claude Code, Gemini
   — the latter two **UNVERIFIED** as absent rather than merely undocumented).
6. **Prompt / context** — rewrite input (pi `transform`), rewrite the message array (pi
   `ContextEventResult`, opencode `chat.messages.transform`), rewrite the system prompt
   (opencode `chat.system.transform`), or only append (Claude Code/Codex
   `additionalContext`, Gemini `contextFileName`).
7. **Session control** — observe vs. drive. Drive includes sending messages (pi
   `sendMessage`), switching models/thinking (pi `setModel`, `setThinkingLevel`), changing
   the live tool set (pi `setActiveTools`), customising compaction (opencode
   `experimental.session.compacting`), continuing a turn (Codex `Stop` →
   `decision: "block"`), and spawning agents (Codex `spawn_agent`).
8. **Packaging / distribution** — a directory convention plus a package registry (pi
   `npm:`/`git:`/`./`, opencode dirs + npm, Gemini scopes) vs. a *marketplace* with its own
   manifest and reserved names (Claude Code) vs. a remote catalog (Codex
   `features.remote_plugin`).
9. **Consent & trust** — see (b). This is the most divergent dimension.
10. **Sandbox / isolation** — the OS sandbox (Codex `sandbox_mode`, network proxy with
    domain allow/deny) vs. nothing (pi and opencode state it; Claude Code and Gemini
    document no extension sandbox; MCP says it cannot enforce at the protocol level).
11. **Versioning & compatibility policy** — `apiVersion` gating (moh, not these six) vs.
    precedence rules (Claude Code: `plugin.json` > marketplace > commit SHA/SHA-256/
    `unknown`) vs. an explicit successor field (Gemini `migratedTo`) vs. "the docs page is
    the release reference" (Codex) vs. unspecified (pi, opencode).
12. **Update / rollback** — auto-update toggle (Claude Code per marketplace, Gemini
    `--auto-update`), update command (pi `pi update --extensions`), install-at-startup
    (opencode), startup check (Codex `check_for_update_on_startup`), and *rollback* —
    essentially absent everywhere; the closest is Codex's per-hash hook trust, where an
    updated hook reverts to untrusted.
13. **Permission model entry point** (emergent) — whether the extension can *speak to* the
    permission system, not just sit beside it: opencode `"permission.ask"` with
    `allow`/`deny`/`ask`, Claude Code `PermissionRequest` + `updatedPermissions`, Codex
    `PermissionRequest` `behavior: allow|deny`, pi's `block`-with-mutation. Gemini's
    `policies/` is the deliberate counter-example: `allow`/`yolo` are ignored.
14. **Capability negotiation / protocol revision** (emergent) — MCP alone specifies
    initialize-time negotiation and dated revisions.

**What this means for judging moh:** "complete" in this prior art is not "has more hooks".
It is *which of these fourteen doors exist and what each door may do*. Six platforms agree
on roughly dimensions 1–8 and 10–12 while diverging on 9 and 13; that divergence is the
design space #997 actually has to decide.

### (b) Four distinct designs for capability consent

| Design | Mechanism | Exemplified by |
| --- | --- | --- |
| **1. Implicit trust in the code** | Loading *is* the grant. No prompt, no declaration; the code runs in-process with full privileges. | **opencode** — "Files in these directories are automatically loaded at startup"; npm plugins installed and run at startup. [plugins doc](https://opencode.ai/docs/plugins/) · **pi** — same shape, but with project trust + `--approve` at the project level rather than per extension. [docs/security.md](https://raw.githubusercontent.com/earendil-works/pi/main/docs/security.md) |
| **2. Declared capabilities in a manifest** | The extension states what it needs; the host reads it before loading. | **Gemini CLI** — `settings[]` with `envVar`/`sensitive` marks which env vars are sensitive; `excludeTools` states which tools are pruned. [extensions/index.md](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/index.md) · **Claude Code** — `userConfig` schema in `plugin.json` declares user-settable inputs. [manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference) |
| **3. Prompt at (or before) first use** | The host asks the human, at a defined moment, and remembers the answer. | **Codex CLI** — non-managed hooks must be reviewed and trusted, recorded **against the hook definition's hash**, so an edited hook asks again; `/hooks` is the review UI. [hooks](https://developers.openai.com/codex/hooks.md) · **MCP** — the spec's doctrine: explicit consent before invoking any tool, before exposing user data, before sampling. [spec index](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/index.mdx) · **moh** — enable consent bound to path + SHA-256, asked once through the permission modal. |
| **4. OS / process sandbox** | The code is untrusted but *contained*; consent is replaced by capability limits the kernel enforces. | **Codex CLI** — `sandbox_mode = read-only | workspace-write | danger-full-access`, writable roots, network proxy with per-domain allow/deny, `shell_environment_policy` filtering. [config reference](https://developers.openai.com/codex/config-reference.md) |

Note the orthogonality: design 3 and design 4 are independent. Codex has both — a hash-pinned
review *and* an OS sandbox for commands — and neither covers the other (hooks are not
sandboxed; the sandbox does not ask). Designs 1 and 2 are the truly opposed pair, and
Gemini's manifest is the only place where the extension's declaration is *data the host
reads* rather than *code the host trusts*.

### (c) Where moh's restriction-only rule sits

moh's principle 4 — "Permissions restrict; extensions veto, never grant" — places moh in
the **Gemini CLI camp for the permission door**, and only that camp. Gemini's tier-2
`policies/` ignores `allow` and `yolo` from an extension: an extension may tighten, never
loosen. [extensions/index.md](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/index.md)
That is exactly moh's rule, and moh reaches the same place through a different mechanism
(hooks with `veto`/`ask`/`withhold` outcomes, per `docs/extending/extensions.md` and
ADR-0031), so `#997` can cite Gemini as independent confirmation that the rule is
*defensible*, not merely moh's taste.

Everywhere else, the rule is the outlier:

- **pi** grants. `ToolCallEventResult.block` mutates tool input in place, and
  `setActiveTools` changes the live tool set. pi's extension can widen what the agent may
  do. [types.ts](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/extensions/types.ts)
- **Claude Code** grants *and persists the grant*. `PermissionRequest` returns
  `updatedPermissions` with a `destination` of `session | localSettings | projectSettings
  | userSettings`, and can `setMode`. A plugin can therefore widen permissions and write
  that widening into the user's settings — the single most powerful granting door found.
  [hooks](https://code.claude.com/docs/en/hooks)
- **opencode** grants. `"permission.ask"` sets `status: "ask" | "deny" | "allow"`.
  [plugin index.ts](https://raw.githubusercontent.com/sst/opencode/dev/packages/plugin/src/index.ts)
- **Codex** grants, more narrowly and with a stated fail-closed edge. `PreToolUse` with
  `permissionDecision: "allow"` + `updatedInput` rewrites arguments; `PermissionRequest`
  `behavior: "allow"` proceeds **without surfacing the approval prompt**. But
  `updatedInput`, `updatedPermissions` and `interrupt` on `PermissionRequest` "are
  reserved for future behavior and fail closed today". Note also an internal inconsistency
  in the same doc: `PreToolUse` lists `permissionDecision: "ask"` as parsed-but-unsupported
  and failing the hook run, while the page opens by saying hooks must be reviewed before
  they run. [hooks](https://developers.openai.com/codex/hooks.md)

**The working model moh lacks, and what it actually costs.** The likely answers named in
the brief are confirmed, with one correction: pi's granting is *not* via
`ToolCallEventResult.block` alone — `block` is the veto-shaped name for an operation that
mutates input, and the cleaner grant is `setActiveTools` plus the imperative
`sendMessage`/`setModel` powers. [types.ts](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/extensions/types.ts)
The strongest *contract* for granting, though, is Claude Code's, because it is the only one
that names the *destination* of a grant — `session` vs. a settings scope — which is what
makes a grant auditable and revocable rather than ambient. If #997 wants a granting door
that does not destroy principle 4, Claude Code's `updatedPermissions.destination` is the
piece to steal: restrict-only stays the default, and a grant is an explicit, scoped,
recorded act. [hooks](https://code.claude.com/docs/en/hooks)

### (d) The porting story — what each plugin would need to run on moh

Assumed target: moh's `@moh/extension` contract, apiVersion 1.9 — `onSessionStart`,
`beforeTurn`, `beforeModelCall`, `onToolCall`, `onToolResult`, `onCompaction`, `onEvent`,
`afterTurn`; outcomes `veto`/`ask`/`withhold`; prompt doors `appendToPrompt`/`setPromptNote`
(`docs/extending/extensions.md`, ADR-0031 … 0039, 0047).

**A pi extension.** The worst fit, because pi's surface is strictly larger than moh's:
`registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerProvider`,
the three renderers, `sendMessage`, `setActiveTools`, `setModel`, `setThinkingLevel`,
`exec`, and `ContextEventResult.messages`. On moh today, *none* of these have a door. What
would run unchanged: nothing, except the parts of `onToolCall`-shaped logic that happen to
be restriction-only. What moh would have to add to take it: (i) tool registration, (ii)
command registration, (iii) an imperative session API (`sendMessage`-class), (iv) a
message-array rewrite door, (v) a decision on provider registration.
[types.ts](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/extensions/types.ts)

**A Claude Code plugin.** A plugin is a bundle of components: hooks, commands, agents, MCP
servers, with `bin/` on `PATH`, and a JSON manifest with `userConfig`. The hooks are the
only part that maps: `PreToolUse` → `onToolCall` (moh can express `deny`, and `ask` maps to
`ask`), `PostToolUse` → `onToolResult`, `SessionStart`/`SessionEnd` → `onSessionStart`/
`afterTurn` (approximate), `PreCompact` → `onCompaction`, `SubagentStart`/`SubagentStop` →
no moh equivalent if moh has no subagent hooks (**UNVERIFIED**). What does not map:
`PermissionRequest`'s `updatedPermissions`/`setMode` (moh refuses grants), `updatedInput`
rewriting (moh vetoes; it does not mutate), the `http`/`mcp_tool`/`prompt`/`agent` handler
kinds (moh hooks are in-process code, not five handler types), the marketplace and
`plugin.json` (moh has no marketplace and no manifest — see ADR-0039's bundled-source door
for the closest analogue), and the `bin/` PATH injection (no equivalent).
[components](https://code.claude.com/docs/en/plugins/components) ·
[hooks](https://code.claude.com/docs/en/hooks) ·
[manifest](https://code.claude.com/docs/en/plugins/manifest-reference)

**A Gemini extension.** Mostly declarative, so the *shape* is portable but each field needs
a moh home: `mcpServers` → moh already merges MCP from project + user config, so this maps
to `moh.json`; `contextFileName` → `appendToPrompt`/`setPromptNote`; `excludeTools` → moh
permission rules (a pruning vocabulary moh already has via `parseRule`/`formatRule`,
ADR-0007); `commands/*.toml` → no moh door for user-declared commands; `skills/` → moh has
first-party skills (ADR-0011) but **UNVERIFIED** whether third-party extension-supplied
skills are a door; `agents/` (preview) → no moh door; `themes` → no moh door; `settings[]`
with `sensitive` → this is the interesting one: moh's consent model could adopt it verbatim
as a declared-capability list, which would move moh from design-3-only to designs 2+3.
[extensions/index.md](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/index.md)

**An opencode plugin.** The hooks map with surprising fidelity, because opencode's
`Hooks` object is phase-shaped too: `"tool.execute.before"` → `onToolCall` (opencode
mutates `args`; moh vetoes — direct conflict), `"tool.execute.after"` → `onToolResult`,
`"command.execute.before"` → no door, `event` → `onEvent`, `config` → no door,
`"experimental.session.compacting"` → `onCompaction`,
`"experimental.chat.messages.transform"` and `"experimental.chat.system.transform"` → moh's
prompt doors are append-only, so a rewrite is refused, `"permission.ask"` → conflicts
head-on with principle 4, `tool` (adding tools) → no door, `auth`/`provider` → no door.
The distribution model also differs in kind: opencode auto-loads everything in
`.opencode/plugins/` with no consent, whereas moh asks once and pins by path+SHA-256.
[plugin index.ts](https://raw.githubusercontent.com/sst/opencode/dev/packages/plugin/src/index.ts) ·
[plugins doc](https://opencode.ai/docs/plugins/)

**Codex.** Not a plugin platform to port *from* — there is no general plugin API, only
config plus hooks. Its transferable ideas are three: the **hash-pinned trust review** (moh
already has path+SHA-256; Codex shows the `/hooks` review UI that goes with it), the
**`Stop` → continue-a-turn** hook (moh has no door for continuing a turn —
**UNVERIFIED**), and the **OS sandbox** (moh has none, and ADR-0039 records that consent
"is the whole boundary"). [hooks](https://developers.openai.com/codex/hooks.md) ·
[config reference](https://developers.openai.com/codex/config-reference.md)

**What moh would have to add, consolidated** — the short list #997 must rule on:

1. Tool registration (pi, opencode) — currently absent.
2. Command registration (pi, Claude Code, Gemini) — currently absent.
3. Provider registration (pi, opencode; config-declared in Codex) — absent as an extension
   door.
4. Message-array / system-prompt **rewrite** (pi, opencode) — moh's prompt doors are
   append-only.
5. A general imperative session API (pi `sendMessage`/`setModel`/`setActiveTools`).
6. A **granting** door with a stated destination, if principle 4 is to be relaxed —
   Claude Code's `updatedPermissions.destination` is the model to copy.
7. A declared-capability list (Gemini `settings[]` with `sensitive`) — the cheapest way to
   add design-2 consent without touching principle 4.
8. An agent/subagent hook door (Claude Code `SubagentStart`/`Stop`, Codex
   `SubagentStart`/`Stop`) if subagents are to be observable.
9. An update/rollback story — none of the six has a real rollback; this is a green field.

---

## 8. Open questions left UNVERIFIED

- pi's session-backend/storage story (only "Session storage" in `sdk.md`) — the
  hot-swappable backend the ticket implies is not evidenced.
- Whether Claude Code or Gemini CLI let an extension register a **provider** (absence of
  docs is not evidence of absence).
- MCP Apps / `ui://` — not in the `2025-06-18` spec index read this pass.
- Claude Code rollback (pin-and-revert) — no documented mechanism found.
- Whether moh has an extension-supplied **skills** door and a **subagent** hook door; both
  affect the pi and Claude Code porting stories.

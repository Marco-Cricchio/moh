# Permissions & rules

Every tool call passes a gate with one merge order, most-specific-wins:

1. **Extension veto** — an extension's `onToolCall` refusal; it
   overrides everything (extensions can only restrict, never grant).
2. **Your rules** — moh.json overrides, plus in-session runtime rules.
3. **Built-in defaults** — safe per-tool behavior (MCP tools ask on
   first use; writes stay in the project root).

## The rule grammar

One grammar everywhere — moh.json, the TUI prompt and the CLI flags:

- `bash` — the whole bash tool.
- `bash:git status` — bash with these leading shell-word tokens.
- `write:src/**` — writes under a path glob (realpath-anchored).
- `edit:docs/**` — edits under a path glob.

The *effect* (allow or deny) rides on where you declare it: `allow` /
`--allow` grants, `deny` / `--deny` refuses, and the TUI permission
prompt's **always** option records a runtime allow rule for the rest of
the session.

## The permission prompt

When a tool call is neither allowed nor denied you are asked:
`y` allow once, `a` always (persisted for the session), `e` edit the
call, `n` deny. In vibe mode moh auto-accepts within the safe defaults;
`--yolo` (or `--auto-accept` on the CLI) removes prompts — use it for
throwaway work.

## Out-of-root writes

A write **outside the project root** is authorizable per-occurrence
only: asked again every time, never persistable as a rule. The
browser's `upload` action follows the same rule for its source path
(#777): an out-of-root source asks per occurrence and never persists,
even under a site-wide `browser:upload` allow rule.

## Browser act tier

Read-tier browser actions run without prompts; the act tier (`click`,
`fill`, `select`, `scroll`, `press_key`, `wait_for`, `upload`) asks by
default. The prompt renders the action, the element from the latest
snapshot and the domain; "always for this site" records a session-only
`browser:<action> <url-glob>` rule. Downloads are blocked by default:
a required download asks with name + size, then stages under
`~/.moh/browser-downloads/<slug>/` with the path in the tool result —
refuse, and nothing is ever written.

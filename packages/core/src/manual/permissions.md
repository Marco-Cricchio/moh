# Permissions & rules

Every tool call passes a gate with one merge order, most-specific-wins:

1. **Extension veto** — an extension's `onToolCall` refusal; it
   overrides everything (extensions can only restrict, never grant).
   An extension may instead `ask` — escalate the call to the prompt
   below; that case is covered under "Extension asks".
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

## The permission modes

Three modes govern prompts and filesystem reach: `normal` (prompts on
every non-allowed call, project-root containment), `auto-accept` (no
prompts for built-in tools; extension asks and out-of-root paths still
reach you) and `yolo` (no prompts, unrestricted filesystem for built-in
tools).

`shift+tab` in chat rotates `normal → auto-accept → yolo → normal`,
effective from the very next tool decision — including entering and
leaving yolo mid-session. The footer names the mode in force for every
value, at the left of its second row — `◌ Normal`, `◐ Auto-Accept`,
`⚠ YOLO — unrestricted tools`, the text shortening to a bare glyph as the
terminal narrows. Each change is announced in the transcript and recorded
in the session log, so resume and replay show which mode was in force when
each tool call was decided. The rotation is session-scoped and
never persisted: a new session starts from its configuration again,
and `--yolo` on the CLI remains the launch-time opt-in.

## Extension asks

An extension's tool-call hook can do two things: `veto`, which refuses the
call (it outranks your rules and every mode, yolo included), or `ask`,
which hands the call to the consent prompt above. An ask is never a grant:
it cannot allow something your rules refuse, it never records a rule, and
its prompt offers **yes/no only** — no "always", because a filter that
raised the question must not be disarmed by the answer. The prompt is
labelled with the extension's own one-line reason.

Where an ask lands:

- An explicit `deny` rule beats the ask: the call is refused without
  prompting, since your written intent outranks a judgment.
- An explicit `allow` rule does **not** suppress it — judging what your
  rules already let through is the whole point.
- In auto-accept the ask still reaches you (that mode has no other filter);
  `yolo` turns it into an explicit denial recorded with
  `permission_denied { reason: "extension" }`; yolo lifts only moh's own
  prompts, never an extension's question.
- Headless (`moh run`) degrades the ask to a denial, exactly as any other
  ask without a prompt to raise.

The bundled Jev guardrail is the first-party extension that raises these
asks (see [Jev (TypeSafe)](./jev.md)); a plain extension ask looks the same
without it.

## Out-of-root writes

A write **outside the project root** is authorizable per-occurrence
only: asked again every time, never persistable as a rule. The
browser's `upload` action follows the same rule for its source path
(#777): an out-of-root source asks per occurrence and never persists,
even under a site-wide `browser:upload` allow rule.

## Web fetches

The `fetch` tool reads one http/https URL and returns its body as text.
It is network-only: local files belong to `read`, and a `file:` or
`data:` URL is refused for the same reason — it would be a file read that
bypasses the read tool's root containment.

Private, loopback and link-local addresses are blocked, and so is a public
hostname that resolves to one; `MOH_FETCH_ALLOW_PRIVATE=1` is the explicit
operator opt-out. The connection is pinned to the address DNS verified
(#697), every redirect hop is re-checked and re-pinned, and at most 10
hops are followed.

A transient failure — a 5xx answer or a network error — is retried once,
waiting for `Retry-After` when the server sends one, and never more than
10 seconds. A 4xx is never retried, and neither is a cancelled turn.

A non-2xx is reported with the status, a one-line verdict, the headers
that carry the reason (`retry-after`, `x-ratelimit-*`,
`www-authenticate`, `content-type`) and an excerpt of the response body,
capped at 2 KB. That is what tells a quota wall you can wait out apart
from a URL that does not exist. Each failure is classified in the session
log — `http-status`, `rate-limited` or `transient` — so `moh usage tools`
can break failures down without re-reading the text.

`fetch` sends no credentials of its own: an endpoint that requires
authentication answers 401/403, and the error says so.

## Browser act tier

Read-tier browser actions run without prompts; the act tier (`click`,
`fill`, `select`, `scroll`, `press_key`, `wait_for`, `upload`,
`eval_js`) asks by
default. The prompt renders the action, the element from the latest
snapshot and the domain; "always for this site" records a session-only
`browser:<action> <url-glob>` rule. Downloads are blocked by default:
a required download asks with name + size, then stages under
`~/.moh/browser-downloads/<slug>/` with the path in the tool result —
refuse, and nothing is ever written.

`eval_js` runs one expression in the page's full JS context (the same
reach as the devtools console — no sandbox is promised; the control is
the ask). A rule like `browser:eval_js https://app.example.com/**`
allows it per domain like any other act action. Large results are
truncated with a visible marker.

`screenshot` captures the viewport (or one `ref` element) as a PNG.
When the serving model declares image input the pixels ride the result
as a typed image part; otherwise a visible chip + warning is returned
and nothing is silently dropped.

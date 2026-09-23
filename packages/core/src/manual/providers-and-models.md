# Providers & models

A **provider** is a backend that talks to LLMs; a **model** is what you
pick within it. moh ships built-ins for anthropic, openai, google,
github-copilot, openrouter, kimi-coding, xai, OpenCode, and OpenAI-compatible endpoint
profiles for DeepSeek, Groq, Cerebras, NVIDIA NIM, Together AI, Fireworks AI,
Hugging Face, Mistral AI, Moonshot AI, MiniMax, Z.ai, Qwen, Xiaomi MiMo,
Vercel AI Gateway, Cloudflare AI Gateway, and Baseten. It also has a
zero-credential **mock** provider (the default) and custom endpoints via
`openai-compat`.

## Adding a provider

```
moh provider add
```

The wizard presents a documented endpoint and default model for every built-in profile. Where a provider requires an account- or region-specific URL, it asks for the concrete endpoint instead of guessing. API keys are resolved from the provider's documented environment variable as well as `MOH_ENDPOINT_<NAME>_API_KEY`; values entered in the wizard are stored in `~/.moh/config`, never in moh.json.

The wizard first asks **API key or subscription**. A subscription login
(Claude Pro/Max, ChatGPT Plus/Pro, personal Google) runs the provider's
OAuth flow and stores its tokens in `~/.moh/config` — never in
moh.json, never in logs. `moh provider login <name>` re-establishes
tokens, `moh provider logout <name>` drops them, `moh provider status`
shows per-endpoint auth state and plan usage. On the wizard's login
screen the authorize URL can be wider than the dialog (the rendered line
is truncated); press `c` to copy the full URL to the clipboard and open
it in a browser. If the terminal refuses the clipboard write (OSC 52 may
be ignored), the login screen says so instead of failing silently — the
URL line stays on screen as the manual fallback.

## Endpoints and routing

Each configured endpoint is an entry in moh.json (or `~/.moh/config`):
name, type, optional base URL, credentials, default model, optional
fallback models. A model reference is `endpoint/model-id`; the current
one is shown in the status bar.

### The automatic fallback chain

moh builds the fallback chain for you (ADR-0012): when a call fails the
way a fallback can help — quota exhausted, rate limited, network,
overloaded, or an empty completion — the turn is retried on the next
eligible endpoint, and the transcript shows a notice naming both.

Every endpoint that can serve as a stop is in the chain, in declaration
order, each using **its own preferred model** (`defaultModel`). An
endpoint is not a stop when it has no preferred model, when it sets
`fallbackEligible: false`, or when its provider type cannot be a stop
(only built-in types and `openai-compat` can). *Settings → Fallback
models* lists every endpoint with the model it would serve and, for one
that cannot be a stop, the reason — so the chain is never a guess.

Choosing a preferred model there never switches the provider you are
using: it decides what that endpoint serves *with* if it is ever needed.
Headless, the same choice is `moh provider fallback <endpoint> [model]`
(`--clear` drops the endpoint from the chain), and
`moh provider status` prints each endpoint's preferred model. A change
applies from the next session.

### When a provider returns nothing

A call that ends without any content, tool calls or usage is treated as
a failed call, not as an answer. When it happens, the fallback chain is
walked (the configured fallbacks, or the automatic chain from your other
endpoints) and the next viable target serves the turn — the transcript
shows the usual fallback notice. If no target can serve it, the turn
ends with a visible `empty completion` error naming the endpoint that
produced nothing: a turn never ends as a silent, empty reply. The
failed endpoint sits in a 15-minute cooldown, so later turns do not
re-probe it until the cooldown expires.

## Switching models

- `/model` in the TUI opens the picker: every configured endpoint's
  list (from the vendored catalog, or `GET /models` for openai-compat
  endpoints). For catalog-backed providers with a verified listing
  contract (anthropic, openai/ChatGPT, google, github-copilot,
  openrouter, xai) the vendored list is augmented in the background
  with the provider's own live model list (startup and picker open,
  cached in `~/.moh/live-models.json` with a 24h TTL; `r` in the
  picker forces a refresh), so newly released models appear without
  waiting for a moh release. Providers without a verified listing
  contract (kimi-coding, Z.ai Coding Plan) stay static — the
  regen-from-pi-ai path remains their update story. The Settings
  panel's endpoint → model picker shows the same live overlay. The
  switch takes effect from the next turn.
- With Jev model routing on (off by default), the model of a turn can
  also be picked per turn by the router, from the same configured
  models: see [Jev (TypeSafe)](./jev.md). A switch you make yourself
  suspends it for the session. When the router's tier target cannot
  serve (a failure cooldown), it rotates within the tier — or through a
  declared `routingPool` in moh.json — and a skipped switch is always
  announced, never silent.
- `moh run --provider <endpoint/model-id>` picks the model per run.
- The Settings panel's endpoint → model picker saves the default into
  moh.json (user-level endpoints are display-only there).

## Thinking levels

Thinking-capable models accept a reasoning-effort level: `off`, `low`,
`medium`, `high`, `xhigh`, `max`. Cycle it with `ctrl+y` or set it in
`/thinking`. The levels a model actually supports come from the vendored
catalog (or an explicit `capabilities.thinking` declaration for
openai-compat endpoints); unsupported levels are shown as unavailable
rather than silently remapped. The effective level sent is recorded in
the session log.

## OpenCode usage

OpenCode has separate **Zen** and **Go** endpoints. Its usage quota is shown
in the official OpenCode Console at `https://opencode.ai/console`; moh does
not make a remote quota request for OpenCode. Press `ctrl+q` to see the
session's local token measurement per model and follow the Console link for
account usage. Zen USD estimates appear only when moh ships an official
OpenCode Zen price; Go calls are always token-only because moh does not infer
USD prices from a matching model sold by another provider.

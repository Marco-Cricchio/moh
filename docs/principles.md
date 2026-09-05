# moh — Principles

The seven principles below govern every change to moh. **Consult this file before any change**; if a change violates a principle, it needs an explicit ADR saying why. Each principle links to its origin in the ticket that holds the full decision record.

1. **Headless core, thin clients.** All agent logic lives in `@moh/core`; the TUI and CLI are in-process clients that never talk to providers directly. Nothing imports the TUI. *(Origin: spec §1, ticket #7, [ADR-0002](adr/0002-provider-neutral-types.md).)*

2. **The event log is the session.** One append-only sequence of `AgentEvent`s per session is the single source of truth; streaming, persistence, resume and the TUI are projections of it. Nothing is ever deleted from the log. *(Origin: spec §1 and §6, tickets #7, #12, #31.)*

3. **Providers are single-shot and provider-neutral.** A provider answers one `stream` request and never loops; moh owns the loop, retries and fallback. Neutral types (`Provider`, `ChatRequest`, `StreamEvent`) live in the core; any SDK is an invisible implementation detail. *(Origin: spec §2, ticket #8, [ADR-0002](adr/0002-provider-neutral-types.md).)*

4. **Permissions restrict; extensions veto, never grant.** The 3-tier rule spine (defaults < moh.json < runtime) only narrows access; an extension can veto a tool call but can never widen permissions. Extension veto > user rules > defaults. *(Origin: spec §3, ticket #9.)*

5. **Sessions and memory are user data.** Session logs live under `~/.moh/projects/`, never in the project's `.moh/`. Memory is append-only across sessions and consolidated only by the maintenance subagent. *(Origin: spec §6, tickets #12, #38.)*

6. **The core owns the system prompt.** `PromptComposer` assembles typed sections in a fixed order for every model call. Clients never touch the prompt; extensions may only append to the trailing `extension_notes` section. *(Origin: spec §10, tickets #18, #27.)*

7. **Artifacts in English, replies in the user's language.** All repo and public artifacts (docs, code, issues, PRs, prompts) are English; conversation replies follow the user's language. *(Origin: spec §0, ticket #18.)*

# MCP

**MCP servers** are external tool sources declared in configuration.
Their tools appear as `mcp__<server>__<tool>` and run under the same
permission spine as built-in tools — with a stricter default: **ask on
first invocation**.

## Declaring servers

Project scope — moh.json (consent required on first use):

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "docs":   { "url": "https://example.com/mcp" }
  }
}
```

User scope — `~/.moh/config` (`mcpServers` section): trusted, no
consent prompt. Manage both from the CLI:

```
moh mcp add <name> [--user] -- <command> [args...]   # stdio server
moh mcp add <name> --url <url>                       # HTTP streamable
moh mcp list
moh mcp remove <name> [--user]
```

## Lifecycle

Servers start lazily on the first tool use of the session and stop at
session end. If one crashes, `moh mcp restart <name>` verifies it starts
again (handshake + tool listing) — a separate process cannot reach a
live session's servers, so reopen the session to pick the tools back up.

## Consent

A project-scoped server asks once, on its first use, whether you trust
it. Accepting records the trust decision in moh.json; declining blocks
the server for the session. MCP tools are never inherited by subagents.

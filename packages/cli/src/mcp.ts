/**
 * `moh mcp` (#15): manage MCP server declarations.
 * - project servers live in moh.json (consent on first use)
 * - user servers live in ~/.moh/config (trusted, never ask)
 * `restart` performs a manual restart check: it handshakes the server,
 * lists its tools and shuts it down again (no auto-restart exists).
 */
import { resolve as pathResolve, join } from "node:path";
import {
  McpRuntime,
  readUserConfigFile,
  updateUserConfigFile,
  userConfigFile,
  declaredMcpServers,
  declaredUserMcpServers,
  loadMohConfig,
  mcpServerEntrySchema,
  upsertMcpServer,
  writeMohConfig,
  type DeclaredMcpServer,
  type McpServerEntry,
} from "@moh/core";
import { ArgError, parseArgs } from "./args";

export const MCP_USAGE = `usage: moh mcp <command> [options]

commands:
  add <name> [--user] (-- <command> [args...] | --url <url>) [--env K=V]... [--header 'K: V']...
          declare an MCP server (stdio via \`--\`, or HTTP streamable via --url)
  remove <name> [--user]
          remove a server (project first, then user)
  list    show declared servers from both scopes
  restart <name> [--cwd <dir>]
          manual restart of a crashed server. A separate process cannot
          reach a live session's servers, so this verifies the server
          starts again (handshake + tool listing); reopen the session (or
          restart it via its client) to pick the server back up.

scopes: project (moh.json, asks consent on first use) vs user
(~/.moh/config, trusted). Use --user to target the user config.`;

export interface McpOptions {
  argv: string[];
  cwd?: string;
  /** Home dir override (tests): user-scope servers live in <home>/.moh/config. */
  home?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** Valid `mcpServers` entries from ~/.moh/config, via the config guardian. */
function parseMcpServers(raw: unknown): Record<string, McpServerEntry> {
  const entry: Record<string, McpServerEntry> = {};
  if (typeof raw !== "object" || raw === null) return entry;
  for (const [name, value] of Object.entries(raw)) {
    const ok = mcpServerEntrySchema.safeParse(value);
    if (ok.success) entry[name] = ok.data;
  }
  return entry;
}

function readUserMcpServers(file: string): Record<string, McpServerEntry> {
  return parseMcpServers(readUserConfigFile(file).mcpServers);
}

/** Read-modify-write of `mcpServers` through the guardian (preserves the rest). */
function writeUserMcpServers(file: string, mutate: (servers: Record<string, McpServerEntry>) => void): void {
  updateUserConfigFile(file, (data) => {
    const servers = parseMcpServers(data.mcpServers);
    mutate(servers);
    data.mcpServers = servers;
  });
}

export async function mcpCommand(options: McpOptions): Promise<number> {
  const out = options.stdout ?? process.stdout;
  const err = options.stderr ?? process.stderr;
  const [sub, ...rest] = options.argv;
  if (!sub || sub === "help" || sub === "--help") {
    out.write(MCP_USAGE + "\n");
    return sub ? 0 : 2;
  }
  const cwd = pathResolve(options.cwd ?? process.cwd());
  const home = options.home;
  try {
    if (sub === "add") return addServer(rest, cwd, home, out, err);
    if (sub === "remove") return removeServer(rest, cwd, home, out, err);
    if (sub === "list") return listServers(rest, cwd, home, out);
    if (sub === "restart") return restartServer(rest, cwd, home, out, err);
  } catch (e) {
    err.write(`moh mcp: ${e instanceof ArgError || e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  err.write(`moh mcp: unknown command "${sub}"\n\n${MCP_USAGE}\n`);
  return 2;
}

function addServer(argv: string[], cwd: string, home: string | undefined, out: NodeJS.WritableStream, err: NodeJS.WritableStream): number {
  const parsed = parseArgs(argv, {
    strings: ["url"],
    lists: ["env", "header"],
    booleans: ["user"],
  });
  const name = parsed.positionals[0];
  if (!name) {
    err.write("moh mcp add: server name required\n");
    return 2;
  }
  const cmd = parsed.positionals.slice(1);
  let entry: McpServerEntry;
  if (parsed.strings["url"]) {
    const headers: Record<string, string> = {};
    for (const h of parsed.lists["header"] ?? []) {
      const i = h.indexOf(":");
      if (i <= 0) {
        err.write(`moh mcp add: --header expects "Name: Value"\n`);
        return 2;
      }
      headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
    }
    entry = { type: "http", url: parsed.strings["url"], ...(Object.keys(headers).length ? { headers } : {}) };
  } else if (cmd.length > 0) {
    const env: Record<string, string> = {};
    for (const e of parsed.lists["env"] ?? []) {
      const i = e.indexOf("=");
      if (i <= 0) {
        err.write(`moh mcp add: --env expects K=V\n`);
        return 2;
      }
      env[e.slice(0, i)] = e.slice(i + 1);
    }
    entry = { type: "stdio", command: cmd[0]!, args: cmd.slice(1), ...(Object.keys(env).length ? { env } : {}) };
  } else {
    err.write('moh mcp add: pass a stdio command after "--" or --url <url>\n');
    return 2;
  }
  if (parsed.booleans["user"]) {
    const file = userConfigFile(home);
    writeUserMcpServers(file, (servers) => {
      servers[name] = entry;
    });
  } else {
    const file = join(cwd, "moh.json");
    writeMohConfig(file, upsertMcpServer(loadMohConfig(file), name, entry));
  }
  out.write(`added MCP server "${name}" (${entry.type}) to ${parsed.booleans["user"] ? userConfigFile(home) : "moh.json"}\n`);
  return 0;
}

function removeServer(argv: string[], cwd: string, home: string | undefined, out: NodeJS.WritableStream, err: NodeJS.WritableStream): number {
  const parsed = parseArgs(argv, { booleans: ["user"] });
  const name = parsed.positionals[0];
  if (!name) {
    err.write("moh mcp remove: server name required\n");
    return 2;
  }
  const projectFile = join(cwd, "moh.json");
  const userFile = userConfigFile(home);
  if (!parsed.booleans["user"]) {
    const config = loadMohConfig(projectFile);
    if (config.mcpServers?.[name]) {
      writeMohConfig(projectFile, upsertMcpServer(config, name, null));
      out.write(`removed MCP server "${name}" from moh.json\n`);
      return 0;
    }
  }
  if (readUserMcpServers(userFile)[name]) {
    writeUserMcpServers(userFile, (servers) => {
      delete servers[name];
    });
    out.write(`removed MCP server "${name}" from ${userFile}\n`);
    return 0;
  }
  err.write(`moh mcp remove: no server named "${name}" in moh.json or ${userFile}\n`);
  return 1;
}

function listServers(argv: string[], cwd: string, home: string | undefined, out: NodeJS.WritableStream): number {
  void parseArgs(argv, {});
  const project = declaredMcpServers(loadMohConfig(join(cwd, "moh.json")));
  const user = declaredUserMcpServers(userConfigFile(home));
  const all = [...project, ...user];
  if (all.length === 0) {
    out.write("no MCP servers declared (moh.json or ~/.moh/config)\n");
    return 0;
  }
  for (const s of all) {
    const target = s.transport.type === "stdio" ? `${s.transport.command} ${(s.transport.args ?? []).join(" ")}`.trim() : s.transport.url;
    const trust = s.scope === "user" || s.transport.trusted ? "trusted" : "asks on first use";
    out.write(`${s.name}  [${s.scope}, ${s.transport.type}, ${trust}]\n  ${target}\n`);
  }
  return 0;
}

async function restartServer(argv: string[], cwd: string, home: string | undefined, out: NodeJS.WritableStream, err: NodeJS.WritableStream): Promise<number> {
  const parsed = parseArgs(argv, { strings: ["cwd"] });
  const root = pathResolve(parsed.strings["cwd"] ?? cwd);
  const name = parsed.positionals[0];
  if (!name) {
    err.write("moh mcp restart: server name required\n");
    return 2;
  }
  const declared = [...declaredMcpServers(loadMohConfig(join(root, "moh.json"))), ...declaredUserMcpServers(userConfigFile(home))];
  const server = declared.find((s) => s.name === name);
  if (!server) {
    err.write(`moh mcp restart: no server named "${name}" declared\n`);
    return 1;
  }
  // A standalone restart cannot reach a running session's servers; this is
  // a health check (handshake + tools/list) proving a manual restart works.
  // The explicit command is itself the consent a project server needs.
  const runtime = new McpRuntime({ servers: [server], cwd: root, onEvent: () => {}, onConsent: () => "yes" });
  await runtime.ensureStarted();
  const [status] = runtime.status();
  await runtime.shutdown();
  if (status?.state !== "running") {
    err.write(`moh mcp restart: server "${name}" failed to start (${status?.state})\n`);
    return 1;
  }
  out.write(`restarted MCP server "${name}": ${status.tools.length} tool(s) available\n`);
  return 0;
}

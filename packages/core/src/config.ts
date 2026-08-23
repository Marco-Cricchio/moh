/**
 * moh.json: the project-level configuration file. This module owns its
 * schema, loading and writing. Endpoint profiles declared here are
 * config-only Providers (issue #29): `openai-compat` covers any
 * OpenAI-compatible endpoint (Ollama, LM Studio, DeepSeek, Kimi, GLM,
 * Qwen, Grok, OpenRouter) without writing code.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

// Defined in auth/types.ts (issue #132); reused here because auth/types
// imports nothing from config.ts — absent auth = api-key, backward compatible.
import { endpointAuthSchema } from "./auth/types";

import { mcpServerEntrySchema, type McpServerEntry } from "./mcp";
import { subagentSpecSchema } from "./subagents";
import { memoryConfigSchema } from "./memory";

const capabilitiesSchema = z
  .object({
    caching: z.boolean(),
    parallelToolCalls: z.boolean(),
    multimodal: z.boolean(),
  })
  .partial();

export const endpointProfileSchema = z.object({
  /** Endpoint name, unique in the file. Drives MOH_ENDPOINT_<NAME>_API_KEY. */
  name: z.string().min(1),
  /**
   * Implementation: built-in "anthropic" | "openai" | "google" |
   * "openai-compat", or a custom id registered via registerProvider.
   */
  type: z.string().min(1),
  /** Inline credential (keep moh.json gitignored). Falls back to the env var. */
  apiKey: z.string().optional(),
  /** Required for openai-compat; optional override for the built-ins. */
  baseUrl: z.string().optional(),
  /** Model used when a route references the endpoint without one. */
  defaultModel: z.string().optional(),
  /** Auth method (issue #132): absent = api-key, backward compatible. */
  auth: endpointAuthSchema.optional(),
  capabilities: capabilitiesSchema.optional(),
});

const permissionOverridesSchema = z.object({
  tools: z.record(z.string(), z.enum(["allow", "ask", "deny"])).optional(),
  bashAllow: z.array(z.array(z.string())).optional(),
  bashDeny: z.array(z.array(z.string())).optional(),
  pathAllow: z.array(z.string()).optional(),
  pathDeny: z.array(z.string()).optional(),
});

export const mohConfigSchema = z.object({
  /**
   * Default provider reference: "mock", a custom registered id, or
   * "endpoint/model-id" (or bare "endpoint" using its defaultModel).
   */
  provider: z.string().optional(),
  endpoints: z.array(endpointProfileSchema).optional(),
  /** Tier-2 permission rules (#31): CLI `--allow`/`--deny` flags merge on top of these. */
  permissions: z
    .object({
      overrides: permissionOverridesSchema.optional(),
    })
    .optional(),
  /** Extension sources (#34): file paths (or module ids) loaded at session start. */
  extensions: z.array(z.string().min(1)).optional(),
  /** MCP servers (#15), keyed by server name; tools become `mcp__<name>__<tool>`. */
  mcpServers: z.record(z.string(), mcpServerEntrySchema).optional(),
  /** Subagent presets (#13), keyed by name; user presets override the built-ins. */
  agents: z.record(z.string(), subagentSpecSchema).optional(),
  /** Cross-session memory (#38); `enabled: false` disables everything. */
  memory: memoryConfigSchema.optional(),
});

export type EndpointProfile = z.infer<typeof endpointProfileSchema>;
export type MohConfig = z.infer<typeof mohConfigSchema>;

/**
 * Reads moh.json. A missing or empty file is the empty config (moh works
 * zero-config with the mock provider); an invalid one is a hard error.
 */
export function loadMohConfig(
  file: string = "moh.json",
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): MohConfig {
  let raw: string;
  try {
    raw = read(file);
  } catch {
    return {};
  }
  if (!raw.trim()) return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid ${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const parsed = mohConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid ${file}: ${issues}`);
  }
  return parsed.data;
}

/** Pretty-prints and writes the full config back to moh.json. */
export function writeMohConfig(file: string, config: MohConfig): void {
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

/** Adds or replaces an endpoint profile by name (guided onboarding target). */
export function upsertEndpoint(config: MohConfig, profile: EndpointProfile): MohConfig {
  const endpoints = (config.endpoints ?? []).filter((e) => e.name !== profile.name);
  return { ...config, endpoints: [...endpoints, profile] };
}

/** Declared MCP servers of a config as scoped declarations (scope: "project"). */
export function declaredMcpServers(config: MohConfig): { name: string; scope: "project"; transport: McpServerEntry }[] {
  return Object.entries(config.mcpServers ?? {}).map(([name, transport]) => ({ name, scope: "project" as const, transport }));
}

/** Adds, replaces or removes an MCP server entry by name (target: moh.json). */
export function upsertMcpServer(config: MohConfig, name: string, entry: McpServerEntry | null): MohConfig {
  const mcpServers = { ...(config.mcpServers ?? {}) };
  if (entry) mcpServers[name] = entry;
  else delete mcpServers[name];
  return { ...config, mcpServers };
}

/** Persists a tool-level "always" answer for an MCP tool as a config override. */
export function persistToolAllow(file: string, tool: string): void {
  const config = loadMohConfig(file);
  const overrides = { ...(config.permissions?.overrides ?? {}) };
  overrides.tools = { ...(overrides.tools ?? {}), [tool]: "allow" as const };
  writeMohConfig(file, { ...config, permissions: { ...config.permissions, overrides } });
}

/** Persists server-level trust ("always" consent) for a project MCP server. */
export function persistMcpTrust(file: string, server: string): void {
  const config = loadMohConfig(file);
  const entry = config.mcpServers?.[server];
  if (!entry) return; // only project-declared servers can be persisted
  writeMohConfig(file, upsertMcpServer(config, server, { ...entry, trusted: true }));
}

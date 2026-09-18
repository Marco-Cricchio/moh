/**
 * TypeSafe / Jev configuration (#784): the `typesafe` block of the user
 * config (`~/.moh/config`, owned by the guardian, ADR-0006).
 *
 * One owner for the whole block: the Jev use cases (#786 guardrail, #787
 * routing, #788–#793) only read its shape, so two specs never edit the
 * same object with different shapes.
 *
 * The block lives in the *user* config only — never in a repo-controlled
 * moh.json: presence of an API key is what activates a first-party
 * extension, and a cloned repository must not be able to declare that on
 * the user's behalf (same posture as `mcpTrust`, #352/SEC-01).
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { readUserConfigFile, updateUserConfigFile, type UserConfigIo } from "./user-config";

/** Where the key is entered (the TUI Settings entry) — shown by the CLI hint. */
export const TYPESAFE_SETTINGS_HINT = "set the key from the TUI Settings panel (Jev / TypeSafe)";

/** Hook timeout for one Jev call, in ms (ratified default). */
export const TYPESAFE_TIMEOUT_MS_DEFAULT = 2500;

/** Canonical routing tiers (#787); the labels themselves are the contract. */
export const TYPESAFE_TIERS = ["economico", "bilanciato", "potente"] as const;
export type TypesafeTier = (typeof TYPESAFE_TIERS)[number];

/**
 * The `typesafe` section's schema. Unknown keys inside it are stripped,
 * like every other schema in the config layer.
 */
export const typesafeConfigSchema = z.object({
  /** TypeSafe API key. Present = the bundled Jev extension is active. */
  apiKey: z.string().optional(),
  /** Hook timeout for one Jev call, ms. Config only — never in the UI. */
  timeoutMs: z.number().int().positive().optional(),
  /** Model routing opt-in (#787). Default false. */
  routing: z.boolean().optional(),
  /** Tier labels for routing (#787): "<endpoint>/<model-id>" → tier. */
  tiers: z.record(z.string().min(1), z.enum(TYPESAFE_TIERS)).optional(),
});

export type TypesafeConfig = z.infer<typeof typesafeConfigSchema>;

/** The resolved runtime shape: what session assembly actually needs. */
export interface ResolvedTypesafeConfig {
  /** True when a non-empty key is present — the only activation switch. */
  active: boolean;
  /** The key (absent when inactive). Never logged, never rendered whole. */
  apiKey?: string;
  /** Effective hook timeout in ms. */
  timeoutMs: number;
  /** Routing opt-in (consumed by #787; inert here). */
  routing: boolean;
}

/**
 * Reads the `typesafe` section of a user config file. Strict when the
 * section is present (a broken block fails loudly at session start, like
 * the `provider`/`endpoints` sections); absent → `{}`.
 */
export function readTypesafeConfig(
  file: string,
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): TypesafeConfig {
  const data = readUserConfigFile(file, read);
  const raw = data.typesafe;
  if (raw === undefined) return {};
  const parsed = typesafeConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid ${file} typesafe section: ${issues}`);
  }
  return parsed.data;
}

/** Resolves the block into what the assembly consumes (no silent defaults beyond the ratified ones). */
export function resolveTypesafeConfig(block: TypesafeConfig | undefined): ResolvedTypesafeConfig {
  const apiKey = block?.apiKey?.trim();
  return {
    active: typeof apiKey === "string" && apiKey.length > 0,
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: block?.timeoutMs ?? TYPESAFE_TIMEOUT_MS_DEFAULT,
    routing: block?.routing === true,
  };
}

/** "…abcd": the only form of the key that ever reaches a screen or a log. */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.length <= 4 ? "…" : `…${trimmed.slice(-4)}`;
}

/**
 * Persists the key through the guardian (read-modify-write; unrelated
 * sections survive). Removing the key is `removeTypesafeApiKey`.
 */
export function saveTypesafeApiKey(file: string, key: string, io: UserConfigIo = {}): void {
  updateUserConfigFile(
    file,
    (data) => {
      const current = (data.typesafe ?? {}) as Record<string, unknown>;
      data.typesafe = { ...current, apiKey: key.trim() };
    },
    io,
  );
}

/** Removes the key: the extension stays unregistered from the next session on. */
export function removeTypesafeApiKey(file: string, io: UserConfigIo = {}): void {
  updateUserConfigFile(
    file,
    (data) => {
      const current = (data.typesafe ?? {}) as Record<string, unknown>;
      delete current.apiKey;
      data.typesafe = current;
    },
    io,
  );
}

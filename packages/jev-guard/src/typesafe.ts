/**
 * TypeSafe / Jev configuration (#784): the `typesafe` block of the user
 * config (`~/.moh/config`, owned by the guardian, ADR-0006).
 *
 * #826: this module lives in the extension package, not in `@moh/core`. The
 * block is the vendor's config surface, so the vendor owns its shape and the
 * core never sees a `typesafe` key, a schema or a resolved runtime object —
 * the assembly asks this package's descriptor whether the extension is
 * active, and nothing else (see `integration.ts`).
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
import { readUserConfigFile, updateUserConfigFile, type UserConfigIo } from "@moh/core";

/** Where the key is entered (the TUI Settings entry) — shown by the CLI hint. */
export const TYPESAFE_SETTINGS_HINT = "set the key from the TUI Settings panel (Jev / TypeSafe)";

/** The host scope and credential ref this extension's manifest declares
 * (#1162): the manifest and the runtime transport must name the same two.
 * Owned here (the vendor's config/identity module) so `integration.ts` can
 * use them without the index.ts cycle. */
export const TYPESAFE_HOST_SCOPE = "host:api.typesafe.ai";
export const TYPESAFE_CREDENTIAL_REF = "typesafe";

/** Hook timeout for one Jev call, in ms (ratified default). */
export const TYPESAFE_TIMEOUT_MS_DEFAULT = 2500;

/** Canonical routing tiers (#787); the labels themselves are the contract. */
export const TYPESAFE_TIERS = ["economico", "bilanciato", "potente"] as const;
export type TypesafeTier = (typeof TYPESAFE_TIERS)[number];

/**
 * The `typesafe` section's schema: unknown keys inside it are stripped,
 * like every other schema in the config layer.
 *
 * #1162: the TypeSafe key is a credential — stored under the ref
 * `typesafe` in the OS keychain (0600-file fallback), never in config. The
 * schema keeps reading a legacy plaintext `apiKey` only so a config that
 * still carries one can be migrated (once, by the client's assembly:
 * `migrateTypesafeKey`), never to keep two homes.
 */
export const typesafeConfigSchema = z.object({
  /** Legacy (#1162): a pre-migration plaintext key, read once to migrate. */
  apiKey: z.string().optional(),
  /** Hook timeout for one Jev call, ms. Config only — never in the UI. */
  timeoutMs: z.number().int().positive().optional(),
  /**
   * The bash guardrail's flag (#1041). Default true (absent = armed):
   * the guardrail is what the key activates, so opting *out* is the
   * explicit gesture and `false` is the only value that disarms it. Read
   * at session assembly, like every other use-case flag — a running
   * session keeps the state it started in, and `/jev` moves it for that
   * session only.
   */
  guardrail: z.boolean().optional(),
  /** Model routing opt-in (#787). Default false. */
  routing: z.boolean().optional(),
  /** Anti-injection opt-in (#791). Default false — it sends your message. */
  injection: z.boolean().optional(),
  /**
   * Prompt classification (#788). Default true: the judged state is the
   * last user message (≤ 2 KiB) only, the output is a hint subordinate to
   * the project's instructions, and it is what makes the MPM per-turn gate
   * meaningful. Set false to turn it (and the gate) off.
   */
  classification: z.boolean().optional(),
  /** End-of-task quality gate opt-in (#789). Default false — it sends the
   * changed code's diff to TypeSafe. */
  lint: z.boolean().optional(),
  /** MPM seed rerank opt-in (#790). Default false: when the orientation
   * plan's seed set goes over-threshold (> 5 files), Jev ranks the
   * candidates and the top few become the plan instead of no plan. */
  rerank: z.boolean().optional(),
  /** Skill suggestion opt-in (#793). Default false: two calls per turn
   * rank the skill roster and yield at most one suggested skill. */
  skills: z.boolean().optional(),
  /** Tier labels for routing (#787): "<endpoint>/<model-id>" → tier. */
  tiers: z.record(z.string().min(1), z.enum(TYPESAFE_TIERS)).optional(),
});

export type TypesafeConfig = z.infer<typeof typesafeConfigSchema>;

/** The resolved runtime shape: what session assembly actually needs. */
export interface ResolvedTypesafeConfig {
  /**
   * #1162: true when the credential store holds the `typesafe` ref — or a
   * legacy plaintext key still waits to be migrated. The stored credential
   * is the only activation switch, exactly as the config key used to be.
   */
  active: boolean;
  /**
   * #1162 (legacy): a plaintext key still present in config, awaiting the
   * one-time migration into the credential store. Never read by the
   * runtime — the client migrates it at assembly.
   */
  legacyApiKey?: string;
  /** Effective hook timeout in ms. */
  timeoutMs: number;
  /**
   * The bash guardrail's flag (#1041). On unless the config says
   * otherwise: `false` is a deliberate opt-out, and a stored key with the
   * guardrail off runs every other requested use case with none of the
   * bash judgments.
   */
  guardrail: boolean;
  /** Routing opt-in (#787). Off by default — routing turns is a choice. */
  routing: boolean;
  /**
   * Anti-injection opt-in (#791). Off by default: the check sends the
   * user's message text (≤ 4 KiB) to TypeSafe on every turn, and the text
   * of every `fetch`/`browser` result, which is a privacy choice.
   */
  injection: boolean;
  /** Explicit tier labels (#787): `<endpoint>/<model-id>` → tier. `{}` when
   * none — the routing code falls back to its price heuristic. */
  tiers: Record<string, TypesafeTier>;
  /**
   * Prompt classification (#788). On by default: the judged state is the
   * last user message (≤ 2 KiB) only, and the hint it yields is subordinate
   * to the project's own instructions. It is also what makes the MPM
   * per-turn gate meaningful, so it drives both consumers.
   */
  classification: boolean;
  /** End-of-task quality gate opt-in (#789). Off by default. */
  lint: boolean;
  /** MPM seed rerank opt-in (#790). Off by default. */
  rerank: boolean;
  /** Skill suggestion opt-in (#793). Off by default. */
  skills: boolean;
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

/** Resolves the block into what the assembly consumes (no silent defaults beyond the ratified ones).
 *
 * #1162: `stored` is the credential store's answer for the `typesafe` ref —
 * `store.get(REF) !== undefined`. Active = stored credential, or a legacy
 * plaintext key that has not been migrated yet (so today's behavior — the
 * extension runs — survives the move). */
export function resolveTypesafeConfig(block: TypesafeConfig | undefined, stored = false): ResolvedTypesafeConfig {
  const legacyApiKey = block?.apiKey?.trim();
  const active = stored || (typeof legacyApiKey === "string" && legacyApiKey.length > 0);
  return {
    active,
    ...(legacyApiKey ? { legacyApiKey } : {}),
    timeoutMs: block?.timeoutMs ?? TYPESAFE_TIMEOUT_MS_DEFAULT,
    guardrail: block?.guardrail !== false,
    routing: block?.routing === true,
    injection: block?.injection === true,
    classification: block?.classification !== false,
    lint: block?.lint === true,
    rerank: block?.rerank === true,
    skills: block?.skills === true,
    tiers: block?.tiers ?? {},
  };
}

/** "…abcd": the only form of the key that ever reaches a screen or a log. */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.length <= 4 ? "…" : `…${trimmed.slice(-4)}`;
}

/**
 * #1162: the one-time key migration — moves a legacy plaintext
 * `typesafe.apiKey` from the user config into the credential store and
 * deletes it from the file. Idempotent: no stored value and no plaintext
 * is a no-op, and a plaintext equal to the stored credential (both
 * trimmed) is converged — removed. A plaintext that *diverges* from the
 * stored credential stays in the file (#1206): a migration never deletes
 * a secret it did not save, and the divergence stays visible (`moh jev
 * status` reports it as legacy) until the user reconciles it from the
 * Settings entry (re-save or Remove). The stored credential keeps
 * winning at runtime. Called by the client at assembly (the client owns
 * the config surface of what it ships) and by the Settings entry's mount,
 * so a pre-#1162 config converges on the store without user action.
 */
export function migrateTypesafeKey(
  store: { get(ref: string): string | undefined; set(ref: string, value: string): void },
  file: string,
  io: UserConfigIo = {},
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): void {
  // A malformed block is nothing to migrate (the CLI reports it loudly
  // elsewhere): migration must never be the thing that fails an assembly.
  let legacy: string | undefined;
  try {
    legacy = resolveTypesafeConfig(readTypesafeConfig(file, read)).legacyApiKey;
  } catch {
    return;
  }
  if (legacy === undefined) return;
  const stored = store.get(TYPESAFE_CREDENTIAL_REF);
  if (stored === undefined) store.set(TYPESAFE_CREDENTIAL_REF, legacy);
  // Converged (same secret in two homes) or a true migration: the file
  // gives the value up. A diverging plaintext is not ours to delete.
  if (stored === undefined || stored === legacy) removeTypesafeApiKey(file, io);
}

/**
 * #1162: persists the key as the credential `typesafe` (the caller
 * validates first, per the ratified key-save behaviour). The config file
 * is left untouched — and a legacy plaintext key, if one lingers, is
 * removed: the store is the only home from here on.
 */
export function saveTypesafeApiKey(
  store: { set(ref: string, value: string): void },
  key: string,
  file?: string,
  io: UserConfigIo = {},
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): void {
  const trimmed = key.trim();
  store.set(TYPESAFE_CREDENTIAL_REF, trimmed);
  if (file !== undefined && resolveTypesafeConfig(readTypesafeConfig(file, read)).legacyApiKey !== undefined) {
    removeTypesafeApiKey(file, io);
  }
}

/** #1162: removes the credential: the extension stays unregistered from the next session on. */
export function removeTypesafeKey(store: { delete(ref: string): boolean }): void {
  store.delete(TYPESAFE_CREDENTIAL_REF);
}

/**
 * Persists the guardrail flag (#1041) — the Settings row's and
 * `moh jev guardrail on|off`'s writer.
 *
 * `true` is what an absent key resolves to (`resolveTypesafeConfig`), so
 * switching the guardrail back on leaves an explicit `guardrail: true` in
 * the file rather than a deletion: the row states the flag the user
 * chose, not the absence of one. Read at session assembly like every
 * other use-case flag — the running session keeps the state it started
 * in, and only `/jev` moves it inside one.
 */
export function saveTypesafeGuardrail(file: string, enabled: boolean, io: UserConfigIo = {}): void {
  updateUserConfigFile(
    file,
    (data) => {
      const current = (data.typesafe ?? {}) as Record<string, unknown>;
      data.typesafe = { ...current, guardrail: enabled };
    },
    io,
  );
}

/**
 * Persists the model-routing opt-in (#787) — the Settings toggle's writer.
 * Read at session assembly: a running session keeps the flag it started
 * with (the router is built once, with the session).
 */
export function saveTypesafeRouting(file: string, enabled: boolean, io: UserConfigIo = {}): void {
  updateUserConfigFile(
    file,
    (data) => {
      const current = (data.typesafe ?? {}) as Record<string, unknown>;
      data.typesafe = { ...current, routing: enabled };
    },
    io,
  );
}

/**
 * Persists the anti-injection opt-in (#791) — the Settings toggle's
 * writer, same lifecycle as the routing flag: read at session assembly, so
 * a running session keeps what it started with.
 */
export function saveTypesafeInjection(file: string, enabled: boolean, io: UserConfigIo = {}): void {
  updateUserConfigFile(
    file,
    (data) => {
      const current = (data.typesafe ?? {}) as Record<string, unknown>;
      data.typesafe = { ...current, injection: enabled };
    },
    io,
  );
}

/**
 * Persists the quality-gate opt-in (#789) — the Settings toggle's writer,
 * same lifecycle as the routing and injection flags: read at session
 * assembly, so a running session keeps what it started with.
 */
export function saveTypesafeLint(file: string, enabled: boolean, io: UserConfigIo = {}): void {
  updateUserConfigFile(
    file,
    (data) => {
      const current = (data.typesafe ?? {}) as Record<string, unknown>;
      data.typesafe = { ...current, lint: enabled };
    },
    io,
  );
}

/**
 * Persists the MPM seed-rerank opt-in (#790) — the Settings toggle's
 * writer, same lifecycle as the other flags: read at session assembly,
 * so a running session keeps what it started with.
 */
export function saveTypesafeRerank(file: string, enabled: boolean, io: UserConfigIo = {}): void {
  updateUserConfigFile(
    file,
    (data) => {
      const current = (data.typesafe ?? {}) as Record<string, unknown>;
      data.typesafe = { ...current, rerank: enabled };
    },
    io,
  );
}

/**
 * Persists the prompt-classification opt-in (#788) — the Settings toggle's
 * writer. On by default, so `false` is the opt-out: the flag is read at
 * session assembly like its siblings. (#833: the row existed in the config
 * schema from #788 on, but had no writer and no Settings row.)
 */
export function saveTypesafeClassification(file: string, enabled: boolean, io: UserConfigIo = {}): void {
  updateUserConfigFile(
    file,
    (data) => {
      const current = (data.typesafe ?? {}) as Record<string, unknown>;
      data.typesafe = { ...current, classification: enabled };
    },
    io,
  );
}

/**
 * Persists the skill-suggestion opt-in (#793) — the Settings toggle's
 * writer, same lifecycle as the other flags: read at session assembly.
 */
export function saveTypesafeSkills(file: string, enabled: boolean, io: UserConfigIo = {}): void {
  updateUserConfigFile(
    file,
    (data) => {
      const current = (data.typesafe ?? {}) as Record<string, unknown>;
      data.typesafe = { ...current, skills: enabled };
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

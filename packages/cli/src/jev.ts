/**
 * `moh jev status` (#784) and `moh jev <use case> on|off` (#833): the
 * TypeSafe/Jev integration's **persistent** configuration, read from and
 * written to the `typesafe` block of `~/.moh/config`.
 *
 * The status path is config read only, no live probe: the key is validated
 * once, when it is saved (TUI Settings panel), so a status call must stay
 * offline and side-effect free. A stored key *is* the activation switch
 * (no separate toggle), hence "inactive" only ever means "no key here".
 *
 * The set path is the shell twin of the Settings entries: it writes the same
 * flags through the same guardian helpers, so the two can never drift. The
 * values take effect when a session is assembled — the next one.
 *
 * Warm control (switching a use case inside a running session) is
 * deliberately absent here: the CLI has no live session to command, so that
 * belongs to the TUI's `/jev` modal (#832/#833).
 */
import { userConfigFile } from "@moh/core";
// #826: the `typesafe` config block belongs to the extension that owns it,
// so the client reads and writes it through the vendor package, not through
// the core's public surface.
import {
  TYPESAFE_SETTINGS_HINT,
  maskApiKey,
  readTypesafeConfig,
  resolveTypesafeConfig,
  saveTypesafeClassification,
  saveTypesafeInjection,
  saveTypesafeLint,
  saveTypesafeRerank,
  saveTypesafeRouting,
  saveTypesafeSkills,
  type ResolvedTypesafeConfig,
} from "@moh/jev-guard";
import { ArgError, parseArgs } from "./args";

/**
 * Which use case a name refers to, and how it is written. One table owns the
 * names, the writer and the label the messages use, so `moh jev <name>` and
 * the status report can never disagree about what exists.
 *
 * The guardrail is absent on purpose: it has no config flag (#784 — a stored
 * key is the switch), so there is nothing here to persist. It is refused as
 * *session-only* rather than silently accepted.
 */
const USE_CASES = {
  routing: { label: "model routing", write: saveTypesafeRouting },
  injection: { label: "anti-injection", write: saveTypesafeInjection },
  classification: { label: "prompt classification", write: saveTypesafeClassification },
  lint: { label: "quality gate", write: saveTypesafeLint },
  rerank: { label: "seed rerank", write: saveTypesafeRerank },
  skills: { label: "skill suggestion", write: saveTypesafeSkills },
} as const;

type UseCaseName = keyof typeof USE_CASES;

const USE_CASE_NAMES = Object.keys(USE_CASES) as UseCaseName[];

/** The names that are real but not persistable — for one honest error line. */
const SESSION_ONLY = ["guardrail"];

export const JEV_USAGE = `usage: moh jev status [--json]
       moh jev <use-case> on|off

The TypeSafe/Jev configuration: a stored API key (which is what activates
the bundled Jev extension — there is no separate toggle) and the per-use-case
opt-ins.

  status        the current configuration (see the flags below)
  <use-case> on|off
                write one use-case flag to ~/.moh/config — persistent:
                what a new session starts in

  --json        one-line machine-readable JSON with status: active, keyHint
                (absent when inactive), timeoutMs, routing, injection, lint,
                classification, rerank, skills

Use cases: routing, injection, classification, lint, rerank, skills.
Session-only (no flag to write): guardrail — it has no configuration switch
at all (a stored key is what turns it on), so it can only be switched off for
one session, from the TUI's /jev modal.

Switching a use case inside a running session is /jev's job too: a session
command is session-warm and this command is persistent — that is the whole
difference. Nothing here makes a call to TypeSafe: the key is validated when
it is saved, from the TUI Settings panel (Jev / TypeSafe), and is never
printed — only its masked tail. The status of an active or inactive Jev
exits 0; a malformed "typesafe" section and any usage error exit 2.`;

/** The one column layout both status lines share (labels padded to the
 * widest, like the sibling reports). */
const COL = 14;

function row(label: string, value: string): string {
  return `  ${label.padEnd(COL)}  ${value}\n`;
}

/** The `--json` object, key order pinned: `active`, `keyHint`, `timeoutMs`,
 * `routing`, `injection`, `lint`, `classification`, `rerank`, `skills`.
 * `keyHint` is omitted when inactive rather than
 * nulled — the key does not exist in that state. */
function statusJson(cfg: ResolvedTypesafeConfig): Record<string, unknown> {
  return {
    active: cfg.active,
    ...(cfg.apiKey !== undefined ? { keyHint: maskApiKey(cfg.apiKey) } : {}),
    timeoutMs: cfg.timeoutMs,
    routing: cfg.routing,
    injection: cfg.injection,
    lint: cfg.lint,
    classification: cfg.classification,
    rerank: cfg.rerank,
    skills: cfg.skills,
  };
}

function renderStatus(cfg: ResolvedTypesafeConfig): string {
  const lines = [
    row(
      "jev",
      cfg.apiKey !== undefined
        ? `active (key ${maskApiKey(cfg.apiKey)}, timeout ${cfg.timeoutMs}ms)`
        : "inactive",
    ),
    row("routing", cfg.routing ? "on" : "off"),
    row("injection", cfg.injection ? "on" : "off"),
    row("quality gate", cfg.lint ? "on" : "off"),
    row("classification", cfg.classification ? "on" : "off"),
    row("rerank", cfg.rerank ? "on" : "off"),
    row("skills", cfg.skills ? "on" : "off"),
  ];
  // The way back in, printed only when it is missing: with a key stored
  // there is nothing to activate.
  if (!cfg.active) lines.push(row("hint", TYPESAFE_SETTINGS_HINT));
  return lines.join("");
}

export async function jevCommand({
  argv,
  home,
  stdout = process.stdout,
  stderr = process.stderr,
}: {
  argv: string[];
  home?: string;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv, { booleans: ["json"] });
  } catch (e) {
    if (e instanceof ArgError) {
      stderr.write(`moh jev: ${e.message}\n\n${JEV_USAGE}\n`);
      return 2;
    }
    throw e;
  }
  const [sub, ...extra] = parsed.positionals;
  if (sub !== undefined && SESSION_ONLY.includes(sub)) {
    // Real, but not persistable: the guardrail has no flag (#784). Saying
    // "unknown use case" here would be a lie about the product.
    stderr.write(
      `moh jev ${sub}: the guardrail has no persistent switch — a stored API key is what turns it on.\n` +
        `Switch it off for one session from the TUI's /jev modal.\n\n${JEV_USAGE}\n`,
    );
    return 2;
  }
  if (sub !== "status" && !(sub !== undefined && sub in USE_CASES)) {
    stderr.write(
      `moh jev: ${sub === undefined ? "a subcommand is required" : `unknown use case "${sub}"`}\n\n${JEV_USAGE}\n`,
    );
    return 2;
  }

  const file = userConfigFile(home);

  if (sub !== "status") {
    const usecase = sub as UseCaseName;
    const [action, ...rest] = extra;
    if (action !== "on" && action !== "off") {
      stderr.write(
        `moh jev ${usecase}: an action is required — "on" or "off"\n\n${JEV_USAGE}\n`,
      );
      return 2;
    }
    if (rest.length > 0) {
      stderr.write(`moh jev ${usecase}: unexpected argument "${rest[0]}"\n\n${JEV_USAGE}\n`);
      return 2;
    }
    if (parsed.booleans["json"]) {
      stderr.write(`moh jev ${usecase}: --json belongs to status\n\n${JEV_USAGE}\n`);
      return 2;
    }
    const { label, write } = USE_CASES[usecase];
    try {
      // Read the block strictly before writing into it: a section we cannot
      // parse is refused loudly rather than quietly accepted and rewritten
      // around (the user would read "on" and get a config that still fails
      // at the next session).
      readTypesafeConfig(file);
      write(file, action === "on");
    } catch (e) {
      // A broken user config is a user error, reported as one — never
      // half-written and never flattened into a reassuring line.
      stderr.write(`moh jev ${usecase}: ${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
    stdout.write(`${label}: ${action} · from your next session (the config in ${file})\n`);
    return 0;
  }

  if (extra.length > 0) {
    stderr.write(`moh jev status: unexpected argument "${extra[0]}"\n\n${JEV_USAGE}\n`);
    return 2;
  }

  let cfg: ResolvedTypesafeConfig;
  try {
    cfg = resolveTypesafeConfig(readTypesafeConfig(file));
  } catch (e) {
    // A malformed `typesafe` block is a broken user config: it fails loudly
    // here (as it does at session assembly) rather than being flattened
    // into a reassuring "inactive".
    stderr.write(`moh jev status: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  stdout.write(
    parsed.booleans["json"] ? `${JSON.stringify(statusJson(cfg))}\n` : renderStatus(cfg),
  );
  return 0;
}

/**
 * The names a user may write, exported so a test can pin them against the
 * usage text above — the usage is extracted verbatim by the manual
 * generator, so it cannot interpolate this list.
 */
export const JEV_USE_CASE_NAMES = USE_CASE_NAMES;
/** The names that are real but have no persistent flag. */
export const JEV_SESSION_ONLY_NAMES = SESSION_ONLY;

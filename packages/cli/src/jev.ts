/**
 * `moh jev status` (#784): the TypeSafe/Jev integration's configuration,
 * read from the `typesafe` block of `~/.moh/config` — and nothing else.
 *
 * Deliberately config read only, no live probe: the key is validated once,
 * when it is saved (TUI Settings panel), so a status call must stay
 * offline and side-effect free. A stored key *is* the activation switch
 * (no separate toggle), hence "inactive" only ever means "no key here".
 */
import {
  TYPESAFE_SETTINGS_HINT,
  maskApiKey,
  readTypesafeConfig,
  resolveTypesafeConfig,
  userConfigFile,
  type ResolvedTypesafeConfig,
} from "@moh/core";
import { ArgError, parseArgs } from "./args";

export const JEV_USAGE = `usage: moh jev status [--json]

The TypeSafe/Jev configuration state: a stored API key (which is what
activates the bundled Jev extension — there is no separate toggle) and
the model-routing opt-in.

  --json        one-line machine-readable JSON: active, keyHint (absent
                when inactive), timeoutMs, routing

Config read only: no call is ever made to TypeSafe. The key is validated
when it is saved, from the TUI Settings panel (Jev / TypeSafe), and is
never printed here — only its masked tail. The status of an active or
inactive Jev exits 0; a malformed "typesafe" section exits 2.`;

/** The one column layout both status lines share (labels padded to the
 * widest, like the sibling reports). */
const COL = 7;

function row(label: string, value: string): string {
  return `  ${label.padEnd(COL)}  ${value}\n`;
}

/** The `--json` object, key order pinned: `active`, `keyHint`, `timeoutMs`,
 * `routing`. `keyHint` is omitted when inactive rather than nulled — the
 * key does not exist in that state. */
function statusJson(cfg: ResolvedTypesafeConfig): Record<string, unknown> {
  return {
    active: cfg.active,
    ...(cfg.apiKey !== undefined ? { keyHint: maskApiKey(cfg.apiKey) } : {}),
    timeoutMs: cfg.timeoutMs,
    routing: cfg.routing,
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
  if (sub !== "status") {
    stderr.write(
      `moh jev: ${sub === undefined ? "a subcommand is required" : `unknown subcommand "${sub}"`}\n\n${JEV_USAGE}\n`,
    );
    return 2;
  }
  if (extra.length > 0) {
    stderr.write(`moh jev status: unexpected argument "${extra[0]}"\n\n${JEV_USAGE}\n`);
    return 2;
  }

  let cfg: ResolvedTypesafeConfig;
  try {
    cfg = resolveTypesafeConfig(readTypesafeConfig(userConfigFile(home)));
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

/**
 * Minimal argv parser: no dependencies, GNU-style `--flag value`,
 * `--flag=value`, boolean flags, and positionals. Repeatable string
 * flags accumulate; last write wins for scalar strings and booleans.
 */
export interface ParsedArgs {
  positionals: string[];
  strings: Record<string, string | undefined>;
  lists: Record<string, string[]>;
  booleans: Record<string, boolean>;
}

export class ArgError extends Error {}

export function parseArgs(
  argv: string[],
  spec: { strings?: string[]; lists?: string[]; booleans?: string[] } = {},
): ParsedArgs {
  const { strings = [], lists = [], booleans = [] } = spec;
  const known = new Set([...strings, ...lists, ...booleans]);
  const parsed: ParsedArgs = { positionals: [], strings: {}, lists: {}, booleans: {} };
  let i = 0;
  const takeValue = (flag: string): string => {
    i += 1;
    const value = argv[i];
    if (value === undefined) throw new ArgError(`missing value for --${flag}`);
    return value;
  };
  const setValue = (flag: string, value: string): void => {
    if (lists.includes(flag)) (parsed.lists[flag] ??= []).push(value);
    else if (strings.includes(flag)) parsed.strings[flag] = value;
    else if (booleans.includes(flag)) {
      if (value !== "true" && value !== "false") throw new ArgError(`--${flag} expects true|false`);
      parsed.booleans[flag] = value === "true";
    } else throw new ArgError(`unknown flag --${flag}`);
  };
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--") {
      parsed.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const flag = (eq === -1 ? arg.slice(2) : arg.slice(2, eq));
      if (!known.has(flag)) throw new ArgError(`unknown flag --${flag}`);
      if (booleans.includes(flag)) {
        if (eq === -1) parsed.booleans[flag] = true;
        else setValue(flag, arg.slice(eq + 1));
      } else if (eq !== -1) setValue(flag, arg.slice(eq + 1));
      else setValue(flag, takeValue(flag));
    } else if (arg.startsWith("-") && arg.length > 1) {
      throw new ArgError(`unknown flag ${arg}`);
    } else {
      parsed.positionals.push(arg);
    }
    i += 1;
  }
  return parsed;
}

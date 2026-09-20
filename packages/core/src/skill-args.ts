/**
 * Prompt snippets (#765): parameterized arguments for skills. A skill
 * body may carry placeholders that are substituted when the turn-scoped
 * `SkillPrompt.text` is assembled. Only known patterns are touched;
 * every other `$` stays literal.
 *
 * - Positional: `$1`, `$2`, … `$9`; `$@` joins all arguments with spaces.
 * - Named with default: `${name:-default}`; named args arrive as
 *   `key=value` tokens mixed with the positional ones.
 * - An unfilled positional or a name without a default resolves to the
 *   empty string (the caller decides whether to pre-fill the composer).
 */

export interface SkillArgs {
  /** Positional arguments: args[0] is `$1`. */
  positional: string[];
  /** Named arguments, parsed from `key=value` tokens. */
  named: Record<string, string>;
}

/**
 * Parses raw invocation tokens (everything after the skill name in a
 * slash invocation) into positional and named arguments. A token of the
 * form `key=value` becomes a named argument; everything else is
 * positional, in order.
 */
export function parseSkillArgs(tokens: readonly string[]): SkillArgs {
  const positional: string[] = [];
  const named: Record<string, string> = {};
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(token.slice(0, eq))) {
      named[token.slice(0, eq)] = token.slice(eq + 1);
    } else {
      positional.push(token);
    }
  }
  return { positional, named };
}

/**
 * True when the body carries at least one #765 placeholder. Clients use
 * it to pick the argument-bearing invocation path; keeps the grammar in
 * one place next to `substituteSkillArgs`.
 */
export function hasSkillPlaceholders(text: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_-]*(?::-[^}]*)?\}|\$@|\$[1-9]/.test(text);
}

/**
 * Substitutes argument placeholders in a skill body. `$N` reads
 * `args.positional[N-1]`; `$@` joins every positional argument;
 * `${name:-default}` reads `args.named[name]`, falling back to
 * `default` (possibly empty) when absent. Unknown `$` sequences and
 * `${...}` forms pass through unchanged.
 */
export function substituteSkillArgs(text: string, args: SkillArgs): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_-]*)(?::-([^}]*))?\}|\$@|\$([1-9])/g, (match, name, fallback, digit) => {
    if (name !== undefined) return args.named[name] ?? fallback ?? "";
    if (match === "$@") return args.positional.join(" ");
    return args.positional[Number(digit) - 1] ?? "";
  });
}

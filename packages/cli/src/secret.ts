/**
 * `moh secret set/rm/list` (#1161, ADR-0069): the user-mint surface for
 * extension secrets. The user mints, always — no extension API creates a
 * credential. Values are read from stdin (never argv, so no `ps` leak),
 * stored through the same core seam sessions use, and never printed back:
 * `list` shows names only, a set over an existing ref replaces silently.
 */
import { defaultCredentialStore, validateCredentialScope } from "@moh/core";

export const SECRET_USAGE = `usage: moh secret set <ref>
       moh secret rm <ref>
       moh secret list

User-owned extension secrets (ADR-0069): named credentials an extension
addresses by ref (\`credential:deploy-key\` in its manifest) and the host
injects at request time. Extensions never see the value — only you can.

  set <ref>     create or replace a secret; the value is read from stdin
  rm <ref>      delete a secret
  list          the stored ref names (values are never displayed)

Storage is the OS keychain when available, a 0600 file under ~/.moh
otherwise. Grant an extension one with \`credential:<ref>\` in its manifest
capabilities; two extensions granted the same ref share the secret.`;

export async function secretCommand({
  argv,
  home,
  stdin = Bun.stdin.stream(),
  stdout = process.stdout,
  stderr = process.stderr,
}: {
  argv: string[];
  home?: string;
  stdin?: ReadableStream<Uint8Array>;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}): Promise<number> {
  const [sub, ref] = argv;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    stdout.write(`${SECRET_USAGE}\n`);
    return sub === undefined ? 2 : 0;
  }
  // The store takes the bare user home and owns the `.moh` join itself —
  // passing a dotdir here would double it (`~/.moh/.moh/secrets.json`).
  const store = defaultCredentialStore(home ?? process.env.HOME ?? ".");

  if (sub === "set") {
    if (!ref) {
      stderr.write(`moh secret set: a ref is required\n\n${SECRET_USAGE}\n`);
      return 2;
    }
    const valid = validateCredentialScope(`credential:${ref}`);
    if (!valid.ok) {
      stderr.write(`moh secret set: ${valid.message}\n`);
      return 2;
    }
    const value = (await new Response(stdin).text()).replace(/\r?\n$/, "");
    if (value === "") {
      stderr.write(`moh secret set: empty value — paste or pipe the secret on stdin\n`);
      return 2;
    }
    try {
      store.set(ref, value);
    } catch (e) {
      // A store failure (locked keychain, unwritable file) must never read
      // as "stored": loud, with the store's own message.
      stderr.write(`moh secret set: could not store \`${ref}\`: ${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
    stdout.write(`secret \`${ref}\` stored\n`);
    return 0;
  }
  if (sub === "rm") {
    if (!ref) {
      stderr.write(`moh secret rm: a ref is required\n\n${SECRET_USAGE}\n`);
      return 2;
    }
    let removed: boolean;
    try {
      removed = store.delete(ref);
    } catch (e) {
      stderr.write(`moh secret rm: could not delete \`${ref}\`: ${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
    if (removed) {
      stdout.write(`secret \`${ref}\` deleted\n`);
      return 0;
    }
    stderr.write(`moh secret rm: no secret named \`${ref}\`\n`);
    return 1;
  }
  if (sub === "list") {
    let names: string[];
    try {
      names = store.list();
    } catch (e) {
      stderr.write(`moh secret list: could not read the store: ${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
    if (names.length === 0) stdout.write("no secrets stored\n");
    for (const name of names) stdout.write(`${name}\n`);
    return 0;
  }
  stderr.write(`moh secret: unknown command "${sub}"\n\n${SECRET_USAGE}\n`);
  return 2;
}

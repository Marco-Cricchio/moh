/**
 * The Jev integration descriptor (#826): everything `@moh/core` used to do
 * for this extension by hand, moved to the package that owns it.
 *
 * The boundary this module restores: the core knows *how* to host a bundled
 * extension (a source with an activation predicate, a factory and an
 * optional wiring step — `bundled-extensions.ts`); it knows nothing about
 * Jev. Concretely, the couplings #826 recorded:
 *
 * 1. `@moh/core` no longer imports `@moh/jev-guard` — the client mounts this
 *    source through `SessionFromConfigOptions.bundledExtensions`, and a bare
 *    library user assembles a session with no Jev at all.
 * 2. The `typesafe` block's schema, resolver and writers live here
 *    (`typesafe.ts`), not in the core's public surface.
 * 3. The assembly no longer reads this extension's `state` keys by name:
 *    `wire` below does that, and all the core learns is that an extension
 *    may contribute a per-turn gate and a rerank hook.
 * 4. The `typesafe` bookkeeping (config read, pool, roster) is expressed
 *    against the generic activation context.
 *
 * Activation is unchanged from the user's point of view: the API key in the
 * Settings entry *is* the switch. `isActive` reads the config and nothing
 * else — no side effects, no writes, no network.
 */
import { readFileSync } from "node:fs";
import type { BundledActivationContext, BundledInstanceReader, BundledWiring } from "@moh/core";
import { createJevGuardExtension } from "./index";
import { readTypesafeConfig, resolveTypesafeConfig } from "./typesafe";

/**
 * The extension's registered name.
 *
 * Deliberately a literal, not an import of `index.ts`'s `JEV_GUARD_NAME`:
 * `index.ts` re-exports this module, so reading its binding at module-eval
 * time would hit the temporal dead zone (a cycle: index → integration →
 * index). The two must stay equal, and `integration.test.ts` pins that.
 */
const NAME = "jev-guard";

/** Reads the user config file, tolerating a missing one. */
const readFile = (file: string): string => readFileSync(file, "utf8");

/**
 * The source the client mounts. `activate` receives the generic context
 * (mohHome, cwd, config file, endpoints, pool, roster) and resolves the use
 * cases exactly as the assembly used to.
 */
export const jevBundledSource = {
  name: NAME,

  /** Effect-free: a stored, non-empty API key is the only activation switch. */
  isActive(readConfig: (file: string) => string, configFile: string): boolean {
    try {
      // The reader is the caller's: the activation fact is the *caller's*
      // question ("should this run?"), asked through whatever read the
      // caller trusts — a file read here, an in-memory config in a test.
      return resolveTypesafeConfig(readTypesafeConfig(configFile, readConfig)).active;
    } catch {
      // A malformed `typesafe` block is a user error the CLI reports
      // (`moh jev status` exits 2). For the assembly it means "not active":
      // a broken optional config must never fail a session that is otherwise
      // perfectly usable.
      return false;
    }
  },

  activate(context: BundledActivationContext): unknown {
    const typesafe = resolveTypesafeConfig(readTypesafeConfig(context.configFile, readFile));
    return createJevGuardExtension({
      apiKey: typesafe.apiKey!,
      ...(typesafe.timeoutMs !== undefined ? { timeoutMs: typesafe.timeoutMs } : {}),
      routing: { pool: context.modelPool, labels: typesafe.tiers },
      enabled: typesafe.routing,
      injection: typesafe.injection,
      classification: typesafe.classification,
      rerank: typesafe.rerank,
      ...(typesafe.skills ? { skills: { roster: context.skillRoster } } : {}),
      ...(typesafe.lint ? { lint: { root: context.cwd } } : {}),
    });
  },

  /**
   * The two capabilities the assembly used to wire by reaching into this
   * extension's private state. The core supplies the slot and the plumbing
   * (find the instance, guard the shape); this package supplies the keys and
   * the semantics, and nothing else in the tree can name them.
   */
  wire(readInstances: BundledInstanceReader, wiring: BundledWiring): void {
    const state = () => readInstances().find((i) => i.def.name === NAME)?.state;
    wiring.turnGate = () => {
      const read = state()?.["mpmGate"];
      return read === true ? true : read === false ? false : undefined;
    };
    // The extension publishes its judge on `state` when the use case is on;
    // a lazily-read slot is the whole point (the instance may not exist yet
    // when this runs, and by the time the hook is called `ready()` has run).
    wiring.rerank = (request) => {
      const hook = state()?.["rerank"];
      if (typeof hook !== "function") return Promise.resolve(null);
      return (hook as (r: typeof request) => ReturnType<NonNullable<BundledWiring["rerank"]>>)(request);
    };
  },
};

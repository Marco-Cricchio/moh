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
 * Settings entry *is* the switch. `evaluateActive` reads the config and
 * nothing else — no side effects, no writes, no network — and the **client**
 * calls it (the client owns the config surface of what it ships); the core
 * only ever sees the boolean.
 */
import { readFileSync } from "node:fs";
import type { BundledActivationContext, BundledInstanceReader, BundledWiring } from "@moh/core";
import { createJevGuardExtension } from "./index";
import { TYPESAFE_CREDENTIAL_REF, TYPESAFE_HOST_SCOPE, migrateTypesafeKey, readTypesafeConfig, resolveTypesafeConfig } from "./typesafe";

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

  /**
   * ADR-0061 + #1162: this package's own manifest, mirrored in
   * `moh.extension.json` at the package root (the physical file is what a
   * registry install verifies; this descriptor is what a bundled
   * registration checks the subset rule against). Jev's network life
   * crosses the host seam: `host:api.typesafe.ai` + `credential:typesafe`
   * are the whole grant — the endpoint is fixed, the key is resolved
   * host-side, and no other host is reachable.
   */
  manifest: {
    // T7 (#1165): `tool:git` joins the grant — the guardrail's snapshots and
    // the lint gate's diffs read the repository through the seam's read-only
    // `git` tool (whole-tool grant, reads enforced inside the tool).
    capabilities: [TYPESAFE_HOST_SCOPE, `credential:${TYPESAFE_CREDENTIAL_REF}`, "tool:git"] as string[],
  },

  /**
   * Effect-free: a stored `typesafe` credential — or a legacy plaintext
   * key still awaiting the one-time migration — is the activation switch.
   * The **client** evaluates this (see `packages/tui/src/bundled-extensions.ts`),
   * passing the same credential store the assembly will; the core never
   * calls it over the user's config, and the store is read for presence
   * only, never for the value. */
  evaluateActive(
    readConfig: (file: string) => string,
    configFile: string,
    credentialStore?: { get(ref: string): string | undefined },
  ): boolean {
    try {
      // The reader is the caller's: the activation fact is the *caller's*
      // question ("should this run?"), asked through whatever read the
      // caller trusts — a file read here, an in-memory config in a test.
      // #1162: presence in the credential store is the new home of the
      // fact; the legacy plaintext key keeps a pre-migration config
      // active until the client's migration has run.
      const stored = credentialStore?.get(TYPESAFE_CREDENTIAL_REF) !== undefined;
      return resolveTypesafeConfig(readTypesafeConfig(configFile, readConfig), stored).active;
    } catch {
      // A malformed `typesafe` block is a user error the CLI reports
      // (`moh jev status` exits 2). For the assembly it means "not active":
      // a broken optional config must never fail a session that is otherwise
      // perfectly usable.
      return false;
    }
  },

  /**
   * #1162: the one-time legacy-key migration (config plaintext → the
   * `typesafe` credential), run by the client before `evaluateActive`.
   * Idempotent and effect-free when there is nothing to migrate.
   */
  migrate(store: { get(ref: string): string | undefined; set(ref: string, value: string): void }, configFile: string): void {
    migrateTypesafeKey(store, configFile);
  },

  /**
   * What the user reads in the session log when the key is absent. The
   * manual documents this exact line, and the core cannot produce it: only
   * this package knows that a missing API key is what "inactive" means.
   */
  inactiveNote(): string {
    return "jev: inactive (no stored credential)";
  },

  activate(context: BundledActivationContext): unknown {
    const typesafe = resolveTypesafeConfig(readTypesafeConfig(context.configFile, readFile));
    // #1162: no key arrives here — the extension speaks `credential:<ref>`
    // and the host resolves the value itself (ADR-0069). A key that is not
    // in the store yet is a per-call `unknown_credential` refusal: loud in
    // the log, fail-open in behavior, never a broken session.
    return createJevGuardExtension({
      credentialRef: TYPESAFE_CREDENTIAL_REF,
      ...(typesafe.timeoutMs !== undefined ? { timeoutMs: typesafe.timeoutMs } : {}),
      // #1041: the guardrail's own flag, resolved at the same moment as the
      // rest: `guardrail: false` is the only value that disarms it.
      guardrail: typesafe.guardrail,
      routing: {
        pool: context.modelPool,
        labels: typesafe.tiers,
        // #868 (option B): the project's declared routing pool.
        ...(context.routingPool !== undefined ? { declaredPool: context.routingPool } : {}),
      },
      enabled: typesafe.routing,
      injection: typesafe.injection,
      classification: typesafe.classification,
      rerank: typesafe.rerank,
      // #832: lint and skills are *supplied* whenever the session can supply
      // them, with the config deciding only the starting state — so a warm
      // `on` (#832/#833) can start a use case the config left off, instead
      // of hitting a use case that was never built.
      lint: { root: context.cwd, enabled: typesafe.lint },
      skills: { roster: context.skillRoster, enabled: typesafe.skills },
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

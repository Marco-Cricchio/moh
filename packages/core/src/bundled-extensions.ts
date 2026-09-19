/**
 * Bundled extensions (#826): first-party code the host ships inside the
 * binary, as opposed to the files a user declares (#834).
 *
 * Two doors, one runtime, two trust postures:
 *
 * - **file source** (`extension-source.ts`, #834) — the user's dotdir and
 *   the project's proposals; arbitrary code the user chose to run, gated by
 *   the content-bound consent.
 * - **bundled source** (here) — code compiled into moh. The host shipped
 *   the bytes, so consent and dependency authorization do not apply
 *   (`register(def, { bundled: true })`). The code is not editable by the
 *   user and never lives at a path the user could tamper with.
 *
 * The core knows **how** to register a bundled extension; it never knows
 * **what** one is. A source is a descriptor: an identity, an effect-free
 * activation predicate read through an injected reader, a factory, and an
 * optional wiring step for generic capabilities the extension contributes.
 * The provider that spells them out is the client's (first-party code lives
 * in its own workspace package, §deps), so a library user with no provider
 * assembles a core with no first-party extension at all — and a future
 * bundled extension is a new descriptor, not a change here.
 */
import type { ExtensionRuntime, RuntimeExtension } from "./extensions";
import type { EndpointProfile } from "./config";
import type { ModelPoolResult } from "./model-pool";

/** What `resolveBundledExtensions` hands an active descriptor. */
export interface BundledActivationContext {
  /** `~/.moh` (the extension's own storage, if it wants any). */
  mohHome: string;
  /** The session's project root. */
  cwd: string;
  /** The user config file the activation predicate read (`~/.moh/config`). */
  configFile: string;
  /** The session's configured endpoints — the model pool input. */
  endpoints: readonly EndpointProfile[];
  /** The session's model pool resolver (lazy: nothing is listed until asked). */
  modelPool: () => Promise<ModelPoolResult>;
  /** The session's skill roster (bundled first-party + user skills). */
  skillRoster: () => Promise<readonly { name: string; description: string }[]>;
}

/**
 * One bundled extension, described by the package that owns it.
 *
 * `isActive` reads the *shape* "should this run?", never semantics: the
 * reader is injected, so the core never sees a vendor key, a vendor schema,
 * or the vendor's config block.
 */
export interface BundledExtensionSource {
  /** The extension's registered name — identity for state, control, lookups. */
  readonly name: string;
  /**
   * Effect-free activation predicate over the user config file. Receives
   * the path (`~/.moh/config`) and the reader the caller injects (a file
   * read). Must not write, must not throw: a malformed block is the
   * extension's business, not a reason to fail an assembly.
   */
  isActive(readConfig: (file: string) => string, configFile: string): boolean;
  /** Builds the definition to register. Called only when `isActive` said yes. */
  activate(context: BundledActivationContext): unknown;
  /**
   * One line for the session log when this source is *not* active — the
   * extension's own words, because the core has none: only the extension
   * knows what the user would have to do about it. Absent = silence (a
   * source with nothing useful to say on that path).
   */
  inactiveNote?(): string;
  /**
   * Optional wiring step for capabilities an extension contributes to the
   * core (ADR-0031 §4 spirit: an extension may offer to do part of the
   * work, the core decides what a capability is). The core does the
   * plumbing — find the instance by name, read the key, adapt the shape —
   * and learns nothing about what the payload means.
   *
   * It receives a *reader*, not a snapshot: registration is
   * fire-and-forget (the session awaits `ready()` before its first turn),
   * so at wiring time the instance may not exist yet. The reader is called
   * only when the capability is used — a send — by which point every
   * registration has settled.
   */
  wire?(read: BundledInstanceReader, wiring: BundledWiring): void;
}

/** Reads the extensions registered so far, at the moment a contributed
 * capability is actually used (never at wiring time — the registration is
 * still in flight then). */
export type BundledInstanceReader = () => readonly RuntimeExtension[];

/** The generic capabilities a bundled extension may contribute. Each is a
 * core-side, named slot: the core owns the signature, the extension owns
 * the implementation and the semantics. */
export interface BundledWiring {
  /** The per-turn MPM eligibility gate (see `MpmOptions.turnGate`). */
  turnGate?: () => boolean | undefined;
  /** The MPM seed rerank rescue hook (see `MpmOptions.rerank`). */
  rerank?: import("./mpm/orientation").MpmOrientationOptions["rerank"];
}

/** What the core resolved from the registered sources. */
export interface BundledResolution {
  /** True when at least one descriptor said it was active — the runtime
   * exists to host it and must be created even with no file source. */
  anyActive: boolean;
  /** The wiring the active descriptors contributed, if any. */
  wiring: BundledWiring;
  /**
   * One line per *inactive* source, in source order: the extension's own
   * words for why it is not running. The core cannot write them — it does
   * not know what the extension is, let alone what the user would do.
   */
  notes: string[];
}

/**
 * Resolves which registered bundled sources are active for this assembly
 * and wires the generic capabilities they contribute.
 *
 * Registration itself is fire-and-forget (`runtime.register`), like the
 * file source: the session awaits `ready()` before its first turn, so a
 * hook is never missing from a tool call. `wire` therefore runs against a
 * lazy reader — the instance may not exist yet at this point, and by the
 * time the wiring is *called* (a send) `ready()` has already run.
 */
export function resolveBundledExtensions(options: {
  descriptors: readonly BundledExtensionSource[];
  runtime: ExtensionRuntime;
  configFile: string;
  readConfig: (file: string) => string;
  context: Omit<BundledActivationContext, "configFile">;
}): BundledResolution {
  const wiring: BundledWiring = {};
  const notes: string[] = [];
  let anyActive = false;
  const context: BundledActivationContext = { ...options.context, configFile: options.configFile };
  for (const descriptor of options.descriptors) {
    let active = false;
    try {
      active = descriptor.isActive(options.readConfig, options.configFile);
    } catch {
      // A predicate that throws is a descriptor bug, not a user error: the
      // extension simply does not activate, and nothing else is affected.
      active = false;
    }
    if (!active) {
      const note = descriptor.inactiveNote?.();
      if (note) notes.push(note);
      continue;
    }
    anyActive = true;
    void options.runtime.register(descriptor.activate(context), { bundled: true });
    // The reader is lazy on purpose: the instance may not exist yet at this
    // point (the registration above is in flight), so the wiring captures
    // the runtime, not a snapshot of `instances`.
    descriptor.wire?.(() => options.runtime.instances, wiring);
  }
  return { anyActive, wiring, notes };
}

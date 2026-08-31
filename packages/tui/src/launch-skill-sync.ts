import { installFirstPartySkills } from "@moh/core";

/** From the core workflow module (not on the public surface, ADR-0004). */
type SkillInstallReport = ReturnType<typeof installFirstPartySkills>;

/**
 * #385: first-party skill sync at TUI launch. Existing workflow users who
 * upgrade the binary never re-entered `/workflow on` or the one-shot
 * first-run offer, so newly bundled skills were never installed. This seam
 * runs the standard install (hash-manifest semantics unchanged: modified
 * copies left alone, min-version gating, pruning) once per process when
 * workflow mode is enabled — fail-silent, never blocking launch.
 */

// Once-per-process guard: the sync is idempotent, but App effects can run
// more than once (StrictMode double-mount, remounts) and there is no reason
// to touch `~/.moh/skills` twice in one launch.
let ranInThisProcess = false;

export interface LaunchSkillSyncOptions {
  /** User-level moh dir (`~/.moh`). */
  mohHome: string;
  /** Workflow mode state — sync only when enabled. */
  workflowEnabled: boolean;
  /** Install seam (tests inject sources). Default: the shipped bundle. */
  install?: (options: { mohHome: string }) => SkillInstallReport;
}

/** Runs the launch sync once; returns the report, or null when skipped
 * (workflow off, already ran, or the sync itself failed — fail-silent). */
export function launchSkillSync(options: LaunchSkillSyncOptions): SkillInstallReport | null {
  if (!options.workflowEnabled || ranInThisProcess) return null;
  ranInThisProcess = true;
  try {
    return (options.install ?? ((o) => installFirstPartySkills(o)))({ mohHome: options.mohHome });
  } catch {
    // A broken `~/.moh` (unwritable, corrupt manifest dir) must never
    // block or crash launch — same posture as the background checks.
    return null;
  }
}

/** Test seam: reset the once-per-process guard between test cases. */
export function resetLaunchSkillSyncForTest(): void {
  ranInThisProcess = false;
}

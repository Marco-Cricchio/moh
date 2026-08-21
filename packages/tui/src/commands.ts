/**
 * The generic slash-command registry (#36). Base commands exist always;
 * workflow commands are thin aliases over the first-party skills,
 * registered only while workflow mode is on. The chat input consults
 * `runSlashCommand` before sending anything to the model.
 */
import {
  applyUpstreamUpdates,
  checkUpstreamUpdates,
  diffSkillFiles,
  installFirstPartySkills,
  loadFirstPartyManifest,
  resolveTrackerSync,
  trackerTools,
  type AgentSession,
  type UpstreamUpdate,
} from "@moh/core";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { UserConfig } from "./user-config";

export interface SlashContext {
  cwd: string;
  /** User-level moh dir (`~/.moh`). */
  mohHome: string;
  config: UserConfig;
  /** Persists a user-config patch (workflow toggle). */
  updateConfig: (patch: Partial<UserConfig>) => void;
  /** Live session, when the command runs from chat. */
  session?: AgentSession | null;
  /** Toast / inline notice channel. */
  notify: (message: string) => void;
  onOpenFrontier?: () => void;
  /** Notified on a workflow toggle (App re-reads the tracker, #36). */
  onWorkflowToggle?: (enabled: boolean) => void;
}

export interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
  run(ctx: SlashContext, args: string): void;
}

/** The workflow skill aliases: prompts routed through the first-party skills. */
const ALIASES: { name: string; skill: string }[] = [
  { name: "implement", skill: "implement" },
  { name: "tdd", skill: "tdd" },
  { name: "code-review", skill: "code-review" },
  { name: "diagnosing-bugs", skill: "diagnosing-bugs" },
  { name: "grilling", skill: "grilling" },
  { name: "domain-modeling", skill: "domain-modeling" },
  { name: "wayfinder", skill: "wayfinder" },
  { name: "to-spec", skill: "to-spec" },
  { name: "to-tickets", skill: "to-tickets" },
  { name: "triage", skill: "triage" },
  { name: "codebase-design", skill: "codebase-design" },
  { name: "wizard", skill: "wizard" },
  { name: "writing-for-agents", skill: "writing-for-agents" },
];

const workflowCommand: SlashCommand = {
  name: "workflow",
  description: "toggle workflow mode (on | off | status)",
  usage: "/workflow on|off",
  run(ctx, args) {
    const arg = args.trim().toLowerCase();
    if (arg === "on" || arg === "off") {
      const enabled = arg === "on";
      ctx.updateConfig({ workflow: { ...ctx.config.workflow, enabled } });
      if (enabled) {
        const report = installFirstPartySkills({ mohHome: ctx.mohHome });
        const failed = [...report.skippedModified, ...report.skippedMinVersion];
        ctx.notify(
          `workflow on · skills: ${report.installed.length + report.updated.length} copied, ${report.unchanged.length} unchanged` +
            (failed.length ? ` · ${failed.length} left alone (modified or gated)` : ""),
        );
      } else {
        ctx.notify("workflow off · first-party skills hidden, base behavior unchanged");
      }
      ctx.session?.refreshSkills?.({ firstParty: enabled ? "include" : "exclude" });
      if (enabled && ctx.session) {
        // The tracker tools join the live session under the standard
        // permission spine (tracker_list allow / tracker_claim ask).
        const tracker = resolveTrackerSync({ cwd: ctx.cwd });
        if (tracker) ctx.session.addTools?.(trackerTools(tracker));
      }
      ctx.onWorkflowToggle?.(enabled);
      return;
    }
    if (arg === "frontier") {
      ctx.onOpenFrontier?.();
      return;
    }
    ctx.notify(`workflow is ${ctx.config.workflow.enabled ? "on" : "off"} · usage: /workflow on|off`);
  },
};

const frontierCommand: SlashCommand = {
  name: "frontier",
  description: "open the tracker frontier panel",
  run(ctx) {
    ctx.onOpenFrontier?.();
  },
};

const skillsCommand: SlashCommand = {
  name: "skills",
  description: "first-party skills: list, or check/apply upstream updates",
  usage: "/skills [update [apply]]",
  run(ctx, args) {
    const [sub, confirm] = args.trim().split(/\s+/).filter(Boolean);
    const manifest = loadFirstPartyManifest(ctx.mohHome);
    const names = Object.keys(manifest.skills);
    if (sub !== "update") {
      ctx.notify(names.length ? `first-party skills: ${names.join(", ")}` : "no first-party skills installed (/workflow on)");
      return;
    }
    void checkUpstreamUpdates({ mohHome: ctx.mohHome })
      .then((updates) => {
        if (updates.length === 0) return ctx.notify("skills up to date");
        if (confirm !== "apply") {
          // Show every diff in full first; consent is the separate
          // `/skills update apply` invocation (hashes re-verified there).
          pendingUpdates = updates;
          for (const u of updates) {
            const diff = diffSkillFiles(readInstalled(ctx.mohHome, u.name), u.files);
            ctx.notify(`update available: ${u.name}\n${diff}\n\n/skills update apply to install`);
          }
          return;
        }
        const plan = pendingUpdates ?? updates;
        return applyUpstreamUpdates({
          mohHome: ctx.mohHome,
          updates: plan,
          // Consent: the explicit `apply` after the full diff was shown;
          // modified copies are skipped by the hash checks regardless.
          consent: (u: UpstreamUpdate) => plan.some((p) => p.name === u.name),
        }).then((report) => {
          pendingUpdates = null;
          ctx.notify(`skills updated: ${report.applied.join(", ") || "none"}${report.skippedModified.length ? ` · modified, skipped: ${report.skippedModified.join(", ")}` : ""}`);
          ctx.session?.refreshSkills();
        });
      })
      .catch(() => ctx.notify("skills update check failed"));
  },
};

/** The last shown update plan — `apply` consents to exactly these. */
let pendingUpdates: UpstreamUpdate[] | null = null;

function readInstalled(mohHome: string, name: string): Record<string, string> {
  const dir = join(mohHome, "skills", name);
  const files: Record<string, string> = {};
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) files[entry.name] = readFileSync(join(dir, entry.name), "utf8");
    }
  } catch {
    // missing dir: empty
  }
  return files;
}

/** Commands available regardless of workflow mode. */
export const BASE_COMMANDS: SlashCommand[] = [workflowCommand];

/** Workflow-mode commands (thin skill aliases + frontier + skills). */
export function workflowCommands(): SlashCommand[] {
  return [
    ...ALIASES.map<SlashCommand>(({ name, skill }) => ({
      name,
      description: `run the ${skill} skill workflow`,
      usage: `/${name} <what to ${name}>`,
      run(ctx, args) {
        if (!ctx.session) return ctx.notify(`/${name} needs an open session`);
        void ctx.session.send(
          `Load the "${skill}" skill (read its SKILL.md) and follow it.\n\n${args.trim()}`,
        );
      },
    })),
    frontierCommand,
    skillsCommand,
  ];
}

/** The command list active for a context (base + workflow when on). */
export function activeCommands(ctx: Pick<SlashContext, "config">): SlashCommand[] {
  return ctx.config.workflow.enabled ? [...BASE_COMMANDS, ...workflowCommands()] : [...BASE_COMMANDS];
}

/**
 * Tries to run `text` as a slash command. Returns true when the text was
 * consumed (never sent to the model).
 */
export function runSlashCommand(text: string, ctx: SlashContext): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;
  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  if (!name) return false;
  const command = activeCommands(ctx).find((c) => c.name === name);
  if (!command) return false;
  command.run(ctx, rest.join(" "));
  return true;
}

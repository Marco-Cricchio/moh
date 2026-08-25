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
  readBundledSkill,
  resolveTrackerSync,
  trackerTools,
  type AgentSession,
  type UpstreamUpdate,
} from "@moh/core";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { UserConfig } from "./user-config";
import { subscriptionModelCatalog } from "@moh/core";

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
  /** Opens the /model picker modal (#181): called for bare `/model` when
   * a UI is present; the text list remains the headless fallback. */
  onOpenModelPicker?: () => void;
  /** Provider type of the active endpoint (#166): feeds /model's catalog
   * list. Absent (pre-built providers, tests) — the command skips the list. */
  activeProviderType?: () => string | undefined;
  /** Notified on a successful /model switch (App refreshes the footer
   * chip — #166 status surface). */
  onModelSwitched?: (model: string) => void;
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
  { name: "session-memory", skill: "session-memory" },
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

/** #166: in-session model switching. `/model` with no argument shows the
 * active model plus the vendored catalog of the active provider (the
 * same list onboarding shows, #156/#164); `/model <ref>` switches — a
 * catalog id, an `endpoint/model-id` ref, or any free-text model on a
 * custom provider. The switch takes effect from the next turn. */
const modelCommand: SlashCommand = {
  name: "model",
  description: "open the model picker modal (or /model <ref> to switch)",
  usage: "/model [endpoint/model-id | model-id]",
  run(ctx, args) {
    const ref = args.trim();
    if (!ctx.session) return ctx.notify("/model needs an open session");
    if (!ref) {
      // #181: with a UI, bare /model opens the modal instead of dumping
      // the catalog as text; the text list stays for headless callers.
      if (ctx.onOpenModelPicker) return ctx.onOpenModelPicker();
      ctx.notify(`active model: ${ctx.session.activeModel}`);
      const type = ctx.activeProviderType?.();
      if (type) {
        const models = subscriptionModelCatalog(type);
        if (models.length) {
          ctx.notify(
            `${type} catalog (pick with /model <id>):\n` +
              models.map((m) => `  ${m.name} (${m.id}) · ctx ${Math.round(m.contextWindow / 1000)}k`).join("\n"),
          );
        }
      }
      return ctx.notify("usage: /model <endpoint/model-id | model-id> — free text works for models outside any catalog");
    }
    const result = ctx.session.switchModel(ref);
    if (!result.ok) return ctx.notify(`✗ ${result.error}`);
    ctx.onModelSwitched?.(result.model);
    ctx.notify(`✓ model switched to ${result.model} — effective from the next turn`);
  },
};

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

/** #ask-moh: the router over the workflow skills and the moh docs.
 * Registered as a base command so it works with workflow mode off too —
 * the SKILL.md is read from the bundle (it is only copied into
 * `~/.moh/skills/` when workflow mode is on). ADR-0011: the skill body
 * rides the system prompt via `send(text, { prompt })`; the user message
 * is the clean question and the log records a discreet `skill_invoked`. */
const askMohCommand: SlashCommand = {
  name: "ask-moh",
  description: "which skill or flow fits? router over moh skills + docs",
  usage: "/ask-moh <question>",
  run(ctx, args) {
    if (!ctx.session) return ctx.notify("/ask-moh needs an open session");
    const skill = readBundledSkill("ask-moh");
    if (!skill) return ctx.notify("ask-moh skill missing from the bundle");
    const state = ctx.config.workflow.enabled ? "on" : "off";
    const question = args.trim() || "Which skill or flow fits my situation?";
    const body = stripSkillFrontmatter(skill.files["SKILL.md"] ?? "");
    void ctx.session.send(
      `${question}\n\n(Workflow mode is currently ${state}. The ask-moh skill's workflow-mode gate applies as written.)`,
      {
        prompt: {
          name: "ask-moh",
          text: body,
        },
      },
    );
  },
};

/** Body of a SKILL.md: everything after the closing frontmatter fence. */
function stripSkillFrontmatter(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return match ? raw.slice(match[0].length) : raw;
}

/** Commands available regardless of workflow mode. */
export const BASE_COMMANDS: SlashCommand[] = [workflowCommand, askMohCommand, modelCommand];

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

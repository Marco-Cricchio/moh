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
  type UpstreamCheckResult,
} from "@moh/core";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { UserConfig } from "./user-config";
import { subscriptionModelCatalog, setThinkingPreference, readThinkingPreference, isThinkingLevel, THINKING_LEVELS } from "@moh/core";
import { thinkingLevelControl } from "./thinking-controls";

/** The user config file inside an already-resolved moh home — the one
 * spelling of the path in this module (ADR-0006's `userConfigFile`
 * derives from the *user* home; commands work from `ctx.mohHome`). */
const mohConfigFile = (mohHome: string) => join(mohHome, "config");

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
  /** #242: sets the session-level reasoning display override (immediate,
   * projection-only). Absent (headless): /thinking show|hide still
   * reports but cannot change the display. */
  onThinkingDisplay?: (show: boolean) => void;
  /** Effective display state (session override over global preference). */
  thinkingDisplay?: () => boolean;
  /** #242: notified after a level preference was persisted (App refreshes
   * the status-bar level). */
  onThinkingLevelChanged?: () => void;
  /** Hot config reload: rebuilds the session from a fresh moh.json/user
   * config read, appending to the same session file (history kept).
   * Absent (headless callers): /reload explains it needs the TUI. */
  onReload?: () => void;
  /** Opens the all-commands panel (`/commands`, `?`). */
  onOpenCommands?: () => void;
  /** Cycles vibe ↔ dev (`/mode`). Absent (headless): the command explains
   * it needs the TUI. */
  onCycleMode?: () => void;
  /** Cycles the theme (`/theme`). Absent (headless): same explanation. */
  onCycleTheme?: () => void;
  /** Opens the settings panel (`/settings`). */
  onOpenSettings?: () => void;
  /** #348: reports the result of an explicit `/skills update` check so
   * the status-row skill notice can synchronise without another network
   * call. Called without a result after apply, when the App must recheck
   * because modified skills may have been skipped. */
  onSkillUpdatesChanged?: (result?: UpstreamCheckResult) => void;
  /** Opens the TUI-only update inspection modal. Headless callers keep the
   * textual diff and `/skills update apply` flow. */
  onOpenSkillUpdates?: (updates: UpstreamUpdate[]) => void;
  /** #348: injectable upstream check (default: the core
   * `checkUpstreamUpdates`) — tests substitute it; production callers
   * never pass it. */
  skillsCheck?: typeof checkUpstreamUpdates;
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

/** Message for an explicit `/skills update` check (#344): failures name
 * the reason (HTTP status where safe) — never "up to date" when the channel
 * was unreachable. Exported pure for tests. */
export function upstreamCheckMessage(result: UpstreamCheckResult): string {
  if (!result.ok) return `skills update check failed (${result.reason})`;
  if (result.updates.length === 0) return "skills up to date";
  return "updates available";
}

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
    void (ctx.skillsCheck ?? checkUpstreamUpdates)({ mohHome: ctx.mohHome })
      .then((result) => {
        // #348: an explicit refresh owns fresh knowledge too; project it
        // immediately, rather than leave the persistent row-2 count stale.
        ctx.onSkillUpdatesChanged?.(result);
        if (!result.ok) {
          return ctx.notify(upstreamCheckMessage(result));
        }
        const updates = result.updates;
        if (updates.length === 0) {
          return ctx.notify(upstreamCheckMessage(result));
        }
        if (confirm !== "apply") {
          // The TUI owns the readable projection and its explicit Apply
          // control. Headless callers retain the textual two-command flow.
          if (ctx.onOpenSkillUpdates) return ctx.onOpenSkillUpdates(updates);
          pendingUpdates = updates;
          for (const u of updates) {
            const diff = diffSkillFiles(readInstalled(ctx.mohHome, u.name), u.files);
            ctx.notify(`update available: ${u.name}\n${diff}\n\n/skills update apply to install`);
          }
          return;
        }
        return applySkillUpdates(ctx, pendingUpdates ?? updates);
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

/** #242: reasoning display + thinking-level selection. `show|hide` is
 * the temporary session override (projection-only, immediate); a level
 * argument persists the endpoint preference immediately through the
 * guardian and explains unsupported levels instead of remapping them. */
const thinkingCommand: SlashCommand = {
  name: "thinking",
  description: "reasoning display (show|hide) and thinking level (off…max)",
  usage: "/thinking [show|hide | off|low|medium|high|xhigh|max]",
  run(ctx, args) {
    const arg = args.trim().toLowerCase();
    if (arg === "show" || arg === "hide") {
      if (!ctx.onThinkingDisplay) return ctx.notify(`reasoning display: ${ctx.config.showReasoning ? "on" : "off"} (no UI to change it here)`);
      ctx.onThinkingDisplay(arg === "show");
      ctx.notify(`reasoning display ${arg === "show" ? "on" : "off"} for this session · requests and saved history are unchanged`);
      return;
    }
    const ref = ctx.session?.activeModel;
    const control = thinkingLevelControl(ref, ctx.session?.endpointProfiles, ctx.activeProviderType?.());
    if (!arg) {
      const display = (ctx.thinkingDisplay?.() ?? ctx.config.showReasoning) ? "on" : "off";
      // #256: an unsupported stored preference is visible here — kept
      // intact, resolved to the provider default, never silently dropped.
      const preference = readThinkingPreference(mohConfigFile(ctx.mohHome), control?.endpointName ?? "");
      const unsupported =
        preference && (!control || control.states[preference] === "provider-default") ? ` · provider default (preference ${preference} unsupported by ${ref})` : "";
      if (!ref || !control) {
        ctx.notify(`reasoning display ${display} · level selection not offered for ${ref ?? "no model"} (no declared capability)${unsupported}`);
        return;
      }
      ctx.notify(`reasoning display ${display} · levels offered by ${ref}: ${control.offered.join(", ")}${unsupported}`);
      return;
    }
    if (!isThinkingLevel(arg)) return ctx.notify(`unknown level "${arg}" · canonical levels: ${THINKING_LEVELS.join(", ")}`);
    if (!ref || !control) return ctx.notify(`level selection not offered: ${ref ?? "no active model"} declares no thinking capability (catalog map or config declaration)`);
    if (control.states[arg] === "provider-default") {
      return ctx.notify(`✗ ${ref} does not offer level "${arg}" — nothing changed (moh never remaps levels); /thinking lists what it offers`);
    }
    setThinkingPreference(mohConfigFile(ctx.mohHome), control.endpointName, arg);
    ctx.onThinkingLevelChanged?.();
    ctx.notify(`✓ thinking level ${arg} saved for endpoint ${control.endpointName} · effective from the next model call`);
  },
};


export async function applySkillUpdates(ctx: SlashContext, updates: UpstreamUpdate[]): Promise<void> {
  const report = await applyUpstreamUpdates({
    mohHome: ctx.mohHome,
    updates,
    // The caller has already made an explicit apply decision. Core still
    // revalidates every hash immediately before each write.
    consent: () => true,
  });
  pendingUpdates = null;
  ctx.notify(`skills updated: ${report.applied.join(", ") || "none"}${report.skippedModified.length ? ` · modified, skipped: ${report.skippedModified.join(", ")}` : ""}`);
  ctx.session?.refreshSkills();
  // Application can skip locally modified skills, so recheck rather than
  // pretending the earlier plan is now empty.
  ctx.onSkillUpdatesChanged?.();
}

export function readInstalled(mohHome: string, name: string): Record<string, string> {
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

/** Hot config reload: moh.json + user config are re-read and the session
 * is rebuilt through the same assembly path (`sessionFromConfig`),
 * appending to the same JSONL file — history, memory and skills carry
 * over; providers, MCP servers, permissions and extensions are picked
 * up from the fresh config. A broken config keeps the old session
 * alive (no silent fallback, ADR-0005). */
const reloadCommand: SlashCommand = {
  name: "reload",
  description: "hot-reload moh.json and user config into the live session",
  usage: "/reload",
  run(ctx) {
    if (!ctx.session) return ctx.notify("/reload needs an open session");
    if (!ctx.onReload) return ctx.notify("/reload needs the TUI session shell");
    ctx.onReload();
  },
};

/** Commands available regardless of workflow mode, alphabetical (the
 * completion popup lists exactly this order: ask-moh, commands, mode,
 * model, reload, settings, theme, thinking, wayfinder, workflow). */
const commandsCommand: SlashCommand = {
  name: "commands",
  description: "open the all-commands panel",
  usage: "/commands",
  run(ctx) {
    ctx.onOpenCommands?.();
  },
};

const modeCommand: SlashCommand = {
  name: "mode",
  description: "switch vibe / dev mode",
  usage: "/mode",
  run(ctx) {
    if (!ctx.onCycleMode) return ctx.notify("/mode needs the TUI (ctrl+o cycles from chat)");
    ctx.onCycleMode();
  },
};

const themeCommand: SlashCommand = {
  name: "theme",
  description: "cycle the color theme",
  usage: "/theme",
  run(ctx) {
    if (!ctx.onCycleTheme) return ctx.notify("/theme needs the TUI (themes live in settings)");
    ctx.onCycleTheme();
  },
};

const settingsCommand: SlashCommand = {
  name: "settings",
  description: "open the settings panel",
  usage: "/settings",
  run(ctx) {
    ctx.onOpenSettings?.();
  },
};

/** #wayfinder: opens the frontier panel directly (workflow-gated). */
const wayfinderCommand: SlashCommand = {
  name: "wayfinder",
  description: "open the wayfinder frontier panel (workflow on)",
  usage: "/wayfinder",
  run(ctx) {
    if (!ctx.config.workflow.enabled) return ctx.notify("wayfinder needs workflow on (/workflow on)");
    ctx.onOpenFrontier?.();
  },
};

/** Commands available regardless of workflow mode. */
export const BASE_COMMANDS: SlashCommand[] = [
  askMohCommand,
  commandsCommand,
  modeCommand,
  modelCommand,
  reloadCommand,
  settingsCommand,
  themeCommand,
  thinkingCommand,
  wayfinderCommand,
  workflowCommand,
];

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
    skillsCommand,
  ];
}

/** The command list active for a context (base + workflow when on). */
export function activeCommands(ctx: Pick<SlashContext, "config">): SlashCommand[] {
  return ctx.config.workflow.enabled ? [...BASE_COMMANDS, ...workflowCommands()] : [...BASE_COMMANDS];
}

/** Popup-facing projection of one command: the slash name, a short
 * description, and the `[s]`/`[u]` provenance marker ([s] = built into
 * moh, [u] = user-custom: a moh.json `agents` preset or a user-defined
 * alias). */
export interface CommandEntry {
  name: string;
  description: string;
  custom: boolean;
}

/** The popup list for a context, alphabetically sorted. */
export function commandEntries(ctx: Pick<SlashContext, "config">): CommandEntry[] {
  return activeCommands(ctx)
    .map<CommandEntry>((command) => ({
      name: `/${command.name}`,
      description: command.description,
      custom: CUSTOM_COMMAND_NAMES.has(command.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Commands that originate from user configuration rather than moh's own
 * registry. The skill aliases are first-party workflow vocabulary (not
 * user-owned), so they stay `[s]`; a user preset named in moh.json's
 * `agents` section (or an alias overriding a built-in) is `[u]`. */
const CUSTOM_COMMAND_NAMES: ReadonlySet<string> = new Set([]);

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

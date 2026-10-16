import React from "react";
import { Text, useInput } from "ink";
import type { ExtensionsScreenState } from "@moh/core";
import { useTheme } from "./themes";
import { Dim, ScrollDialog, type ScrollRow } from "./ui";

/**
 * The /extensions modal (#1131): opened with /extensions from chat. A
 * read-only snapshot at open time — per enabled extension its version,
 * source (file path or bundled), declared capabilities, registered
 * commands and the prompt sections it currently owns (ADR-0054); then
 * refused registrations with their reasons (ADR-0062) and the ignored
 * duplicate copies (#1125: the project copy wins, the dotdir copy is
 * named). It never writes configuration. The body scrolls inside the
 * viewport: many extensions never overflow a short terminal.
 */

const REASON_WHY: Record<string, string> = {
  reserved: "collides with a native command or skill",
  taken: "name taken by another extension",
  invalid: "invalid command",
  command_refused: "registration refused",
  consent: "enable consent missing or declined",
  manifest: "manifest refused it",
  deps_unauthorized: "declared dependencies not authorized",
  setup_failed: "setup threw",
  hook: "hook lost its clock (ADR-0056)",
};

const why = (reason: string) => REASON_WHY[reason] ?? reason;

export interface ExtensionsModalProps {
  state: ExtensionsScreenState;
  /** #1125: duplicate identities the loader ignored, with the ignored
   * copy's path (the project copy wins; the loser is named, not hidden). */
  duplicates: { extension: string; path: string }[];
  /** #1132: the rail is user-toggled here; panels collapse/reopen
   * manually — there is no automatic eviction (ADR-0062). */
  rail?: { open: boolean; onToggleRail: () => void; collapsed: ReadonlySet<string>; onTogglePanel: (name: string) => void };
  /** #1218: clamps the client applied to declared maxHeights, by panel
   * name — the visible record that a declaration was cut to fit. */
  panelClamps?: ReadonlyMap<string, { max: number; shown: number }>;
  onClose: () => void;
}

export function ExtensionsModal({ state, duplicates, rail, panelClamps, onClose }: ExtensionsModalProps) {
  const theme = useTheme();
  useInput((input, key) => {
    if (key.escape || input === "q") return onClose();
    if (!rail) return;
    if (input === "r") return rail.onToggleRail();
    const panelNames = state.extensions.flatMap((e) =>
      e.panels.map((p) => (typeof p === "string" ? p : p.name)),
    );
    const index = Number(input) - 1;
    if (Number.isInteger(index) && index >= 0 && index < panelNames.length) rail.onTogglePanel(panelNames[index]!);
  });

  const row = (node: React.ReactNode): ScrollRow => ({ node, weight: 1 });
  const rows: ScrollRow[] = [row(<Text bold> registered extensions</Text>)];
  if (state.extensions.length === 0) rows.push(row(<Dim> none</Dim>));
  for (const e of state.extensions) {
    rows.push(
      row(
        <Text wrap="truncate">
          {" "}
          {e.name} <Dim>v{e.version || "?"} ·</Dim> {e.file ? <Dim>{e.file}</Dim> : <Dim>bundled</Dim>}
        </Text>,
      ),
    );
  }

  if (state.extensions.some((e) => e.capabilities.length > 0)) {
    rows.push(row(<Text> </Text>), row(<Text bold> capabilities</Text>));
    for (const e of state.extensions.filter((e) => e.capabilities.length > 0)) {
      rows.push(
        row(
          <Text wrap="truncate">
            {" "}
            {e.name}: {e.capabilities.join(", ")}
          </Text>,
        ),
      );
    }
  }

  if (state.extensions.some((e) => e.sections.length > 0)) {
    rows.push(row(<Text> </Text>), row(<Text bold> sections in force</Text>));
    for (const e of state.extensions.filter((e) => e.sections.length > 0)) {
      for (const s of e.sections) {
        rows.push(
          row(
            <Text wrap="truncate">
              {" "}
              {s.section} <Dim>·</Dim> {s.mode} by {e.name} <Dim>v{s.version}</Dim>
            </Text>,
          ),
        );
      }
    }
  }

  if (state.extensions.some((e) => e.commands.length > 0)) {
    rows.push(row(<Text> </Text>), row(<Text bold> commands</Text>));
    for (const e of state.extensions.filter((e) => e.commands.length > 0)) {
      for (const c of e.commands) {
        rows.push(
          row(
            <Text wrap="truncate">
              {" "}
              /{c.name} <Dim>·</Dim> {e.name}
              {c.description ? <Dim> — {c.description}</Dim> : null}
            </Text>,
          ),
        );
      }
    }
  }

  if (rail) {
    rows.push(
      row(<Text> </Text>),
      row(
        <Text wrap="truncate">
          {" "}
          <Text bold>rail</Text> — [r] extensions rail: {rail.open ? <Text color={theme.accent}>open</Text> : <Dim>closed</Dim>}
          <Dim> — 1-4 collapse/reopen a panel (manual, no eviction)</Dim>
        </Text>,
      ),
    );
  }

  if (state.extensions.some((e) => e.panels.length > 0 || e.overlays.length > 0)) {
    rows.push(row(<Text> </Text>), row(<Text bold> panels & overlays</Text>));
    for (const e of state.extensions.filter((e) => e.panels.length > 0 || e.overlays.length > 0)) {
      for (const p of e.panels) {
        const name = typeof p === "string" ? p : p.name;
        const collapsed = rail?.collapsed.has(name) ?? false;
        const max = typeof p === "string" ? undefined : p.maxHeight;
        rows.push(
          row(
            <Text wrap="truncate">
              {" "}
              {name}
              {max !== undefined ? <Dim> ·max {max}</Dim> : null} <Dim>· panel · {e.name}</Dim>
              {panelClamps?.has(name) ? (
                <Text color={theme.warn}>
                  {" "}·max {panelClamps.get(name)!.max} → {panelClamps.get(name)!.shown} (clamped)
                </Text>
              ) : null}
              {rail ? (
                <Text color={theme.accent}> [{collapsed ? "collapsed" : "open"}]</Text>
              ) : (
                <Dim> · not rendered headless</Dim>
              )}
            </Text>,
          ),
        );
      }
      for (const o of e.overlays) {
        const name = typeof o === "string" ? o : o.name;
        rows.push(
          row(
            <Text wrap="truncate">
              {" "}
              {name} <Dim>· overlay · opens from its command · esc closes · {e.name}</Dim>
            </Text>,
          ),
        );
      }
    }
  }

  if (state.extensions.some((e) => e.lastFailure !== undefined)) {
    rows.push(row(<Text> </Text>), row(<Text bold> last failure</Text>));
    for (const e of state.extensions.filter((e) => e.lastFailure !== undefined)) {
      rows.push(
        row(
          <Text wrap="truncate">
            {" "}
            {e.name} <Text color={theme.warn}>· {why(e.lastFailure!.reason)}</Text>
            <Dim> — {e.lastFailure!.message}</Dim>
            {e.failureCount > 1 ? <Dim> ({e.failureCount} failures)</Dim> : null}
          </Text>,
        ),
      );
    }
  }

  if (state.refusals.length > 0) {
    rows.push(row(<Text> </Text>), row(<Text bold> refused registrations</Text>));
    state.refusals.forEach((r) => {
      rows.push(
        row(
          <Text wrap="truncate">
            {" "}
            {r.extension} <Text color={theme.warn}>·</Text> {r.message}
          </Text>,
        ),
      );
    });
  }

  if (duplicates.length > 0) {
    rows.push(row(<Text> </Text>), row(<Text bold> ignored duplicates</Text>));
    duplicates.forEach((d) => {
      rows.push(
        row(
          <Text wrap="truncate">
            {" "}
            {d.extension} <Dim>· project copy wins, ignored:</Dim> {d.path}
          </Text>,
        ),
      );
    });
  }

  return (
    <ScrollDialog
      title=" extensions "
      color={theme.accent}
      rows={rows}
      footer={<Dim> esc / q close — read-only, snapshot at open · ↑↓ scroll</Dim>}
    />
  );
}

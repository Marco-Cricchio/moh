import React from "react";
import { Text, useInput } from "ink";
import type { ExtensionsScreenState } from "@moh/core";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";

/**
 * The /extensions modal (#1131): opened with /extensions from chat. A
 * read-only snapshot at open time — per enabled extension its version,
 * source (file path or bundled), declared capabilities, registered
 * commands and the prompt sections it currently owns (ADR-0054); then
 * refused registrations with their reasons (ADR-0062) and the ignored
 * duplicate copies (#1125: the project copy wins, the dotdir copy is
 * named). It never writes configuration.
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
  onClose: () => void;
}

export function ExtensionsModal({ state, duplicates, rail, onClose }: ExtensionsModalProps) {
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

  return (
    <Dialog title=" extensions " color={theme.accent}>
      <Text bold> registered extensions</Text>
      {state.extensions.length === 0 ? <Dim> none</Dim> : null}
      {state.extensions.map((e) => (
        <Text key={e.name} wrap="truncate">
          {" "}
          {e.name} <Dim>v{e.version || "?"} ·</Dim> {e.file ? <Dim>{e.file}</Dim> : <Dim>bundled</Dim>}
        </Text>
      ))}

      {state.extensions.some((e) => e.capabilities.length > 0) ? (
        <>
          <Text> </Text>
          <Text bold> capabilities</Text>
          {state.extensions
            .filter((e) => e.capabilities.length > 0)
            .map((e) => (
              <Text key={e.name} wrap="truncate">
                {" "}
                {e.name}: {e.capabilities.join(", ")}
              </Text>
            ))}
        </>
      ) : null}

      {state.extensions.some((e) => e.sections.length > 0) ? (
        <>
          <Text> </Text>
          <Text bold> sections in force</Text>
          {state.extensions
            .filter((e) => e.sections.length > 0)
            .flatMap((e) =>
              e.sections.map((s) => (
                <Text key={`${e.name}:${s.section}`} wrap="truncate">
                  {" "}
                  {s.section} <Dim>·</Dim> {s.mode} by {e.name} <Dim>v{s.version}</Dim>
                </Text>
              )),
            )}
        </>
      ) : null}

      {state.extensions.some((e) => e.commands.length > 0) ? (
        <>
          <Text> </Text>
          <Text bold> commands</Text>
          {state.extensions
            .filter((e) => e.commands.length > 0)
            .flatMap((e) =>
              e.commands.map((c) => (
                <Text key={`${e.name}:${c.name}`} wrap="truncate">
                  {" "}
                  /{c.name} <Dim>·</Dim> {e.name}
                  {c.description ? <Dim> — {c.description}</Dim> : null}
                </Text>
              )),
            )}
        </>
      ) : null}

      {rail ? (
        <>
          <Text> </Text>
          <Text bold> rail</Text>
          <Text wrap="truncate">
            {" "}
            [r] extensions rail: {rail.open ? <Text color={theme.accent}>open</Text> : <Dim>closed</Dim>}
            <Dim> — 1-4 collapse/reopen a panel (manual, no eviction)</Dim>
          </Text>
        </>
      ) : null}

      {state.extensions.some((e) => e.panels.length > 0 || e.overlays.length > 0) ? (
        <>
          <Text> </Text>
          <Text bold> panels &amp; overlays</Text>
          {state.extensions
            .filter((e) => e.panels.length > 0 || e.overlays.length > 0)
            .flatMap((e) => [
              ...e.panels.map((p) => {
                const name = typeof p === "string" ? p : p.name;
                const collapsed = rail?.collapsed.has(name) ?? false;
                const max = typeof p === "string" ? undefined : p.maxHeight;
                return (
                  <Text key={`${e.name}:${name}`} wrap="truncate">
                    {" "}
                    {name}
                    {max !== undefined ? <Dim> ·max {max}</Dim> : null} <Dim>· panel · {e.name}</Dim>
                    {rail ? (
                      <Text color={theme.accent}> [{collapsed ? "collapsed" : "open"}]</Text>
                    ) : (
                      <Dim> · not rendered headless</Dim>
                    )}
                  </Text>
                );
              }),
              ...e.overlays.map((o) => {
                const name = typeof o === "string" ? o : o.name;
                return (
                  <Text key={`${e.name}:${name}`} wrap="truncate">
                    {" "}
                    {name} <Dim>· overlay · opens from its command · esc closes · {e.name}</Dim>
                  </Text>
                );
              }),
            ])}
        </>
      ) : null}

      {state.extensions.some((e) => e.lastFailure !== undefined) ? (
        <>
          <Text> </Text>
          <Text bold> last failure</Text>
          {state.extensions
            .filter((e) => e.lastFailure !== undefined)
            .map((e) => (
              <Text key={e.name} wrap="truncate">
                {" "}
                {e.name} <Text color={theme.warn}>· {why(e.lastFailure!.reason)}</Text>
                <Dim> — {e.lastFailure!.message}</Dim>
                {e.failureCount > 1 ? <Dim> ({e.failureCount} failures)</Dim> : null}
              </Text>
            ))}
        </>
      ) : null}

      {state.refusals.length > 0 ? (
        <>
          <Text> </Text>
          <Text bold> refused registrations</Text>
          {state.refusals.map((r, i) => (
            <Text key={`${r.extension}:${i}`} wrap="truncate">
              {" "}
              {r.extension} <Text color={theme.warn}>·</Text> {r.message}
            </Text>
          ))}
        </>
      ) : null}

      {duplicates.length > 0 ? (
        <>
          <Text> </Text>
          <Text bold> ignored duplicates</Text>
          {duplicates.map((d, i) => (
            <Text key={`${d.extension}:${i}`} wrap="truncate">
              {" "}
              {d.extension} <Dim>· project copy wins, ignored:</Dim> {d.path}
            </Text>
          ))}
        </>
      ) : null}

      <Text> </Text>
      <Dim> esc / q close — read-only, snapshot at open</Dim>
    </Dialog>
  );
}

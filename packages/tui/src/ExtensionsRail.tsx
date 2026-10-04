import React from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "./themes";

/**
 * The extensions rail (#1132, ADR-0062): the dedicated zone an extension
 * with the `contribute-panels` grant renders into. One panel per
 * extension, at most 4 visible (enforced at registration, in the core);
 * collapsing and reopening is manual, from `/extensions` — no automatic
 * eviction. The rail is closed by default (the UI is byte-identical
 * without extensions) and collapses to a one-line footer strip on narrow
 * terminals. Each panel renders inside its own error boundary: an
 * extension that throws contributes one visible failure line, never a
 * crash of the session around it.
 */

/** Narrow-terminal threshold: at or below it, the rail is a footer line. */
const NARROW_COLUMNS = 80;

export interface ExtensionsRailProps {
  panels: { extension: string; name: string; description: string; maxHeight?: number; render(): unknown }[];
  /** Panels the user collapsed from /extensions, by name. */
  collapsed: ReadonlySet<string>;
  columns: number;
}

/** Renders one extension panel's content behind an error boundary — the
 * extension's code runs per frame, and its throw is its own failure. */
class PanelBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    // The visible record is the rendered failure line; the throw must not
    // climb into the session's rendering.
  }
  render() {
    if (this.state.failed) return <Text color="red"> panel failed to render</Text>;
    return this.props.children;
  }
}

export function ExtensionsRail({ panels, collapsed, columns }: ExtensionsRailProps) {
  const theme = useTheme();
  const visible = panels.filter((p) => !collapsed.has(p.name));
  if (visible.length === 0) return null;
  if (columns <= NARROW_COLUMNS) {
    // Narrow terminal: the rail collapses to a one-line footer strip —
    // the panels are named, never rendered (the zone costs no columns).
    return (
      <Box paddingX={1} flexDirection="row" flexShrink={0} width="100%">
        <Text wrap="truncate" color={theme.dim}>
          {"extensions · "}
          {visible.map((p) => p.name).join(" · ")}
        </Text>
      </Box>
    );
  }
  return (
    <Box
      borderStyle="round"
      borderColor={theme.accent}
      flexDirection="column"
      width={36}
      flexShrink={0}
      paddingRight={1}
    >
      <Text bold> extensions</Text>
      {visible.map((p) => (
        <Box key={`${p.extension}:${p.name}`} flexDirection="column" marginTop={p === visible[0] ? 0 : 1} overflow="hidden">
          <Text wrap="truncate">
            {p.name} <Dim>{p.extension}</Dim>
            {p.maxHeight !== undefined ? <Dim> ·max {p.maxHeight}</Dim> : null}
          </Text>
          <Box flexDirection="column" overflow="hidden">
            <PanelBoundary>
              <PanelBody panel={p} />
            </PanelBoundary>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/** The panel's own render runs *inside* the boundary: the call itself
 * must be a child render, or a throw would climb out of the boundary's
 * reach (the boundary only catches its subtree). */
function PanelBody({ panel }: { panel: { maxHeight?: number; render(): unknown } }) {
  return <MaxHeight max={panel.maxHeight}>{asNode(panel.render())}</MaxHeight>;
}

function asNode(rendered: unknown): React.ReactNode {
  // The extension's render returns arbitrary Ink elements — drawn here
  // untouched, never wrapped into native components. Anything else is the
  // extension's own bug: shown as text, never executed.
  if (rendered === null || rendered === undefined || rendered === false || rendered === true) return null;
  if (typeof rendered === "string" || typeof rendered === "number") return <Text>{String(rendered)}</Text>;
  return rendered as React.ReactNode;
}

/** Clamps a panel to its declared max-height in rows; the rail's own
 * budget (`overflow: hidden`) is the outer bound. */
function MaxHeight({ max, children }: { max?: number; children: React.ReactNode }) {
  if (max === undefined) return <>{children}</>;
  return <Box flexDirection="column" height={max} overflow="hidden">{children}</Box>;
}

function Dim({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return <Text color={theme.dim}>{children}</Text>;
}

/** Full-screen extension overlay (ADR-0062 #1132): opened by the
 * extension's own command, closed by the user with `Esc`. Owns the
 * screen like any modal; the extension's render is behind the same
 * error boundary discipline as a panel. */
export function ExtensionOverlayView({
  overlay,
  onClose,
}: {
  overlay: { extension: string; name: string; render(): unknown };
  onClose: () => void;
}) {
  useEsc(onClose);
  return (
    <Box flexDirection="column" width="100%" height="100%" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>
        {" "}
        {overlay.name} <Dim>{overlay.extension}</Dim> <Dim>— esc close</Dim>
      </Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <PanelBoundary>
          <OverlayBody overlay={overlay} />
        </PanelBoundary>
      </Box>
    </Box>
  );
}

/** The overlay's own render, inside the boundary (see PanelBody). */
function OverlayBody({ overlay }: { overlay: { render(): unknown } }) {
  return <>{asNode(overlay.render())}</>;
}

function useEsc(onClose: () => void) {
  useInput((_input, key) => {
    if (key.escape) onClose();
  });
}

import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useInput, measureElement, type DOMElement } from "ink";
import { useTheme } from "./themes";
import type { PanelKeyEvent } from "@moh/extension";
import {
  RAIL_MIN_ROWS,
  RAIL_WIDTH,
  allocatePanels,
  allocationHeader,
  suggestOverlay,
} from "./rail-layout";

/**
 * The extensions rail (#1132, ADR-0062 as amended by #1218): the dedicated
 * zone an extension with the `contribute-panels` grant renders into. One
 * bordered panel per extension, at most 4 visible (enforced at registration,
 * in the core); collapsing and reopening is manual, from `/extensions` —
 * no automatic eviction. The rail is closed by default (the UI is
 * byte-identical without extensions) and collapses to a names strip on
 * narrow terminals or when fewer than RAIL_MIN_ROWS sit above the composer.
 * Each panel renders inside its own error boundary: an extension that
 * throws contributes one visible failure line, never a crash of the
 * session around it.
 *
 * #1218: the vertical space is distributed across the panels — equal share
 * computed on real space, no backfill of what an undemanding panel leaves;
 * the composer floor is guaranteed by construction (`rows` is what remains
 * after the composer frame and the footer). Demand is hybrid: the natural
 * render height, measured every frame, clamped by a declared `maxHeight`.
 * Panel headers are client-drawn (identity + real allocation); the
 * extension draws only the body. Focus is explicit (`Ctrl+P`, held by the
 * client): outside it the rail consumes zero keys.
 */

/** Narrow-terminal threshold: at or below it, the rail is a footer line. */
const NARROW_COLUMNS = 80;

/** Maps Ink's key object onto the contract's structural shape
 * (apiVersion 1.17): no Ink types cross the extension boundary. */
function panelKeyEvent(input: string, key: { name?: string; return?: boolean; escape?: boolean; tab?: boolean; backspace?: boolean; delete?: boolean; upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean }): PanelKeyEvent {
  return {
    input,
    ...(key.name !== undefined ? { name: key.name } : {}),
    ...(key.return ? { return: true } : {}),
    ...(key.escape ? { escape: true } : {}),
    ...(key.tab ? { tab: true } : {}),
    ...(key.backspace ? { backspace: true } : {}),
    ...(key.delete ? { delete: true } : {}),
    ...(key.upArrow ? { upArrow: true } : {}),
    ...(key.downArrow ? { downArrow: true } : {}),
    ...(key.leftArrow ? { leftArrow: true } : {}),
    ...(key.rightArrow ? { rightArrow: true } : {}),
    ...(key.ctrl ? { ctrl: true } : {}),
    ...(key.meta ? { meta: true } : {}),
    ...(key.shift ? { shift: true } : {}),
  };
}

export interface ExtensionsRailProps {
  panels: {
    extension: string;
    name: string;
    description: string;
    maxHeight?: number;
    render(): unknown;
    onKey?(input: string, key: PanelKeyEvent): boolean;
  }[];
  /** Panels the user collapsed from /extensions, by name. */
  collapsed: ReadonlySet<string>;
  columns: number;
  /** Rows the rail may distribute: viewport minus the composer frame and
   * the footer — the composer floor, guaranteed before any panel is sized. */
  rows: number;
  /** #1218 focus mode (Ctrl+P): the selected panel scrolls with j/k; esc
   * hands the keys back to the composer. Inactive rail consumes no keys. */
  focused?: boolean;
  onFocusExit?: () => void;
  /** Clamps the client applied to a declared maxHeight, for /extensions. */
  onClamp?: (clamps: ReadonlyMap<string, { max: number; shown: number }>) => void;
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

export function ExtensionsRail({ panels, collapsed, columns, rows, focused = false, onFocusExit, onClamp }: ExtensionsRailProps) {
  const theme = useTheme();
  const visible = panels.filter((p) => !collapsed.has(p.name));
  if (visible.length === 0) return null;
  if (columns <= NARROW_COLUMNS || rows < RAIL_MIN_ROWS) {
    // Narrow terminal or vertically tiny: the rail collapses to a one-line
    // footer strip — the panels are named, never rendered.
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
    <RailColumn
      panels={visible}
      rows={rows}
      focused={focused}
      onFocusExit={onFocusExit}
      onClamp={onClamp}
    />
  );
}

function RailColumn({
  panels,
  rows,
  focused,
  onFocusExit,
  onClamp,
}: {
  panels: ExtensionsRailProps["panels"];
  rows: number;
  focused: boolean;
  onFocusExit?: () => void;
  onClamp?: ExtensionsRailProps["onClamp"];
}) {
  const theme = useTheme();
  // Hybrid demand (#1218): the natural render height per panel, measured
  // every frame by the panel itself; 1 until the first measurement lands.
  const [demands, setDemands] = useState<ReadonlyMap<string, number>>(new Map());
  // Focus-mode state: which panel holds the keys, its scroll offset.
  const [selected, setSelected] = useState(0);
  const [offsets, setOffsets] = useState<ReadonlyMap<string, number>>(new Map());
  // apiVersion 1.17 (#1225): a consumed key must reach the panel's next
  // render — the panel's own state changed, nothing else did.
  const [keyEpoch, bumpForKey] = useReducer((n: number) => n + 1, 0);
  const selectedName = panels[Math.min(selected, panels.length - 1)]?.name ?? "";

  // Computed before the key handler so scrolling clips at the real
  // allocation; on a fresh mount the demands are still 0 and the window
  // is empty until the first measurement lands (same frame, effectively).
  const allocations = allocatePanels(
    rows,
    panels.map((p) => Math.max(0, demands.get(p.name) ?? 0)),
    panels.map((p) => p.maxHeight),
  );

  const measure = (name: string, natural: number) =>
    setDemands((prev) => (prev.get(name) === natural ? prev : new Map(prev).set(name, natural)));
  const scroll = (name: string, body: number, natural: number, delta: number) =>
    setOffsets((prev) => {
      const max = Math.max(0, natural - body);
      const next = Math.max(0, Math.min(max, (prev.get(name) ?? 0) + delta));
      return prev.get(name) === next ? prev : new Map(prev).set(name, next);
    });

  useInput(
    (input, key) => {
      if (key.escape) return onFocusExit?.();
      if (key.tab) return setSelected((i) => (i + 1) % panels.length);
      const panel = panels.find((p) => p.name === selectedName);
      if (!panel) return;
      const natural = demands.get(panel.name) ?? 1;
      // The scroll window clips at the rows the panel actually got (#1218
      // allocation), not at its declared or natural height — otherwise a
      // share-capped panel could never scroll at all.
      const body = Math.max(1, allocations[panels.indexOf(panel)]!.body);
      // apiVersion 1.18 (#1226): the scroll keys reach the panel first —
      // a panel composing text (the team draft) must be able to consume
      // `j`/`k`, so the fallback order flips while the ownership rule
      // holds: keys the panel ignores still scroll, esc/tab never arrive.
      const scrollDelta = input === "j" || key.downArrow ? 1 : input === "k" || key.upArrow ? -1 : 0;
      if (!panel.onKey) {
        if (scrollDelta !== 0) scroll(panel.name, body, natural, scrollDelta);
        return;
      }
      try {
        if (panel.onKey(input, panelKeyEvent(input, key))) {
          bumpForKey();
          return;
        }
      } catch {
        bumpForKey(); // redraw: the failure line (boundary) or the honest state
        return;
      }
      if (scrollDelta !== 0) scroll(panel.name, body, natural, scrollDelta);
    },
    { isActive: focused },
  );

  const clamps = new Map<string, { max: number; shown: number }>();
  panels.forEach((p, i) => {
    if (p.maxHeight !== undefined && allocations[i]!.maxClamped) {
      clamps.set(p.name, { max: p.maxHeight, shown: allocations[i]!.body });
    }
  });
  const clampKey = [...clamps].map(([n, c]) => `${n}:${c.max}:${c.shown}`).join(",");
  useEffect(() => {
    if (clamps.size > 0) onClamp?.(clamps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clampKey]);

  const capped = panels
    .map((p, i) => ({ p, a: allocations[i]! }))
    .filter(({ a }) => a.shareCapped);

  return (
    <Box flexDirection="column" width={RAIL_WIDTH + 1} flexShrink={0}>
      {panels.map((p, i) => {
        const a = allocations[i]!;
        const isFocused = focused && p.name === selectedName;
        return (
          <Box
            key={`${p.extension}:${p.name}`}
            flexDirection="column"
            width={RAIL_WIDTH}
            marginLeft={1}
            height={a.height + 2}
            overflow="hidden"
            borderStyle="round"
            borderColor={isFocused ? theme.dim : i === 0 ? theme.accent : theme.border}
            marginBottom={i === panels.length - 1 ? 0 : 1}
          >
            <PanelHeader
              name={p.name}
              extension={p.extension}
              allocation={a}
              rows={rows}
              above={offsets.get(p.name) ?? 0}
              below={Math.max(0, Math.min(demands.get(p.name) ?? 1, p.maxHeight ?? Infinity) - (offsets.get(p.name) ?? 0) - a.body)}
            />
            <Box
              flexDirection="column"
              height={Math.max(1, a.body)}
              overflow="hidden"
              flexShrink={0}
            >
              <PanelBoundary>
                <MeasuredPanel
                  name={p.name}
                  offset={Math.min(offsets.get(p.name) ?? 0, Math.max(0, (demands.get(p.name) ?? 1) - Math.max(1, a.body)))}
                  onMeasure={measure}
                >
                  <PanelBody panel={p} />
                </MeasuredPanel>
              </PanelBoundary>
            </Box>
          </Box>
        );
      })}
      {/* Status lines only under pressure (#1218 decision 5): silent when
       * every panel got what it asked for. */}
      {capped.map(({ p, a }) => (
        <Text key={`${p.name}-capped`} wrap="truncate" color={theme.warn}>
          {` ⚠ ${p.name} capped at ${a.body}r (of ${a.demand - 1})`}
        </Text>
      ))}
      {panels.map((p) =>
        p.maxHeight !== undefined && suggestOverlay(p.maxHeight, rows) ? (
          <Text key={`${p.name}-overlay`} wrap="truncate" color={theme.dim}>
            {` ${p.name} ·max ${p.maxHeight} — consider a full-screen overlay`}
          </Text>
        ) : null,
      )}
    </Box>
  );
}

/** The client-drawn header (#1218 decision 4): identity plus the real
 * allocation; the position indicator appears when the panel scrolls. */
function PanelHeader({
  name,
  extension,
  allocation,
  rows,
  above,
  below,
}: {
  name: string;
  extension: string;
  allocation: ReturnType<typeof allocatePanels>[number];
  rows: number;
  above: number;
  below: number;
}) {
  const theme = useTheme();
  const { plain, amber } = allocationHeader(name, extension, allocation, rows);
  const pos = above > 0 || below > 0 ? ` ↑${above} ↓${below}` : "";
  return (
    <Text wrap="truncate">
      {plain}
      <Text color={allocation.shareCapped ? theme.warn : theme.dim}>{amber}</Text>
      {pos ? <Text color={theme.dim}>{pos}</Text> : null}
    </Text>
  );
}

/** Measures the panel's natural height every frame: the body renders
 * unconstrained inside the clipping box, so its measured layout height is
 * the demand even when the box shows a scrolled window of it. */
function MeasuredPanel({
  name,
  offset,
  onMeasure,
  children,
}: {
  name: string;
  offset: number;
  onMeasure: (name: string, natural: number) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<DOMElement | null>(null);
  useEffect(() => {
    if (ref.current === null) return;
    const { height } = measureElement(ref.current);
    if (Number.isFinite(height) && height >= 0) onMeasure(name, height);
  });
  return (
    <Box flexDirection="column" ref={ref} marginTop={-offset} flexShrink={0}>
      {children}
    </Box>
  );
}

/** The panel's own render runs *inside* the boundary: the call itself
 * must be a child render, or a throw would climb out of the boundary's
 * reach (the boundary only catches its subtree). */
function PanelBody({ panel }: { panel: { render(): unknown } }) {
  return <>{asNode(panel.render())}</>;
}

function asNode(rendered: unknown): React.ReactNode {
  // The extension's render returns arbitrary Ink elements — drawn here
  // untouched, never wrapped into native components. Anything else is the
  // extension's own bug: shown as text, never executed.
  if (rendered === null || rendered === undefined || rendered === false || rendered === true) return null;
  if (typeof rendered === "string" || typeof rendered === "number") return <Text>{String(rendered)}</Text>;
  return rendered as React.ReactNode;
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

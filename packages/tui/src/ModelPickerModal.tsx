import { useEffect, useMemo, useRef, useState } from "react";
import { selectionStyle } from "./color";
import { Text, useInput } from "ink";
import { listOpenAiCompatModels, type CatalogModel } from "@moh/core";
import { useTheme } from "./themes";
import { dialogWidth, useViewport, windowing, wrapLines } from "./viewport";
import { Dialog, Dim, truncate } from "./ui";
import {
  fetchedToCatalog,
  filterCatalog,
  freeTextRow,
  mergePickCatalog,
  windowText,
  type EndpointPick,
} from "./model-picker";
import type { LiveModelListing } from "@moh/core";

/**
 * The `/model` modal (#181, #166 semantics): every endpoint configured in
 * the session, each with its model list — the vendored subscription
 * catalog (#156/#164) or the live `GET /models` fetch for openai-compat
 * backends (z.ai & co.). Type-to-filter across all endpoints, Enter
 * switches (effective next turn, `model_switched` event), free-text
 * fallback for models outside any list. Ephemeral — per-session only.
 */
export interface ModelPickerModalProps {
  /**
   * The **selected** ref (`endpoint/model-id`) — shown, and marked in the
   * list. ADR-0050: this header and the `current` marker name what a pick
   * would replace, so they state the selection, never the serving stop;
   * `servingModel` (when it differs) states what serves right now.
   */
  activeModel: string;
  /** The model actually serving the calls (ADR-0050) — shown beside the
   * selection only while the two differ, so the picker never hides a
   * fallback that is in play. */
  servingModel?: string;
  /** The session's merged endpoint profiles (App passes
   * `session.endpointProfiles`). Empty (pre-built providers) → free text. */
  endpoints: EndpointPick[];
  /** Performs the switch (AgentSession.switchModel). */
  onSwitch: (ref: string) => { ok: true; model: string } | { ok: false; error: string; reason?: "context_length" };
  onSwitched: (model: string) => void;
  /** Live listings per endpoint name (#551), merged additively into
   * catalog-backed endpoints' lists (vendored wins on collision). */
  liveCatalog: Record<string, LiveModelListing[]>;
  /** Forces a background live refresh (the `r` key). */
  onRefreshLive: () => void;
  /** True while a live refresh is in flight. */
  refreshingLive: boolean;
  /** #948: runs forced compaction — offered when a picked model cannot
   * hold the session's measured context. */
  onCompact: () => void;
  onToast: (message: string) => void;
  /** ADR-0049 (#986): the window a provider declared for a model
   * reference this session, when one was learned — shown next to the
   * catalog figure, so the screen and the arithmetic agree. */
  declaredWindow?: (ref: string) => number | undefined;
  onClose: () => void;
}

const FOOTER = "type to filter (endpoint or model) · r refresh live · ↑↓ select · enter switch · esc close";
const MIN_LIST_ROWS = 3;
const UNFIT_HINT = " c compact now, then pick again · any other key keeps browsing";

type RemoteState = Record<string, CatalogModel[] | "error" | "loading">;

export function ModelPickerModal({
  activeModel,
  servingModel,
  endpoints,
  onSwitch,
  onSwitched,
  liveCatalog,
  onRefreshLive,
  refreshingLive,
  onToast,
  declaredWindow,
  /** #948: runs forced compaction (/compact) — offered when a picked
   * model cannot hold the session's measured context. */
  onCompact,
  onClose,
}: ModelPickerModalProps) {
  const theme = useTheme();
  const viewport = useViewport();
  // #948: a context-fit refusal awaiting the user's choice — compact
  // now, or keep browsing for a better-fitting model (stay = decline).
  const [unfit, setUnfit] = useState<{ ref: string; error: string } | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  // Live-fetched lists for endpoints without a vendored catalog (#181
  // follow-up): keyed by endpoint name, filled asynchronously.
  const [remote, setRemote] = useState<RemoteState>({});

  const activeEndpoint = activeModel.includes("/") ? activeModel.slice(0, activeModel.indexOf("/")) : undefined;

  // #551: opening the picker is a refresh point — serve from cache via a
  // non-forced refresh (no-op when the App-level fetch is fresh/busy).
  useEffect(() => {
    onRefreshLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Vendored catalogs are sync; openai-compat ones fetch on open. Failure
  // keeps the endpoint listed with free-text entry only — never blocks.
  // The guard is unmount, not the effect: `endpoints` changes identity when
  // the live refresh lands, and a response discarded then would leave the
  // endpoint "loading" for good (the re-run skips it).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    for (const e of endpoints) {
      if (e.catalog.length > 0 || !e.baseUrl || remote[e.name]) continue;
      setRemote((r) => ({ ...r, [e.name]: "loading" }));
      listOpenAiCompatModels(e.baseUrl, e.apiKey)
        .then((ids) => mounted.current && setRemote((r) => ({ ...r, [e.name]: fetchedToCatalog(ids) })))
        .catch(() => mounted.current && setRemote((r) => ({ ...r, [e.name]: "error" })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoints]);

  interface Row {
    endpoint: string;
    type: string;
    model?: CatalogModel & { shippedContextWindow?: number };
    free?: string;
    current?: boolean;
  }

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    // A slashed query ("zai/glm") narrows by endpoint first: the part
    // before the slash matches endpoint names, the rest filters models.
    const q = query.trim().toLowerCase();
    const slash = q.indexOf("/");
    const endpointPrefix = slash > 0 ? q.slice(0, slash) : null;
    const modelQuery = slash > 0 ? query.trim().slice(slash + 1) : query;
    for (const e of endpoints) {
      if (endpointPrefix !== null && !e.name.toLowerCase().startsWith(endpointPrefix)) continue;
      const list = mergePickCatalog(
        e.catalog.length > 0
          ? e.catalog
          : Array.isArray(remote[e.name])
            ? (remote[e.name] as CatalogModel[])
            : [],
        liveCatalog[e.name] ?? [],
      );
      for (const model of filterCatalog(list, modelQuery)) {
        out.push({
          endpoint: e.name,
          type: e.type,
          model,
          current: e.name === activeEndpoint && model.id === activeModel.split("/")[1],
        });
      }
    }
    if (q && endpointPrefix === null) {
      out.push({ endpoint: activeEndpoint ?? "", type: "", free: query.trim() });
    }
    return out;
  }, [endpoints, remote, query, activeEndpoint, activeModel, liveCatalog]);

  const visibleRows = rows;

  const innerWidth = Math.max(20, Math.floor(viewport.columns * 0.6) - 6);

  const commit = (row: Row) => {
    // Free text: a slashed ref goes as-is; a bare id rides the active
    // endpoint when there is one (pre-built providers pass it through).
    const ref =
      row.free !== undefined
        ? row.free.includes("/") || !activeEndpoint
          ? row.free
          : `${activeEndpoint}/${row.free}`
        : `${row.endpoint}/${row.model!.id}`;
    const result = onSwitch(ref);
    if (!result.ok) {
      // #948: a context-fit refusal offers a way out before the wall
      // stands — compact, or pick a better-fitting model (stay here).
      if (result.reason === "context_length") {
        setUnfit({ ref, error: result.error });
        return;
      }
      return onToast(`✗ ${result.error}`);
    }
    onSwitched(result.model);
    onToast(`✓ model switched to ${result.model} — effective from the next turn`);
    onClose();
  };

  const line = (row: Row, selected: boolean): string => {
    // ADR-0049, both doors: where a window was declared — by a refusal
    // this session, or by the endpoint's listing (the merged row carries
    // the shipped figure it replaced) — both numbers appear; a row whose
    // values agree is unchanged.
    const body =
      row.free !== undefined
        ? freeTextRow(row.free)
        : `${row.endpoint} · ${row.model!.name} · ${windowText(
            row.model!.contextWindow,
            declaredWindow?.(`${row.endpoint}/${row.model!.id}`),
            row.model!.shippedContextWindow,
          )}`;
    return ` ${selected ? "›" : " "} ${body}${row.current ? " ‹current›" : ""}${selected ? " " : ""}`;
  };

  useInput((input, key) => {
    if (unfit) {
      // #948: declining both ways leaves the current model in effect,
      // no error turn — the picker stays open for a better-fitting pick.
      if (input === "c") {
        setUnfit(null);
        onToast("compacting… try the switch again after it lands");
        onCompact();
        return;
      }
      setUnfit(null);
      return;
    }
    if (key.escape) return onClose();
    if (input === "r" && !query) return onRefreshLive();
    if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) return setCursor((c) => Math.min(visibleRows.length - 1, c + 1));
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      return setCursor(0);
    }
    if (key.return || input === "\n") {
      const row = visibleRows[cursor];
      return row ? commit(row) : undefined;
    }
    if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow) {
      setQuery((q) => q + input);
      return setCursor(0);
    }
  });

  const loading = endpoints.filter((e) => remote[e.name] === "loading").map((e) => e.name);
  const failed = endpoints.filter((e) => remote[e.name] === "error");

  // #1540: every row the modal draws around the list, as text, so the list
  // window is what is left of the viewport — not a guessed constant. Each
  // text is pre-wrapped (wrapLines) because a Text decides its height at
  // render time, after the budget is spent.
  const header =
    servingModel && servingModel !== activeModel
      ? `active: ${activeModel} · serving ${servingModel}`
      : `active: ${activeModel}`;
  const fetching =
    loading.length > 0 || refreshingLive
      ? ` fetching models${refreshingLive && !loading.length ? " (live refresh)" : `: ${loading.join(", ")}`}…`
      : null;
  const noList = failed.length > 0 ? ` no list from ${failed.map((e) => e.name).join(", ")} — free text works` : null;
  const empty = visibleRows.length === 0 && !loading.length ? " no models yet — type a model id (free text)" : null;
  const unfitLines = unfit
    ? [" ✗ this model cannot hold this session's context", ` ${unfit.error}`, UNFIT_HINT]
    : [];
  const textWidth = Math.max(1, dialogWidth(viewport) - 2 - 4 - 1);
  const wrapped = (text: string) => wrapLines(text, textWidth).length;
  // While the context-fit prompt is up its own hint names the keys, so the
  // footer yields its rows; the blank spacers yield next, only when even
  // the minimum list would not fit with them.
  const showFooter = !unfit;
  const chromeRows = (spacers: number) =>
    2 + // border
    2 + // title + its spacer
    wrapped(header) +
    wrapped(`filter: ${query}▏`) +
    2 + // `↑ N more` / `↓ N more` — reserved so the window never depends on itself
    (empty ? wrapped(empty) : 0) +
    (fetching ? wrapped(fetching) : 0) +
    (noList ? wrapped(noList) : 0) +
    (unfit ? unfitLines.reduce((n, l) => n + wrapped(l), 0) : 0) +
    (showFooter ? wrapped(FOOTER) : 0) +
    spacers; // after the header, after the filter, before the footer / unfit prompt
  // One row of slack: a frame as tall as the terminal makes Ink clear it.
  const available = viewport.rows - 1;
  const spacers = available - chromeRows(3) >= MIN_LIST_ROWS ? 3 : 0;
  const win = windowing(visibleRows.length, cursor, Math.max(MIN_LIST_ROWS, available - chromeRows(spacers)));
  const gap = spacers > 0 ? <Text> </Text> : null;

  return (
    <Dialog title=" model " color={theme.ok}>
      {/* ADR-0050: `active:` is what a pick replaces (the selection); the
          serving stop appears only while a fallback serves the calls. */}
      <Dim>{header}</Dim>
      {gap}
      <Text bold>{`filter: ${query}▏`}</Text>
      {gap}
      {win.above > 0 && <Dim>{` ↑ ${win.above} more`}</Dim>}
      {visibleRows.slice(win.start, win.start + win.count).map((row, i) => {
        const index = win.start + i;
        const selected = index === cursor;
        return (
          <Text
            key={index}
            {...(selected ? selectionStyle(theme) : {})}
          >
            {truncate(line(row, selected), innerWidth)}
          </Text>
        );
      })}
      {win.below > 0 && <Dim>{` ↓ ${win.below} more`}</Dim>}
      {empty && <Dim>{empty}</Dim>}
      {fetching && <Dim>{fetching}</Dim>}
      {noList && <Dim>{noList}</Dim>}
      {unfit && (
        <>
          {gap}
          <Text bold>{unfitLines[0]}</Text>
          <Dim>{unfitLines[1]}</Dim>
          <Text bold>{unfitLines[2]}</Text>
        </>
      )}
      {showFooter && (
        <>
          {gap}
          <Dim>{FOOTER}</Dim>
        </>
      )}
    </Dialog>
  );
}

import React, { useEffect, useMemo, useState } from "react";
import { Text, useInput } from "ink";
import { listOpenAiCompatModels, type CatalogModel } from "@moh/core";
import { useTheme } from "./themes";
import { useViewport, windowing } from "./viewport";
import { Dialog, Dim, truncate } from "./ui";
import {
  fetchedToCatalog,
  filterCatalog,
  freeTextRow,
  type EndpointPick,
} from "./model-picker";

/**
 * The `/model` modal (#181, #166 semantics): every endpoint configured in
 * the session, each with its model list — the vendored subscription
 * catalog (#156/#164) or the live `GET /models` fetch for openai-compat
 * backends (z.ai & co.). Type-to-filter across all endpoints, Enter
 * switches (effective next turn, `model_switched` event), free-text
 * fallback for models outside any list. Ephemeral — per-session only.
 */
export interface ModelPickerModalProps {
  /** Current ref (`endpoint/model-id`) — shown, and marked in the list. */
  activeModel: string;
  /** The session's merged endpoint profiles (App passes
   * `session.endpointProfiles`). Empty (pre-built providers) → free text. */
  endpoints: EndpointPick[];
  /** Performs the switch (AgentSession.switchModel). */
  onSwitch: (ref: string) => { ok: true; model: string } | { ok: false; error: string };
  onSwitched: (model: string) => void;
  onToast: (message: string) => void;
  onClose: () => void;
}

type RemoteState = Record<string, CatalogModel[] | "error" | "loading">;

export function ModelPickerModal({
  activeModel,
  endpoints,
  onSwitch,
  onSwitched,
  onToast,
  onClose,
}: ModelPickerModalProps) {
  const theme = useTheme();
  const viewport = useViewport();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  // Live-fetched lists for endpoints without a vendored catalog (#181
  // follow-up): keyed by endpoint name, filled asynchronously.
  const [remote, setRemote] = useState<RemoteState>({});

  const activeEndpoint = activeModel.includes("/") ? activeModel.slice(0, activeModel.indexOf("/")) : undefined;

  // Vendored catalogs are sync; openai-compat ones fetch on open. Failure
  // keeps the endpoint listed with free-text entry only — never blocks.
  useEffect(() => {
    let live = true;
    for (const e of endpoints) {
      if (e.catalog.length > 0 || !e.baseUrl || remote[e.name]) continue;
      setRemote((r) => ({ ...r, [e.name]: "loading" }));
      listOpenAiCompatModels(e.baseUrl, e.apiKey)
        .then((ids) => live && setRemote((r) => ({ ...r, [e.name]: fetchedToCatalog(ids) })))
        .catch(() => live && setRemote((r) => ({ ...r, [e.name]: "error" })));
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoints]);

  interface Row {
    endpoint: string;
    type: string;
    model?: CatalogModel;
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
      const list =
        e.catalog.length > 0
          ? e.catalog
          : Array.isArray(remote[e.name])
            ? (remote[e.name] as CatalogModel[])
            : [];
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
  }, [endpoints, remote, query, activeEndpoint, activeModel]);

  const visibleRows = rows;

  const win = windowing(visibleRows.length, cursor, Math.max(3, viewport.rows - 8));
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
    if (!result.ok) return onToast(`✗ ${result.error}`);
    onSwitched(result.model);
    onToast(`✓ model switched to ${result.model} — effective from the next turn`);
    onClose();
  };

  const line = (row: Row, selected: boolean): string => {
    const body =
      row.free !== undefined
        ? freeTextRow(row.free)
        : `${row.endpoint} · ${row.model!.name} · ${row.model!.contextWindow > 0 ? `${Math.round(row.model!.contextWindow / 1000)}k` : "—"}`;
    return ` ${selected ? "›" : " "} ${body}${row.current ? " ‹current›" : ""}${selected ? " " : ""}`;
  };

  useInput((input, key) => {
    if (key.escape) return onClose();
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

  return (
    <Dialog title=" model " color={theme.ok}>
      <Dim>{`active: ${activeModel}`}</Dim>
      <Text> </Text>
      <Text bold>{`filter: ${query}▏`}</Text>
      <Text> </Text>
      {win.above > 0 && <Dim>{` ↑ ${win.above} more`}</Dim>}
      {visibleRows.slice(win.start, win.start + win.count).map((row, i) => {
        const index = win.start + i;
        const selected = index === cursor;
        return (
          <Text
            key={index}
            color={selected ? theme.bg : undefined}
            backgroundColor={selected ? theme.accent : undefined}
          >
            {truncate(line(row, selected), innerWidth)}
          </Text>
        );
      })}
      {win.below > 0 && <Dim>{` ↓ ${win.below} more`}</Dim>}
      {visibleRows.length === 0 && !loading.length && (
        <Dim> no models yet — type a model id (free text)</Dim>
      )}
      {loading.length > 0 && <Dim>{` fetching models: ${loading.join(", ")}…`}</Dim>}
      {failed.length > 0 && (
        <Dim>{` no list from ${failed.map((e) => e.name).join(", ")} — free text works`}</Dim>
      )}
      <Text> </Text>
      <Dim>type to filter (endpoint or model) · ↑↓ select · enter switch · esc close</Dim>
    </Dialog>
  );
}

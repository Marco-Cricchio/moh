import React, { useMemo, useState } from "react";
import { Text, useInput } from "ink";
import { type CatalogModel } from "@moh/core";
import { useTheme } from "./themes";
import { useViewport, windowing } from "./viewport";
import { Dialog, Dim, truncate } from "./ui";
import { filterCatalog, freeTextRow, modelRow, type PickerRow } from "./model-picker";

/**
 * The `/model` modal (#181, #166 semantics): the active provider's
 * catalog with type-to-filter, Enter switching (effective next turn,
 * `model_switched` event), and a free-text fallback row for models
 * outside any catalog (openai-compat, custom endpoints). Ephemeral —
 * per-session only, nothing persisted.
 */
export interface ModelPickerModalProps {
  /** Current ref (`endpoint/model-id`) — shown, and marked in the list. */
  activeModel: string;
  /** Provider type of the active endpoint; undefined → free-text only. */
  providerType?: string;
  catalog: CatalogModel[];
  /** Performs the switch (AgentSession.switchModel). */
  onSwitch: (ref: string) => { ok: true; model: string } | { ok: false; error: string };
  onSwitched: (model: string) => void;
  onToast: (message: string) => void;
  onClose: () => void;
}

export function ModelPickerModal({
  activeModel,
  providerType,
  catalog,
  onSwitch,
  onSwitched,
  onToast,
  onClose,
}: ModelPickerModalProps) {
  const theme = useTheme();
  const viewport = useViewport();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const endpoint = activeModel.includes("/") ? activeModel.slice(0, activeModel.indexOf("/")) : undefined;
  const rows: PickerRow[] = useMemo(() => {
    const matches = filterCatalog(catalog, query);
    const list: PickerRow[] = matches.map((model) => ({ kind: "catalog", model }) as const);
    if (query.trim()) list.push({ kind: "free", query: query.trim() });
    return list;
  }, [catalog, query]);

  const win = windowing(rows.length, cursor, Math.max(3, viewport.rows - 8));
  const innerWidth = Math.max(20, Math.floor(viewport.columns * 0.6) - 6);
  const visible = rows.slice(win.start, win.start + win.count);

  const commit = (row: PickerRow) => {
    const ref = row.kind === "catalog" ? row.model.id : row.query;
    // Free text on a known endpoint rides `endpoint/<id>`; a catalog pick
    // is a bare id resolved against the active endpoint.
    const full = row.kind === "free" && endpoint && !ref.includes("/") ? `${endpoint}/${ref}` : ref;
    const result = onSwitch(full);
    if (!result.ok) return onToast(`✗ ${result.error}`);
    onSwitched(result.model);
    onToast(`✓ model switched to ${result.model} — effective from the next turn`);
    onClose();
  };

  useInput((input, key) => {
    if (key.escape) return onClose();
    if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) return setCursor((c) => Math.min(rows.length - 1, c + 1));
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      return setCursor(0);
    }
    if (key.return || input === "\n") {
      const row = rows[cursor];
      return row ? commit(row) : undefined;
    }
    if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow) {
      setQuery((q) => q + input);
      return setCursor(0);
    }
  });

  return (
    <Dialog title={` model ${providerType ? `· ${providerType}` : ""} `} color={theme.ok}>
      <Dim>{`active: ${activeModel}`}</Dim>
      <Text> </Text>
      <Text bold>{`filter: ${query}▏`}</Text>
      <Text> </Text>
      {win.above > 0 && <Dim>{` ↑ ${win.above} more`}</Dim>}
      {visible.map((row, i) => {
        const index = win.start + i;
        const selected = index === cursor;
        const line =
          row.kind === "catalog"
            ? modelRow(row.model, row.model.id === activeModel.split("/")[1])
            : freeTextRow(row.query);
        return (
          <Text
            key={index}
            color={selected ? theme.bg : undefined}
            backgroundColor={selected ? theme.accent : undefined}
          >
            {truncate(` ${selected ? "›" : " "} ${line}${selected ? " " : ""}`, innerWidth)}
          </Text>
        );
      })}
      {win.below > 0 && <Dim>{` ↓ ${win.below} more`}</Dim>}
      {rows.length === 0 && <Dim> no catalog — type a model id (free text)</Dim>}
      <Text> </Text>
      <Dim>type to filter · ↑↓ select · enter switch · esc close</Dim>
    </Dialog>
  );
}

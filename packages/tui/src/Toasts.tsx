import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import { useTheme } from "./themes";
import { ic } from "./icons";

/**
 * Transient one-line notices above the footer (style guide §3.6): toast,
 * don't block. Never modal, never more than a few seconds on screen.
 */
export interface Toast {
  id: number;
  text: string;
  kind: "info" | "ok" | "warn";
  /** Where the toast lands (spec D9): "side" = bottom of the left menu
   * sidebar (memory-class notices); "chat" (default) = bottom center of the
   * chat area. */
  position?: "chat" | "side";
}

const TOAST_MS = 3500;

export interface ToastsApi {
  toasts: Toast[];
  push: (text: string, kind?: Toast["kind"], position?: Toast["position"]) => void;
}

/**
 * #874: while a gate or modal owns the input, an expiring toast must not
 * re-render — with the volatile region at viewport height Ink turns any
 * frame into a whole-screen clear+reprint. Expiries are parked in a
 * `pending` set and released when `blocked` clears, so the deferral costs
 * no timer of its own (the old self-rescheduling poll ran forever if a
 * gate never closed).
 */
export function useToasts(blocked = false): ToastsApi {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const expired = useRef(new Set<number>());
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;

  const push = useCallback((text: string, kind: Toast["kind"] = "info", position: Toast["position"] = "chat") => {
    const id = nextId.current++;
    setToasts((ts) => [...ts.slice(-2), { id, text, kind, position }]);
    setTimeout(() => {
      if (blockedRef.current) {
        expired.current.add(id);
        return;
      }
      setToasts((ts) => ts.filter((t) => t.id !== id));
    }, TOAST_MS);
  }, []);

  useEffect(() => {
    if (blocked || expired.current.size === 0) return;
    const due = expired.current;
    expired.current = new Set();
    setToasts((ts) => ts.filter((t) => !due.has(t.id)));
  }, [blocked]);

  return { toasts, push };
}

/**
 * The toast list (style guide §3.6): transient one-line notices.
 * Text wraps to `wrap` columns when given (sidebar-width notices).
 */
export function Toasts({ toasts, wrap }: { toasts: Toast[]; wrap?: number }) {
  const theme = useTheme();
  if (toasts.length === 0) return null;
  return (
    <Box flexDirection="column" alignItems={wrap ? "flex-start" : "center"} width={wrap}>
      {toasts.map((t) => (
        <Text key={t.id} wrap={wrap ? "wrap" : undefined} color={t.kind === "ok" ? theme.ok : t.kind === "warn" ? theme.warn : theme.dim}>
          {` ${ic("·", "*")} ${t.text} `}
        </Text>
      ))}
    </Box>
  );
}

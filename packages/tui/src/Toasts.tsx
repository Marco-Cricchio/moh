import React, { useCallback, useRef, useState } from "react";
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
}

const TOAST_MS = 3500;

export interface ToastsApi {
  toasts: Toast[];
  push: (text: string, kind?: Toast["kind"]) => void;
}

export function useToasts(): ToastsApi {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = nextId.current++;
    setToasts((ts) => [...ts.slice(-2), { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), TOAST_MS);
  }, []);

  return { toasts, push };
}

export function Toasts({ toasts }: { toasts: Toast[] }) {
  const theme = useTheme();
  if (toasts.length === 0) return null;
  return (
    <Box flexDirection="column" alignItems="center">
      {toasts.map((t) => (
        <Text key={t.id} color={t.kind === "ok" ? theme.ok : t.kind === "warn" ? theme.warn : theme.dim}>
          {` ${ic("·", "*")} ${t.text} `}
        </Text>
      ))}
    </Box>
  );
}

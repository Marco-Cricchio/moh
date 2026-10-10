import React from "react";
import { Text } from "ink";
import { colorEnabled } from "./color";

export const GLYPH_OK = "#2ea043";
export const GLYPH_ERR = "#ee5a52";

/** The fixed semantic color for a glyph run, or undefined when the glyph carries no pass/fail meaning. */
export function glyphColor(glyph: string): string | undefined {
  if (!colorEnabled()) return undefined;
  if (glyph.includes("✓")) return GLYPH_OK;
  if (glyph.includes("✗")) return GLYPH_ERR;
  return undefined;
}

/** Renders a string with every ✓/✗ re-colored to the fixed semantic color; the rest keeps `color`. */
export function SemanticText({ text, color }: { text: string; color: string | undefined }): React.ReactNode {
  const parts = text.split(/([✓✗])/);
  if (parts.length === 1) return <Text color={color}>{text}</Text>;
  return (
    <Text>
      {parts.map((part, i) => (
        <Text key={i} color={glyphColor(part) ?? color}>
          {part}
        </Text>
      ))}
    </Text>
  );
}

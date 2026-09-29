/** One scenario shared by both parity channels (#1062). Keep all user-visible
 * content here: the fake provider and the PTY SSE adapter consume this exact
 * sequence rather than maintaining two fixtures that can drift. */
export const PARITY = {
  cols: 100,
  rows: 30,
  prompt: "parity scenario",
  beforeTool: "PARITY-BEFORE",
  table: [
    "| Name | State |\n",
    "| --- | --- |\n",
    "| parity-tool | complete |\n",
  ],
  oversized: `PARITY-OVERSIZED ${"the same streamed paragraph crosses the renderer boundary. ".repeat(35)}\n\n`,
  final: "PARITY-FINAL",
} as const;

export const parityReply = [
  `${PARITY.beforeTool}\n\n`,
  ...PARITY.table,
  PARITY.oversized,
  PARITY.final,
];

/** The same two model calls in the in-process channel: first a real builtin
 * tool call, then the streamed Markdown reply. */
export const parityMockTurns: Parameters<typeof import("@moh/core").MockProvider.scripted>[0] = [
  {
    deltas: [""],
    finish: "tool_calls",
    toolCalls: [{ callId: "parity-bash", name: "bash", args: { command: "printf parity-tool" } }],
  },
  { deltas: parityReply, finish: "stop", deltaDelayMs: 15 },
];

/** The PTY adapter's model-call responses. It is data, not a second scenario:
 * the call index only selects the protocol envelope needed by OpenAI Chat
 * Completions; the tool/content and all visible text come from this module. */
export function paritySseChunks(call: number): Array<Record<string, unknown>> {
  if (call === 1) {
    return [
      { role: "assistant" },
      { tool_calls: [{ index: 0, id: "parity-bash", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf parity-tool" }) } }] },
      {},
    ];
  }
  return [
    { role: "assistant" },
    ...parityReply.map((content) => ({ content })),
    {},
  ];
}

/** Canonical transcript rows: remove only terminal-side framing. The
 * comparison deliberately keeps content rows and table borders, while
 * ignoring model/cwd/status chrome that cannot be identical across the
 * in-process and child-process assemblies. */
export function canonicalContentRows(rows: readonly string[]): string[] {
  return rows
    .map((row) => row.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\s+$/g, ""))
    .filter((row) => /PARITY-|parity-tool|complete/.test(row));
}

export function firstDivergence(left: readonly string[], right: readonly string[]): string | null {
  const count = Math.max(left.length, right.length);
  for (let i = 0; i < count; i++) {
    if (left[i] !== right[i]) return `row ${i}: fake=${JSON.stringify(left[i] ?? "<missing>")} pty=${JSON.stringify(right[i] ?? "<missing>")}`;
  }
  return null;
}

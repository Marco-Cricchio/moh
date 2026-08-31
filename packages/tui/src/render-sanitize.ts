/**
 * Display-only boundary for strings controlled by models, tools, or logs.
 * Keep ordinary layout characters; remove terminal controls before Ink sees
 * them so the recorded event remains faithful while its projection is safe.
 */
export function sanitizeForDisplay(value: string): string {
  return value
    // ESC CSI and C1 CSI sequences, including their parameter payload.
    .replace(/(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]/g, "")
    // OSC sequences may terminate with BEL or ST.
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)?/g, "")
    // C0 except LF/TAB, DEL, and all C1 controls.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}

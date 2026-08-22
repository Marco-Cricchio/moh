/**
 * A minimal moh extension: vetoes `bash` calls whose command starts with
 * `rm -rf`, and logs every event to stderr.
 *
 * An extension is just a module whose default export is a
 * `defineExtension(...)` result. It is loaded by a host with
 * `ExtensionRuntime.registerFile()` — see run-extension.ts.
 */
import { defineExtension, MOH_EXTENSION_API_VERSION } from "@moh/extension";

export default defineExtension({
  name: "no-rm-rf",
  version: "0.1.0",
  apiVersion: MOH_EXTENSION_API_VERSION, // "1.0" — major must match the host
  setup(ctx) {
    // Durable per-extension state; carried across hot-reloads.
    ctx.state.seen ??= 0;

    // Veto is the only influence an extension has: it can *restrict*
    // (deny a call), never grant permissions the user didn't give.
    ctx.onToolCall(({ name, args }) => {
      if (name !== "bash") return;
      const command = String(args?.command ?? "");
      if (command.trimStart().startsWith("rm -rf")) {
        return { veto: true, reason: "no-rm-rf: refusing recursive force delete" };
      }
    });

    // Observation: every event-log entry, in order.
    ctx.onEvent(({ event }) => {
      if (event.type === "tool_call") {
        ctx.state.seen += 1;
        console.error(`[no-rm-rf] tool call #${ctx.state.seen}: ${event.name}`);
      }
    });
  },
});

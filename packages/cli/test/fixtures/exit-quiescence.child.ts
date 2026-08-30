/** #341 regression child: reproduces the shutdown-tail conditions — an open
 * keep-alive HTTP socket (as Bun's provider client leaves behind) plus a
 * tracked, never-settling cleanup promise — then runs the same bounded-exit
 * path the CLI uses (`finishExit`). The process must terminate within the
 * budget, not when the socket times out. */
import { trackExitWork, finishExit } from "@moh/tui";

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
// Completed fetch; the keep-alive connection stays pooled and open.
await fetch(`http://127.0.0.1:${server.port}/`);
server.stop(false); // socket stays open on the client side

// Pending session-disposal-like work that never settles.
trackExitWork(new Promise(() => {}));

await finishExit(200, 0);
// Unreachable if finishExit terminates the process as promised.
console.log("EXIT-BOUNDS-FAILED");

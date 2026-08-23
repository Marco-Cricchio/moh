/**
 * Generic, provider-neutral OAuth machinery (issue #133, spec:
 * docs/spec/oauth-subscription-auth.md; mechanics verified against
 * Claude Code's `services/oauth/*` — see research/oauth-subscription-auth.md).
 *
 * This module knows nothing about Anthropic/OpenAI/Google specifics; the
 * per-provider grant modules (later tickets) feed it URLs, client_ids and
 * PKCE/state values. It provides:
 *
 * - PKCE S256 pair + state generation (base64url, 32 random bytes);
 * - a loopback callback server bound to `localhost` with an OS-assigned
 *   ephemeral port (fixed ports only where a provider's redirect-URI
 *   allowlist demands them, e.g. OpenAI 1455/1457);
 * - the **manual-paste race**: show the manual URL *and* try `openUrl`;
 *   whichever delivers an authorization code first wins (headless-first:
 *   SSH/VPS machines have no browser, so the paste path always works);
 * - a ToS warning helper, shown and acknowledged before any subscription
 *   flow starts (spec invariant 4).
 *
 * Headless core (principle 1): everything here is injectable-I/O pure
 * machinery; no client code is imported.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { OnboardingIo } from "../provider-onboarding";

/** Default callback wait: 5 minutes, matching the official CLIs. */
export const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export interface PkcePair {
  /** `code_verifier`: base64url of 32 random bytes (43 chars, no padding). */
  verifier: string;
  /** `code_challenge`: base64url(sha256(verifier)) for method S256. */
  challenge: string;
}

/** Fresh PKCE S256 pair. A new pair per authorization attempt. */
export function generatePkce(): PkcePair {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

/** `state`: base64url of 32 random bytes, validated on callback (CSRF). */
export function generateState(): string {
  return base64url(randomBytes(32));
}

/** Builds an authorize URL with URL-encoded query params. */
export function buildAuthorizeUrl(endpoint: string, params: Record<string, string>): string {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export interface CallbackServer {
  /** The redirect URI to embed in the authorize URL. */
  redirectUri: string;
  /** Port actually bound (explicit allowlist port, or the OS-assigned one). */
  port: number;
  /** Resolves with the state-validated authorization code. */
  code: Promise<string>;
  /** Aborts the wait and shuts the server down immediately. */
  cancel(): void;
}

export interface LoopbackOptions {
  /** Random per-attempt state; callbacks carrying anything else get a 400. */
  state: string;
  /** Host to bind. Default `localhost` — loopback only, never 0.0.0.0. */
  host?: string;
  /**
   * Ports to try in order. Default `[0]` = OS-assigned ephemeral. Fixed
   * ports only where a provider's allowlist demands them (OpenAI 1455/1457).
   */
  ports?: number[];
  /** Callback path. Default `/callback`. */
  callbackPath?: string;
  /** How long to wait for the code. Default 5 minutes. */
  timeoutMs?: number;
}

/**
 * Starts the loopback callback server and resolves once it is listening
 * (so the caller can build the authorize URL with the real port). The
 * server validates `state`, serves a minimal success page, and shuts
 * itself down immediately after delivering the code.
 */
export function startLoopbackCallback(opts: LoopbackOptions): Promise<CallbackServer> {
  const host = opts.host ?? "localhost";
  const ports = opts.ports ?? [0];
  const callbackPath = opts.callbackPath ?? "/callback";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;

  let settled = false;
  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Permanent no-op handler: `cancel()` may reject after every caller has
  // moved on (e.g. the paste path won the race); without this, Bun flags
  // the late rejection as unhandled even when derived handlers exist.
  code.catch(() => {});
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectCode(new Error("timed out waiting for the OAuth callback"));
    }
    server?.close();
  }, timeoutMs);
  timer.unref?.();

  let server: Server | undefined;

  const shutdown = (err?: Error) => {
    clearTimeout(timer);
    if (!settled) {
      settled = true;
      if (err) rejectCode(err);
    }
    server?.close();
  };

  const handleRequest = (
    req: { url?: string },
    res: {
      statusCode: number;
      setHeader(k: string, v: string): void;
      end(body: string): void;
    },
  ): string | null => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname !== callbackPath) {
      res.statusCode = 404;
      res.end("not found");
      return null;
    }
    // Provider-side refusal (e.g. access_denied): fail fast instead of
    // making the user wait out the whole timeout.
    const errorParam = url.searchParams.get("error");
    if (errorParam) {
      res.statusCode = 400;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(`authorization failed: ${errorParam}; you can close this tab.`);
      shutdown(new Error(`authorization failed: ${errorParam}`));
      return null;
    }
    const codeParam = url.searchParams.get("code");
    const stateParam = url.searchParams.get("state");
    if (!codeParam || stateParam !== opts.state) {
      res.statusCode = 400;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("authorization callback rejected (invalid state); you can close this tab.");
      return null; // keep waiting for the real callback
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<html><body><p>Authorization received — you can close this tab and return to the terminal.</p></body></html>");
    return codeParam;
  };

  return new Promise<CallbackServer>((resolve, reject) => {
    const tryPort = (index: number): void => {
      if (index >= ports.length) {
        reject(new Error(`could not bind any loopback port (tried: ${ports.join(", ")})`));
        return;
      }
      const candidate = createServer((req, res) => {
        const delivered = handleRequest(req, res);
        if (delivered !== null) {
          settled = true;
          resolveCode(delivered);
          shutdown();
        }
      });
      candidate.once("error", () => {
        candidate.close();
        tryPort(index + 1);
      });
      // exclusive: no SO_REUSEPORT sharing — a taken port must fail so we
      // can fall through to the next one in `ports`.
      candidate.listen({ port: ports[index], host, exclusive: true }, () => {
        server = candidate;
        const address = candidate.address();
        const port = typeof address === "object" && address !== null ? address.port : ports[index];
        resolve({
          redirectUri: `http://${host}:${port}${callbackPath}`,
          port,
          code,
          cancel() {
            shutdown(new Error("callback cancelled"));
          },
        });
      });
    };
    tryPort(0);
  });
}

/** The I/O seam the race needs: what `OnboardingIo` grows for subscriptions. */
export type AuthorizationIo = Pick<OnboardingIo, "ask" | "info" | "openUrl">;

export interface RaceOptions {
  /**
   * The **automatic-path authorize URL**: the provider's authorize endpoint
   * with `redirect_uri` = the loopback callback. This is what `openUrl`
   * opens in the browser; on success the provider redirects to the
   * loopback server, which delivers the code.
   */
  authorizeUrl: string;
  /**
   * The **manual authorize URL**: the same authorize request but with a
   * hosted redirect page (e.g. platform.claude.com/oauth/code/callback)
   * that displays a code to paste back. Shown to the user alongside the
   * browser attempt — on a headless box this is the only usable path.
   */
  manualUrl: string;
  /** Max paste attempts before falling back to callback-only. Default 2. */
  pasteAttempts?: number;
}

/** Reads the pasted code from `ask`, joining lines until an empty line —
 * long codes often arrive wrapped by the terminal. Empty result = nothing
 * was pasted. */
async function readPastedCode(io: AuthorizationIo, prompt: string): Promise<string> {
  const parts: string[] = [];
  while (true) {
    const line = (await io.ask(parts.length === 0 ? prompt : "")).trim();
    if (line === "") break;
    parts.push(line);
  }
  return parts.join("");
}

/** Cancel/timeout sentinel: no code was delivered. */
export const NO_CODE = "";

/**
 * The manual-paste race (headless-first, Claude Code's proven pattern):
 * show the manual URL *and* try `openUrl` on the automatic URL; whichever
 * path delivers a code first wins. `openUrl` failures are ignored — on a
 * headless box only the paste path remains, and it always works.
 *
 * Returns `NO_CODE` ("") when the callback is cancelled or times out;
 * the caller decides how to surface that.
 *
 * Note: implemented with an explicit first-settle race rather than
 * `Promise.race` on `callback.code` — Bun flags a raced promise's late
 * rejection as unhandled even when handlers are attached.
 */
export async function raceForCode(
  io: AuthorizationIo,
  opts: RaceOptions & { callback: CallbackServer },
): Promise<string> {
  await io.info(
    `Authorize in your browser:\n  ${opts.manualUrl}\n` +
      `If a code is shown instead of a redirect, paste it below.`,
  );
  if (io.openUrl) {
    try {
      await io.openUrl(opts.authorizeUrl);
    } catch {
      // Best-effort: headless boxes have no browser; the paste path covers them.
    }
  }
  const attempts = opts.pasteAttempts ?? 2;
  return new Promise<string>((resolve) => {
    let settled = false;
    const finish = (code: string): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    // Rejection here = cancel/timeout/provider error: settle with NO_CODE
    // so the caller can distinguish "nothing delivered" from a real code.
    opts.callback.code.then(finish, () => finish(NO_CODE));
    const tryPaste = (attempt: number): void => {
      readPastedCode(io, "Paste code here if prompted (empty line to finish): ").then((pasted) => {
        if (pasted !== "") {
          opts.callback.cancel();
          finish(pasted);
        } else if (attempt + 1 < attempts) {
          tryPaste(attempt + 1); // stray Enter: re-prompt (Google allows 2)
        }
        // Attempts exhausted: keep waiting for the callback branch above.
      });
    };
    tryPaste(0);
  });
}

/**
 * ToS warning shown and acknowledged before any subscription flow (spec
 * invariant 4): moh reuses the official CLI client_ids (fine for Google
 * installed-apps, gray for Anthropic/OpenAI), so the user must opt in.
 */
export const TOS_WARNING =
  "Subscription auth reuses the official CLI client_id of the provider. " +
  "This is explicitly allowed by Google, but sits in a gray area of the " +
  "Anthropic and OpenAI terms of service. Your access token follows the " +
  "same terms as the corresponding plan (Claude Pro/Max, ChatGPT Plus/Pro, " +
  "Google); abusing it may violate the provider's terms.";

/** Returns true only on an explicit `y`/`yes` acknowledgement. */
export async function confirmToSWarning(io: AuthorizationIo): Promise<boolean> {
  await io.info(TOS_WARNING);
  const answer = (await io.ask("Acknowledge and continue? (y/n): ")).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

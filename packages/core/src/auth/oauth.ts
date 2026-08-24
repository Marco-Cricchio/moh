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
  /** True once the HTTP callback delivered the code (vs. manual paste) —
   * the winning path decides the token exchange's `redirect_uri`
   * (Claude Code's `hasPendingResponse()` equivalent). */
  readonly deliveredViaCallback: boolean;
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
  let viaCallback = false;
  const deliveredViaCallback = () => viaCallback;

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
          viaCallback = true;
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
          get deliveredViaCallback() {
            return deliveredViaCallback();
          },
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

/** Narrated on every winning path before the token exchange starts. */
export const CODE_RECEIVED_MSG = "✓ Authorization code received — exchanging tokens…";

/** Reads pasted codes until one is non-empty or attempts run out. */
async function pasteForCode(io: AuthorizationIo, attempts: number): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pasted = await readPastedCode(io, "Paste code here: ");
    if (pasted !== "") {
      await io.info(CODE_RECEIVED_MSG);
      return pasted;
    } // stray Enter: re-prompt while attempts remain
  }
  return NO_CODE;
}

/**
 * The manual-paste race (issue #150): narrate every step and only show a
 * paste prompt when it is actually needed.
 *
 * - Browser path (`openUrl` succeeds): narrate "waiting…", no paste
 *   prompt at all — the loopback callback is the expected winner. If the
 *   callback fails (timeout/cancel/provider error), fall back to the
 *   manual URL + paste prompt before giving up.
 * - Headless path (`openUrl` absent/fails): show the manual URL and the
 *   paste prompt immediately; the callback is still raced (it can win on
 *   any redirect).
 *
 * Whichever path wins narrates `CODE_RECEIVED_MSG` so the pending prompt
 * visibly resolves and the user knows the exchange is running. Returns
 * `NO_CODE` ("") when nothing is delivered; the caller surfaces that.
 *
 * Note: implemented with an explicit first-settle race rather than
 * `Promise.race` on `callback.code` — Bun flags a raced promise's late
 * rejection as unhandled even when handlers are attached.
 */
export async function raceForCode(
  io: AuthorizationIo,
  opts: RaceOptions & { callback: CallbackServer },
): Promise<string> {
  const attempts = opts.pasteAttempts ?? 2;

  let browserOpened = false;
  if (io.openUrl) {
    await io.info("Opening your browser to authorize…");
    try {
      browserOpened = (await io.openUrl(opts.authorizeUrl)) !== false;
    } catch {
      browserOpened = false; // headless boxes have no browser
    }
  }

  if (browserOpened) {
    await io.info("Waiting for the browser to complete the authorization…");
    let code: string;
    try {
      code = await opts.callback.code;
    } catch {
      // Timeout/cancel/provider error: the browser path delivered nothing.
      code = NO_CODE;
    }
    if (code !== NO_CODE) {
      await io.info(CODE_RECEIVED_MSG);
      return code;
    }
    await io.info(
      `The browser did not deliver a code. Fallback — authorize manually:\n  ${opts.manualUrl}\n` +
        `If a code is shown instead of a redirect, paste it below.`,
    );
    return pasteForCode(io, attempts);
  }

  // Headless / manual path: manual URL + paste prompt, still racing the
  // callback (a redirect from any machine can win).
  await io.info(
    `No browser available — authorize on any machine via:\n  ${opts.manualUrl}\n` +
      `If a code is shown instead of a redirect, paste it below.`,
  );
  return new Promise<string>((resolve) => {
    let settled = false;
    const finish = (code: string): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    opts.callback.code.then(
      async (code) => {
        await io.info(CODE_RECEIVED_MSG);
        finish(code);
      },
      // Cancel/timeout/provider error: nothing more to wait for here —
      // the paste loop decides (its own exhaustion settles NO_CODE).
      () => {},
    );
    const tryPaste = (attempt: number): void => {
      readPastedCode(io, "Paste code here: ").then((pasted) => {
        if (settled) return; // callback already won; abandon the paste
        if (pasted !== "") {
          opts.callback.cancel();
          finish(pasted);
          void io.info(CODE_RECEIVED_MSG).catch(() => {}); // narration must not block
        } else if (attempt + 1 < attempts) {
          tryPaste(attempt + 1);
        } else {
          finish(NO_CODE); // attempts exhausted, callback still pending
        }
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

/**
 * Per-provider ToS posture (ADR-0010, #159): which client_id moh reuses
 * and how the provider treats it. The generic warning covers the three
 * original grants; the new providers get their own copy.
 */
export const TOS_WARNING_BY_PROVIDER: Record<string, string> = {
  "github-copilot":
    "GitHub Copilot subscription auth reuses the official VS Code Copilot " +
    "GitHub App client_id via the device flow. Your access follows your " +
    "Copilot plan terms; automating it outside the editor may violate " +
    "GitHub's terms of service.",
  openrouter:
    "OpenRouter sign-in uses OpenRouter's official OAuth app and produces " +
    "a persistent API key you control. Standard OpenRouter account terms apply.",
  "kimi-coding":
    "Kimi Code subscription auth uses Moonshot's published public client_id " +
    "for CLI device flows. Your access follows your Kimi subscription terms; " +
    "automating it may violate the provider's terms of service.",
  xai:
    "xAI subscription auth uses xAI's published public client_id for CLI " +
    "device flows (SuperGrok / X Premium). Your access follows your plan's " +
    "terms; automating it may violate xAI's terms of service.",
};

/** ToS warning for a provider kind: per-provider copy when one exists,
 * the generic warning otherwise. */
export function tosWarningFor(provider: string): string {
  return TOS_WARNING_BY_PROVIDER[provider] ?? TOS_WARNING;
}

/** Acknowledgement gate with per-provider copy (same y/yes rule). */
export async function confirmToSWarningFor(io: AuthorizationIo, provider: string): Promise<boolean> {
  await io.info(tosWarningFor(provider));
  const answer = (await io.ask("Acknowledge and continue? (y/n): ")).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

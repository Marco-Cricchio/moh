/** Shared test fakes for the extension `setup` tests (extracted for #945). */
import type {
  BeforeTurnHook,
  ExtensionSetupContext,
  ModelErrorHook,
  ToolCallHook,
} from "@moh/extension";

export interface FakeCtx {
  events: Array<{ name: string; payload?: unknown }>;
  statuses: (string | null)[];
  toolHooks: ToolCallHook[];
  beforeTurnHooks: BeforeTurnHook[];
  sessionStartHooks: Array<() => void>;
  eventHooks: Array<(e: { event: { type: string; [k: string]: unknown } }) => void>;
  compactionHooks: Array<(ctx: { sections: readonly { id: string }[]; hookTimeoutMs?: number; signal?: AbortSignal }) => unknown>;
  toolResultHooks: Array<(input: { callId: string; name: string; output: string }) => unknown>;
  /** apiVersion 1.10 (ADR-0059): the retry-on-model-error seam. */
  modelErrorHooks: ModelErrorHook[];
  mode: "normal" | "auto-accept" | "yolo";
  afterTurnHooks: Array<() => unknown>;
}

export function fakeCtx(mode: FakeCtx["mode"] = "normal"): ExtensionSetupContext & FakeCtx {
  const hooks: Record<string, unknown> = {
    state: {},
    appendToPrompt: () => {},
    setPromptNote: () => {},
    appendEvent: (event: { name: string; payload?: unknown }) => (hooks as unknown as FakeCtx).events.push(event),
    setStatus: (text: string | null) => (hooks as unknown as FakeCtx).statuses.push(text),
    onSessionStart: (h: () => void) => (hooks as unknown as FakeCtx).sessionStartHooks.push(h),
    onSessionEnd: () => {},
    beforeTurn: (h: BeforeTurnHook) => (hooks as unknown as FakeCtx).beforeTurnHooks.push(h),
    beforeModelCall: () => {},
    onToolCall: (h: ToolCallHook) => (hooks as unknown as FakeCtx).toolHooks.push(h),
    onCompaction: (h: (ctx: { sections: readonly { id: string }[]; hookTimeoutMs?: number; signal?: AbortSignal }) => unknown) => (hooks as unknown as FakeCtx).compactionHooks.push(h),
    onEvent: (h: (e: { event: { type: string; [k: string]: unknown } }) => void) => (hooks as unknown as FakeCtx).eventHooks.push(h),
    onToolResult: (_tools: readonly string[], h: (input: { callId: string; name: string; output: string }) => unknown) =>
      (hooks as unknown as FakeCtx).toolResultHooks.push(h),
    onModelError: (h: ModelErrorHook) => (hooks as unknown as FakeCtx).modelErrorHooks.push(h),
    afterTurn: (h: () => unknown) => (hooks as unknown as FakeCtx).afterTurnHooks.push(h),
  };
  const self = hooks as unknown as ExtensionSetupContext & FakeCtx;
  self.events = [];
  self.statuses = [];
  self.toolHooks = [];
  self.beforeTurnHooks = [];
  self.sessionStartHooks = [];
  self.eventHooks = [];
  self.compactionHooks = [];
  self.toolResultHooks = [];
  self.modelErrorHooks = [];
  self.mode = mode;
  self.afterTurnHooks = [];
  return self;
}

/** Drive one turn through every registered `beforeTurn` hook, merged. */
export async function runTurn(
  ctx: FakeCtx,
  text: string,
  turnIndex: number,
  model = "a/cheap",
): Promise<Record<string, unknown> | undefined> {
  let merged: Record<string, unknown> | undefined;
  for (const hook of ctx.beforeTurnHooks) {
    const out = await hook({ text, turnIndex, model });
    if (out) merged = { ...(merged ?? {}), ...out };
  }
  return merged;
}

/** Drive the `onModelError` seam through every registered hook, merged. */
export async function runModelError(
  ctx: FakeCtx,
  call: { model: string; errorKind: string; message?: string },
): Promise<{ model?: string } | undefined> {
  let merged: { model?: string } | undefined;
  for (const hook of ctx.modelErrorHooks) {
    const out = await hook({ model: call.model, errorKind: call.errorKind, ...(call.message !== undefined ? { message: call.message } : { message: "" }) });
    if (out && typeof out.model === "string") merged = { model: out.model };
  }
  return merged;
}

/** Emit one log event through every registered `onEvent` hook. */
export function emitEvent(ctx: FakeCtx, event: { type: string } & Record<string, unknown>): void {
  for (const hook of ctx.eventHooks) hook({ event });
}

export function routingJudgments(ctx: FakeCtx) {
  return ctx.events.filter((e) => e.name === "jev_judgment");
}

export function routingEvents(ctx: FakeCtx) {
  return ctx.events.filter((e) => e.name === "jev_routing");
}

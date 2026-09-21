/**
 * A/B simulation of the Jev routing + guardrail economics (spec §6/§8 routing,
 * §4 guardrail), replayed over real session logs of this project.
 *
 * A (baseline): no Jev — every turn on the pool's "potente" model (owner default).
 * B (jev on):   per-turn classifier (simulated with a heuristic tier judgment +
 *               confidence + hysteresis exactly as spec §6), guardrail overhead
 *               of ~500 input tokens per judged bash tool call (spec guardrail §4).
 *
 * Token counts per turn come from the real `model_call` events; tier-B re-prices
 * each turn at the tier model's blended price without inflating tokens (routing
 * saves money, not tokens) and adds the classifier + guardrail token overhead.
 *
 * Usage: bun scripts/jev-ab-sim.ts [session.jsonl ...]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.env.HOME!, ".moh", "projects", "github.com/marco-cricchio/moh");
const POOL: Record<string, { price: number }> = {
  // blended $/Mtok (input+output avg) — representative catalog prices
  "glm-5.3-flash": { price: 0.35 },
  "glm-5.3": { price: 0.9 },
  "gpt-5.6": { price: 8.0 },
};
const TIER_MODEL: Record<string, string> = {
  economico: "glm-5.3-flash",
  bilanciato: "glm-5.3",
  potente: "gpt-5.6",
};
const MIN_CONFIDENCE = 0.6;
const STREAK_TO_SWITCH = 2;
const CLASSIFIER_TOKENS = 500; // ~2KiB slice + rubric, one request per judged turn
const GUARDRAIL_TOKENS = 500;  // per judged bash tool call

function files(): string[] {
  const args = process.argv.slice(2);
  if (args.length) return args;
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(DIR, f));
}

/** Heuristic stand-in for the classifier: tier + confidence from message shape. */
function judge(text: string): { tier: string; confidence: number } {
  const t = text.toLowerCase();
  const hard = /(diagnos|architett|refactor|refactor|perch[ée]|bug|design|grill|spec|adiabatic|wayfinder|migration|ottimiz|analizz|perch)/;
  const easy = /^(ciao|ok|grazie|quanto|cos[’']?è|che cos|dimmi|lista|cat |grep|ls|git (log|status|diff)|read|mostra)/;
  if (hard.test(t)) return { tier: "potente", confidence: 0.85 };
  if (easy.test(t) && t.length < 120) return { tier: "economico", confidence: 0.85 };
  return { tier: "bilanciato", confidence: 0.7 };
}

function route(judgment: { tier: string; confidence: number }, activeTier: string, streak: { tier: string; n: number }, override: boolean): "switch" | "stay" {
  if (judgment.confidence < MIN_CONFIDENCE) return "stay";
  if (override) return "stay";
  if (activeTier === judgment.tier) return "stay";
  if (streak.tier !== judgment.tier) { streak.tier = judgment.tier; streak.n = 1; return "stay"; }
  streak.n += 1;
  if (streak.n < STREAK_TO_SWITCH) return "stay";
  return "switch";
}

for (const file of files()) {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  let events: any[] = [];
  try { events = lines.map((l) => JSON.parse(l)); } catch { continue; }

  // Group model_call usage by turn (a user_message starts a turn).
  const turns: { msgs: string; inTok: number; outTok: number; bashCalls: number; calls: number }[] = [];
  let cur: (typeof turns)[number] | null = null;
  for (const e of events) {
    if (e.type === "user_message") {
      const text = typeof e.message === "string" ? e.message : e.message?.text ?? "";
      cur = { msgs: text, inTok: 0, outTok: 0, bashCalls: 0, calls: 0 };
      turns.push(cur);
    } else if (e.type === "model_call" && cur) {
      cur.inTok += e.usage?.inputTokens ?? 0;
      cur.outTok += e.usage?.outputTokens ?? 0;
      cur.calls += 1;
    } else if (e.type === "tool_call" && cur && (e.tool === "bash" || e.name === "bash")) {
      cur.bashCalls += 1;
    }
  }
  if (!turns.length) continue;

  // Baseline A: all turns at the pool default (potente).
  const basePrice = POOL[TIER_MODEL.potente].price;

  // B: simulate router + guardrail.
  let active = "potente";
  const streak = { tier: "", n: 0 };
  let bTokens = 0, aTokens = 0, bCost = 0, aCost = 0, switches = 0, judged = 0;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const costOf = (model: string) =>
      (turn.inTok * POOL[model].price + turn.outTok * POOL[model].price * 3) / 1e6;
    aTokens += turn.inTok + turn.outTok;
    aCost += costOf(TIER_MODEL.potente);

    const j = judge(turn.msgs);
    const decision = i === 0 ? "stay" : route(j, active, streak, false);
    if (decision === "switch") { active = j.tier; switches++; streak.n = 0; }
    judged++;
    const served = TIER_MODEL[active];
    const extra = CLASSIFIER_TOKENS + turn.bashCalls * GUARDRAIL_TOKENS;
    bTokens += turn.inTok + turn.outTok + extra;
    bCost += costOf(served) + (extra * POOL[served].price) / 1e6;
  }

  const name = file.split("/").pop();
  console.log(`\n${name}: ${turns.length} turns, ${turns.reduce((s, t) => s + t.calls, 0)} model calls, ${turns.reduce((s, t) => s + t.bashCalls, 0)} bash calls`);
  console.log(`  A (no jev):     ${aTokens.toLocaleString()} tok · $${aCost.toFixed(4)}`);
  console.log(`  B (jev on):     ${bTokens.toLocaleString()} tok · $${bCost.toFixed(4)}  (${switches} switches, ${judged} judged turns)`);
  const tokDelta = ((bTokens - aTokens) / aTokens * 100).toFixed(2);
  const costDelta = ((bCost - aCost) / aCost * 100).toFixed(1);
  console.log(`  Δ tokens: ${tokDelta}%  Δ cost: ${costDelta}%`);
}

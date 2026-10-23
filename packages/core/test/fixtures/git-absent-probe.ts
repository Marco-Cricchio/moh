/**
 * #1427 characterization probe: run by `git-call-sites.test.ts` in a child
 * `bun` whose PATH holds no `git` (bash/make/sleep only). Changing
 * `process.env.PATH` in-process does not stop Bun from finding git, so the
 * "git absent" shape needs its own process. Prints one JSON object with the
 * outcome of every git call site; error texts are reduced to booleans
 * because they differ across Bun versions.
 *
 * argv: <work dir> — holds `repo/` and `repo2/` (git repos with a commit
 * and an origin with credentials) and `lane/` (a dir with a `.git`
 * directory), all prepared by the parent while git was still on its PATH.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools } from "../../src/builtin-tools";
import { DevelopmentLaneService } from "../../src/development-lane-service";
import { gitAnchor } from "../../src/handoff";
import { cloneHandoffRepo } from "../../src/handoff-reception";
import { canonicalRemoteSlug, prepareProjectIdentity, prepareProjectIdentityNow } from "../../src/project-identity";
import { retroSignature } from "../../src/retro";
import { applyRetroApplication } from "../../src/retro-apply";
import { prepareTrackerRemote, resolveTracker, resolveTrackerSync } from "../../src/tracker";
import type { ToolContext } from "../../src/types";

const work = process.argv[2]!;
const repo = join(work, "repo");
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const ctx = (cwd: string): ToolContext => ({ signal: new AbortController().signal, cwd, onProgress: () => {} });
const out: Record<string, unknown> = {};

// Rows 1–3: tracker.
out.resolveTracker = (await resolveTracker({ cwd: repo }))?.kind ?? null;
await prepareTrackerRemote(repo);
out.prepareThenSync = resolveTrackerSync({ cwd: repo })?.kind ?? null;
out.resolveTrackerSync = resolveTrackerSync({ cwd: join(work, "repo2") })?.kind ?? null;

// Rows 4–5: project identity (sync and async twins).
out.canonicalRemoteSlug = canonicalRemoteSlug(repo);
out.identityAsync = (await prepareProjectIdentity(repo, temp("moh-1427-h1-"))).slug;
out.identitySync = prepareProjectIdentityNow(repo, temp("moh-1427-h2-")).slug;

// Rows 6–8: handoff anchor.
out.gitAnchor = gitAnchor(repo);

// Row 9: retro-apply pre-commit target (gitDir has no try/catch today).
const root = temp("moh-1427-retro-");
writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", test: "bun test" } }));
try {
  const result = applyRetroApplication({
    finding: {
      category: "missing-guardrail",
      evidence: "package.json defines `lint` and `test` but no pre-commit hook runs them",
      confidence: 0.8,
      session: "s",
      signature: retroSignature("missing-guardrail", "pre-commit:unwired"),
      appendedAt: "2026-01-01T00:00:00.000Z",
    },
    projectRoot: root,
    confirm: true,
  });
  out.retroApply = { threw: false, ok: result.ok };
} catch {
  out.retroApply = { threw: true };
}

// Rows 10–11: the bash re-run guard needs a git snapshot; without git it never intercepts.
const tools = builtinTools({ rerunMinMs: 100 });
writeFileSync(join(repo, "Makefile"), "\ntest:\n\tsleep 0.2 && echo '(pass) one'\n");
await tools.bash!.execute({ command: "make test" }, ctx(repo));
const again = String(await tools.bash!.execute({ command: "make test" }, ctx(repo)));
out.bashRerunIntercepted = again.includes("not re-executed");

// Row 12: the git tool lets the spawn failure through (not an exit-code message).
try {
  await tools.git!.execute({ args: ["status"] }, ctx(repo));
  out.gitTool = { threw: false };
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  out.gitTool = { threw: true, exitCodeMessage: message.startsWith("git exited with code") };
}

// Row 13: cloneHandoffRepo degrades a spawn failure to a failed result.
const clone = await cloneHandoffRepo({ repoUrl: repo, dest: temp("moh-1427-clone-"), name: "c" });
out.clone = clone.ok ? { ok: true } : { ok: false, reason: clone.reason, messageNonEmpty: "message" in clone && (clone.message ?? "").length > 0 };

// Row 14: the lane runner resolves (code 127) instead of rejecting.
try {
  const service = new DevelopmentLaneService({ cwd: join(work, "lane"), home: temp("moh-1427-lane-home-") });
  const group = await service.ensureFeatureGroup("alpha", "main");
  const result = await service.createWorktreeLane({ featureGroupId: group.id, sessionId: "s1", branchRef: "feature/a-1", baseRef: "main" });
  out.lane = result.ok
    ? { rejected: false, ok: true }
    : { rejected: false, ok: false, kind: result.error.kind, prefixed: result.error.message.startsWith('cannot resolve base ref "main": ') };
} catch {
  out.lane = { rejected: true };
}

console.log(JSON.stringify(out));

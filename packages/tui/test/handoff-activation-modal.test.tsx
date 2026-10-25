import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMohConfig } from "@moh/core";
import { HandoffActivationModal } from "../src/HandoffActivationModal";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi, waitStep, waitText } from "./helpers";

const cwd = () => mkdtempSync(join(tmpdir(), "moh-handoff-choice-"));
const mount = (dir: string, props: Partial<Parameters<typeof HandoffActivationModal>[0]> = {}) => render(
  <ThemeProvider value={THEMES[DEFAULT_THEME]}>
    <HandoffActivationModal cwd={dir} onDone={() => {}} {...props} />
  </ThemeProvider>,
);

describe("handoff activation modal (#438)", () => {
  test("enables GitHub Gist only after a successful inline gh verification", async () => {
    const dir = cwd();
    let verified = 0;
    const i = mount(dir, { verifyGh: async () => { verified += 1; return { ok: true, user: "octo" }; } });
    await waitText(i, "same account on both machines", "modal rendered");
    i.stdin.write("\r");
    await waitStep(i, () => verified === 1 && loadMohConfig(join(dir, "moh.json")).handoff?.transport === "gist", "gist saved after verification");
    expect(verified).toBe(1);
    expect(loadMohConfig(join(dir, "moh.json")).handoff).toEqual({ transport: "gist" });
    i.unmount();
  });

  test("a missing gh leaves the project transport Not Set", async () => {
    const dir = cwd();
    const i = mount(dir, { verifyGh: async () => ({ ok: false, error: { reason: "gh-missing" } }) });
    await waitText(i, "same account on both machines", "modal rendered");
    i.stdin.write("\r");
    await waitText(i, "not installed", "gh-missing message");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("not installed");
    expect(loadMohConfig(join(dir, "moh.json")).handoff).toBeUndefined();
    i.unmount();
  });

  test("failed verification leaves the project transport Not Set", async () => {
    const dir = cwd();
    const i = mount(dir, { verifyGh: async () => ({ ok: false, error: { reason: "not-logged-in" } }) });
    await waitText(i, "same account on both machines", "modal rendered");
    i.stdin.write("\r");
    await waitText(i, "gh auth login", "not-logged-in message");
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("gh auth login");
    expect(loadMohConfig(join(dir, "moh.json")).handoff).toBeUndefined();
    i.unmount();
  });

  test("Settings can explicitly disable or reset the per-project transport without gh", async () => {
    const dir = cwd();
    let checks = 0;
    const i = mount(dir, { verifyGh: async () => { checks += 1; return { ok: true, user: "unused" }; } });
    await waitText(i, "› GitHub Gist", "modal rendered");
    i.stdin.write("\x1b[B");
    await waitText(i, "› Disabled", "cursor on Disabled");
    i.stdin.write("\r");
    await waitStep(i, () => loadMohConfig(join(dir, "moh.json")).handoff?.transport === "none", "transport saved as none");
    expect(loadMohConfig(join(dir, "moh.json")).handoff).toEqual({ transport: "none" });
    expect(checks).toBe(0);
    i.unmount();
  });

  test("Settings resets an explicit transport to Not Set without restarting onboarding", async () => {
    const dir = cwd();
    const i = mount(dir);
    await waitText(i, "› GitHub Gist", "modal rendered");
    i.stdin.write("\x1b[B");
    await waitText(i, "› Disabled", "cursor on Disabled");
    i.stdin.write("\x1b[B");
    await waitText(i, "› Not Set", "cursor on Not Set");
    i.stdin.write("\r");
    await waitStep(i, () => loadMohConfig(join(dir, "moh.json")).handoff?.onboarding === "reminded", "reset saved as reminded");
    expect(loadMohConfig(join(dir, "moh.json")).handoff).toEqual({ onboarding: "reminded" });
    i.unmount();
  });

  test("an explicit Settings choice clears a pending dismissal", async () => {
    const dir = cwd();
    const file = join(dir, "moh.json");
    writeFileSync(file, JSON.stringify({ handoff: { onboarding: "dismissed" } }));
    const i = mount(dir, { verifyGh: async () => ({ ok: true, user: "octo" }) });
    await waitText(i, "same account on both machines", "modal rendered");
    i.stdin.write("\r");
    await waitStep(i, () => loadMohConfig(file).handoff?.transport === "gist", "gist saved over the dismissal");
    expect(loadMohConfig(file).handoff).toEqual({ transport: "gist" });
    i.unmount();
  });

  test("startup dismissal persists one future reminder state", async () => {
    const dir = cwd();
    const i = mount(dir, { startup: true });
    await waitText(i, "same account on both machines", "modal rendered");
    i.stdin.write("n");
    await waitStep(i, () => loadMohConfig(join(dir, "moh.json")).handoff?.onboarding === "dismissed", "dismissal saved");
    expect(loadMohConfig(join(dir, "moh.json")).handoff).toEqual({ onboarding: "dismissed" });
    i.unmount();
  });
});

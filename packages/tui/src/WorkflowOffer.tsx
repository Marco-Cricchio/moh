import React from "react";
import { Text, useInput } from "ink";
import { useTheme } from "./themes";
import { Dialog, Dim } from "./ui";

/**
 * The first-run workflow offer (#36): shown once right after provider
 * onboarding. `y` enables workflow mode (first-party skills install
 * immediately); `n` leaves base behavior untouched. Never asked again —
 * `/workflow on|off` toggles later.
 */
export function WorkflowOffer({ onDone }: { onDone: (enable: boolean) => void }) {
  const theme = useTheme();
  useInput((input, key) => {
    if (input === "y" || key.return) return onDone(true);
    if (input === "n" || key.escape) return onDone(false);
  });
  return (
    <Dialog title=" workflow mode " color={theme.purple} width="62%">
      <Text>
        Enable <Text color={theme.accent}>workflow mode</Text>? Adds the first-party skills (plan, implement, review,
        diagnose, dream), their slash aliases, and the tracker frontier panel. You can toggle it any time with{" "}
        <Text color={theme.accent}>/workflow on|off</Text>.
      </Text>
      <Text> </Text>
      <Dim>y enable · n skip (base behavior unchanged)</Dim>
    </Dialog>
  );
}

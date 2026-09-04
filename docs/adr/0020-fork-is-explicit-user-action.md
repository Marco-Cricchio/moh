# Fork is always an explicit user action

The `session_file_growth` single-writer warning (#400) tells the user their session file is being written from elsewhere. We decided detect-and-fork is a **suggestion, never an automatic action**: clients (TUI/CLI/replay) project the suggested recovery, but the fork itself happens only when the user explicitly triggers it. Sessions are user data (ADR-0013 posture); a fork silently rebinding the writer's file, or an automatic fork on detection, would take an ownership decision away from the user. Recovery is a decision, not a reflex: the warning fires once per incident, and the user chooses between forking now (TUI banner action / `moh run --session <f> --fork` in the CLI), continuing on the contended file, or closing.

The core stays out of the suggestion business: `session_file_growth` keeps its shape, and each client renders its own hint (ADR-0004 public-surface criterion — the action is client surface, not core).

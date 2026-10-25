# ADR-0081: Bun `latest` everywhere

Status: accepted · Date: 2026-10-25
Related: ADR-0057 (decision 5, "the runtime is pinned" — superseded here), #1061, #1709

## Context

ADR-0057 pinned the CI test jobs to one exact Bun (`BUN_VERSION: "1.4.2"`)
so that "green on CI" and "green locally" would be the same claim. The pin
covered only `ci.yml`: `release.yml`, which compiles the shipped binary,
kept `bun-version: latest`, and so did the other workflows. The result was
the opposite of the goal. CI verified 1.4.2, v0.65.4 shipped on 1.4.4, and
local checkouts ran 1.2.19. Three runtimes, and the gate tested none of the
ones that matter to users.

The memory investigation in #1709 made the cost concrete: allocator and GC
behaviour differ measurably between 1.2.19 and 1.4.4 (same workload,
~40 MB/min against ~28 MB/min of footprint growth), so a claim measured on
one runtime does not carry to another.

## Decision

1. **Every workflow installs `bun-version: latest`.** `ci.yml` keeps its
   single `BUN_VERSION` knob, now set to `latest`, so CI tests the runtime
   the release builds on.
2. **Local checkouts follow `latest` too** (`bun upgrade`). A measurement
   or a "green locally" claim names the Bun version it ran on.
3. **A red that only a new Bun explains is fixed forward**, as a bug in our
   code or a reported upstream bug with a targeted workaround. It is not
   answered by re-pinning.

## Consequences

- CI and release can no longer disagree about the runtime, except for a
  Bun release landing between a PR's CI run and the tag. That window is
  accepted.
- The gate can turn red on a day nobody changed moh, which is the moving
  target #1061 described. That red is now information about the runtime
  users are about to receive, not noise to pin away.
- ADR-0057's decision 5 no longer holds for the runtime half. Its
  hermeticity half (`TZ=UTC`, injected clocks) is unchanged.

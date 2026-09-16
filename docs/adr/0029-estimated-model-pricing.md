# ADR-0029 — Release-pinned estimated model pricing

**Status:** Accepted (2026-09-16, #719)

## Context

Usage surfaces measure completed model-call input and output tokens from the
append-only event log. Users also need a useful approximate dollar estimate,
but prices are external data, can change, and are not available for every
model or endpoint.

## Decision

The existing vendored model catalogs are the sole pricing table. Their
per-model USD-per-million-token rates are projected into the core's pricing
seam and updated only when the catalog snapshot is regenerated for a release.
The catalog README records the source version; client surfaces identify the
snapshot version and label every amount as an estimate.

Cost estimation uses only measured input and output tokens. Cache-read/write,
requests, images, tools, taxes, discounts, subscription allowances, and other
provider billing dimensions are excluded. A pricing tier is selected per call
from that call's input-token count.

A model without a price record, whose id maps to conflicting catalog rates, or
whose catalog record is zero-only shows tokens only. Zero-only records are
conservatively treated as placeholders rather than evidence of a free rate. No live model-list endpoint updates prices, and event logs do
not persist a monetary value: re-projection intentionally uses the current
release-pinned snapshot.

## Consequences

The estimate is auditable and works offline, but can be stale between catalog
regenerations. The displayed snapshot version makes that staleness visible;
maintainers update it and the catalog README together during regeneration.

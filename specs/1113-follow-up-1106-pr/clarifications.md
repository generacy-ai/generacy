# Clarifications: Pin the PrSnapshot read-through path (follow-up to #1106)

## Batch 1 — 2026-08-19

### Q1: Casing divergence direction
**Context**: `webhook-to-event.ts:132` emits `ev.repo` in raw payload casing (only Set
membership at `refKey`/`repoKey` is lowercased), so the mutation is only detectable when the
write-side cache key and the read-side `ev.repo` differ in case. The spec's failure scenario
describes write=operator-mixed / read=GitHub-canonical, but lists both directions as "e.g.".
**Question**: Which casing-divergence direction should the new test exercise?
**Options**:
- A: One direction only — write mixed-case (`Painworth/Doc-Intel` via `snapshotKey`) + read canonical (`painworth/doc-intel` payload). Matches the field failure scenario.
- B: Both directions — add a second scenario with write-canonical / read-mixed as well.

**Answer**: *Pending*

### Q2: Test structure
**Context**: The existing `pr-checks with cached rollup` test is a `describe.each`
parameterization (lines ~360–393) that drives both write and read with lowercase `o/r`, so it
does not exercise casing drift. FR-001 says "add an integration-level test" and the Assumptions
say "add the new case-mismatch scenario".
**Question**: How should the new coverage be integrated relative to the existing lowercase tests?
**Options**:
- A: Add new dedicated `it` block(s); leave the existing lowercase tests unchanged.
- B: Extend the existing `describe.each` to include a mixed-case variant.
- C: Replace the existing lowercase `pr-checks` / `completed:validate` tests with mixed-case versions.

**Answer**: *Pending*

### Q3: Rollup coverage breadth
**Context**: FR-002 requires asserting the `checks` wire value for BOTH the `pr-checks` and
`completed:validate` `label-change` branches. The existing `pr-checks` test parameterizes over
rollups (`success`→green, `failure`→red, `none`→undefined); the existing `completed:validate`
test uses a single `success`→green case.
**Question**: How many rollup values should the new case-mismatch test(s) cover per branch?
**Options**:
- A: Single representative per branch (e.g. `success`→green for both) — minimal, still mutation-sensitive.
- B: Parameterize the mismatch test(s) over the full rollup matrix (`success`/`failure`/`none`), mirroring the existing `pr-checks` coverage.

**Answer**: *Pending*

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

**Answer**: B — Both directions: add a second scenario with write-canonical / read-mixed as well. Option A as written (write mixed via `snapshotKey`, read lowercase payload) cannot kill the target mutation because `snapshotKey` lowercases at write time (`watch/snapshot.ts:46-48`), so an inlined `` `${ev.repo}#pr#${ev.number}` `` at `smee-source.ts:375` still HITS when `ev.repo` is already lowercase — the mismatch only surfaces when the payload carries uppercase. Both directions are field-reachable: the write key comes from the operator-typed epic body (`poll-loop.ts:93`) and the read from GitHub-canonical `repository.owner.login`/`name` (`webhook-to-event.ts:132`); either may be the mixed-case one. Covering both keeps the pure `snapshotKey`-revert mutation killed while adding the read-mixed case that is the only one sensitive to the line-375 inline. If only one scenario were permitted it would have to be read-mixed, not option A's read-lowercase.

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

**Answer**: A — Add new dedicated `it` block(s); leave the existing lowercase tests unchanged. The existing block is an `it.each` (`smee-source.integration.test.ts:355-392`), not a `describe.each`, and it pins a different contract — the full `contracts/checks-mapping.md` rollup→wire table under homogeneous casing; folding a casing dimension into it would cross-multiply the matrix and blur which assertion pins which invariant. Option C actively loses coverage: the lowercase cases are the control that distinguishes "checks never stamped at all" from "checks not stamped under casing drift", and are the only thing pinning the `error`/`pending` mappings. The file already establishes the dedicated-`it` precedent for this concern at line 209 ("#1106 emits event when payload owner/repo casing differs from epic ref casing"), so a sibling `it` for the checks-stamping path reads consistently.

### Q3: Rollup coverage breadth
**Context**: FR-002 requires asserting the `checks` wire value for BOTH the `pr-checks` and
`completed:validate` `label-change` branches. The existing `pr-checks` test parameterizes over
rollups (`success`→green, `failure`→red, `none`→undefined); the existing `completed:validate`
test uses a single `success`→green case.
**Question**: How many rollup values should the new case-mismatch test(s) cover per branch?
**Options**:
- A: Single representative per branch (e.g. `success`→green for both) — minimal, still mutation-sensitive.
- B: Parameterize the mismatch test(s) over the full rollup matrix (`success`/`failure`/`none`), mirroring the existing `pr-checks` coverage.

**Answer**: A — Single representative per branch (`success`→green for both `pr-checks` and `completed:validate`) — minimal, still mutation-sensitive. The bug's symptom is `checks: undefined`, and the existing matrix already contains two rollups whose correct expectation is also `undefined` (`pending` and `none`) — those pass identically whether the lookup hits or misses, contributing zero mutation-sensitivity here. Only rollups that map to a defined wire value (`success`→green, `failure`/`error`→red) can distinguish fixed from broken, and one suffices because the mismatch test's job is the key-lookup path at `smee-source.ts:375`, not `mapChecks` (already pinned across the full table by the existing lowercase `it.each`).

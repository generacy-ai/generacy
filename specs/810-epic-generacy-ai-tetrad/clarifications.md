# Clarifications

## Batch 1 — 2026-07-06

### Q1: Reconcile with existing `.changeset/805-cockpit-delete-orchestrator-journal.md`
**Context**: FR-001 lists two changesets to delete (`792-cockpit-orchestrator-status.md`, `793-cockpit-journal-stuck-detection.md`) and FR-002 says to "add **one** new changeset recording the breaking removals" at `major` bump. But `.changeset/805-cockpit-delete-orchestrator-journal.md` already exists (added by PR #808) and already announces the same removals at `minor` bump. The spec doesn't mention this file — either it was overlooked, or FR-002 is meant to *supersede* it, or the two are meant to coexist. This determines the final changelog and whether the semver bump is `minor` or `major`.
**Question**: How should the new FR-002 changeset interact with the existing `805-cockpit-delete-orchestrator-journal.md`?
**Options**:
- A: Update the existing `805-*.md` in-place: bump `minor` → `major`, expand body to enumerate the full removal list (exports, config fields, watch events, `STALE` column). Do not add a second changeset.
- B: Delete the existing `805-*.md` and add a fresh one per FR-002 (net-new file, `major` bump, full enumeration).
- C: Leave `805-*.md` untouched at `minor` and add a *second* changeset (`major`) per FR-002. Both ship in the next release.
- D: Leave `805-*.md` as authoritative (already covers the removals) and treat FR-002 as satisfied — no new file, and downgrade the semver expectation to `minor`.

**Answer**: D, amended — keep `.changeset/805-cockpit-delete-orchestrator-journal.md` as authoritative and keep it MINOR. The package is 0.2.0; a `major` changeset would cut 1.0.0, which is not being declared. Pre-1.0 convention here ships breaking changes as minor (precedent: the #801/#802 scoping break went 0.1→0.2). Its enumeration is already good; append one line for the `STALE` status column and the stuck fields it omits. FR-001 stands unchanged — `792-*.md` and `793-*.md` are both still present (verified) and must be deleted.

### Q2: Status of FR-003 (README orchestrator sections)
**Context**: FR-003 requires removing the "Talk to a running orchestrator" section, the two-mode client bullet, `config.orchestrator` keys in examples, the `ORCHESTRATOR_URL` / `ORCHESTRATOR_API_TOKEN` env-table rows, and the "Degraded mode" section from `packages/cockpit/README.md`. Reading the current `README.md` on this branch, none of those sections are present — commit `c909706` (PR #809 for issue #806) already rewrote the README end-to-end and stripped them. The spec was authored assuming they still existed.
**Question**: How should implementation handle FR-003 given the current README state?
**Options**:
- A: Treat FR-003 as already satisfied by PR #809. Verify no orchestrator references remain (spot-grep for `orchestrator`, `ORCHESTRATOR_`, `Degraded mode`) and add no README edits in this PR.
- B: Re-audit the current README against SC-001 anyway; if any residual references exist (e.g. in prose), remove them. Otherwise no edits.
- C: Roll FR-003 into a broader "docs sweep" and open a follow-up issue if anything is missed. This PR does no README edits.

**Answer**: B — re-audit. Exactly one orchestrator reference remains in the current README (verified by grep); remove it if stale, keep it only if it legitimately describes the generacy orchestrator context. Then FR-003 is done with no further edits.

### Q3: Legacy-config fixture shape and assertion depth for FR-006
**Context**: FR-006 requires a legacy-config tolerance test that guards R4 (Zod strip mode). Two design choices are unspecified. (a) **Where in the config document do the removed keys sit?** The loader (`packages/cockpit/src/config/loader.ts`) reads only `doc['cockpit']` and passes that sub-block to `CockpitConfigSchema.parse()`. A user's stale keys could plausibly live under `cockpit.orchestrator` / `cockpit.stuckThresholdMinutes` (nested — hits the schema) or at top-level `orchestrator:` / `stuckThresholdMinutes:` (siblings of `cockpit:` — never reaches the schema, so strip vs strict is irrelevant). (b) **What does the test assert beyond "no throw"?** A pure "does not throw" test will fail under `.strict()` as intended, but does not lock in that the extra keys are actually *stripped* from the parsed output.
**Question**: Where does the fixture place the removed keys, and what does the test assert?
**Options**:
- A: Fixture nests both under `cockpit:` block. Test asserts (1) `loadCockpitConfig` resolves without throwing, (2) `parsed.orchestrator === undefined`, (3) `parsed.stuckThresholdMinutes === undefined`. Locks strip behavior explicitly; unambiguously breaks under `.strict()`.
- B: Fixture nests under `cockpit:` block. Test asserts only that `loadCockpitConfig` resolves without throwing and `warnings.length === 0`. Simpler; still breaks under `.strict()` because the parse throws.
- C: Two fixtures — one nested under `cockpit:`, one at top-level — each asserting no throw. Broadest coverage against both possible user configs.
- D: Fixture at top-level only (siblings of `cockpit:`). Test asserts loader doesn't throw. (Note: top-level keys never reach the schema, so this does *not* exercise strip mode.)

**Answer**: A — fixture nests the removed keys under the `cockpit:` block (the loader passes only `doc['cockpit']` to the schema, so nested placement is the only one that exercises strip mode — the option-D note is correct). The test asserts (1) no throw, (2) `parsed.orchestrator === undefined`, (3) `parsed.stuckThresholdMinutes === undefined`.

### Q4: Handling of FR-007/FR-008/FR-009 when #807 has not landed
**Context**: The Assumptions section states "PR #806 and PR #807 have landed (or will land before this PR) — this issue's test edits apply on top of their rewrites." As of this clarification, #806 has landed (PR #809, commit `c909706`) but issue #807 (G-S3, "collapse context verbs + unify gh wrapper and resolvers") is still in the clarify phase and has not merged. The target test files named in FR-007/FR-008/FR-009 (`shared.scoping.test.ts`, `state.test.ts`, `advance.test.ts`, `clarify-context.test.ts`, `queue.test.ts`, `status.render.test.ts`) do not exist in the current tree — they are expected outputs of #807. This blocks the "on top of" assumption.
**Question**: How should implementation proceed given #807 has not landed?
**Options**:
- A: Land this PR now with only FR-001 through FR-006 (changesets + docs + new legacy-config test). Drop FR-007/FR-008/FR-009 from scope; open a follow-up issue for the CLI test residue after #807 lands.
- B: Block this PR on #807 landing first. Ship the full scope in one PR after #807 merges.
- C: Land FR-001–FR-006 now. Add FR-007/FR-008/FR-009 as best-effort: for each named file, skip cleanly if the file does not exist; act only if it does.
- D: Rescope FR-007/FR-008/FR-009 to "grep-driven": run the SC-001 grep after landing FR-001–FR-006, and clean up whatever references still exist in the tree at that point, regardless of file name.

**Answer**: C, with a premise correction — the named CLI test files DO exist in the current tree (`state.test.ts`, `advance.test.ts`, `clarify-context.test.ts`, `queue.test.ts`, `status.render.test.ts` all present); only `shared.scoping.test.ts` is gone, deleted by #806 with the manifest scoping it tested, so FR-007 is moot. Proceed now with FR-001–FR-006 AND FR-009 (`status.render.test.ts` is not in #807's file ownership — no conflict). Skip only FR-008: those four test files are owned by in-flight #807, whose rewrite starts from the current tree and shouldn't carry the orchestrator mocks forward — verify at #807's implementation review instead of editing them here. No new follow-up issue.

### Q5: Assertion shape for FR-009 tombstone replacement
**Context**: FR-009 replaces `expect(parsed.orchestrator).toBeUndefined()` with "an assertion against the envelope's current keys." The exact assertion form is unspecified. The envelope's current keys are only knowable after #807 lands (and only from `status.render.test.ts`, which does not exist yet). Three plausible shapes exist, each with different maintenance behavior when the envelope evolves.
**Question**: What form should the replacement assertion take?
**Options**:
- A: Exact key-set equality: `expect(Object.keys(parsed).sort()).toEqual([...currentKeys.sort()])`. Locks the shape; fails loudly whenever a key is added or removed. Highest signal, highest maintenance.
- B: Positive assertion of one or two load-bearing keys the render depends on (e.g., `expect(parsed.workflow).toBeDefined()`, plus any others the render clearly needs). Lower maintenance; tolerates additive envelope changes.
- C: Snapshot the whole envelope (`toMatchSnapshot`) and delete the tombstone. Simplest; changes to envelope require snapshot updates.
- D: Skip FR-009 in this PR (P2). Leave the tombstone in place. Address once #807 has landed and the current envelope shape is observable.

**Answer**: B — positive assertions on the envelope's load-bearing keys (tolerant of additive change), decidable now from the current `status.render.test.ts` envelope. Do it in this PR per Q4.

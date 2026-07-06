# Feature Specification: Epic: generacy-ai/tetrad-development#85 | Phase: S4 | Tier: v1-simplification | Issue: G-S4

Residue from the PR #808 implementation review (G-S1, merged): the code deletion was complete (no dangling imports), but the sweep missed release metadata, docs, and test surface

**Branch**: `810-epic-generacy-ai-tetrad` | **Date**: 2026-07-06 | **Status**: Draft

## Summary

Epic: generacy-ai/tetrad-development#85 | Phase: S4 | Tier: v1-simplification | Issue: G-S4

Residue from the PR #808 implementation review (G-S1, merged): the code deletion was complete (no dangling imports), but the sweep missed release metadata, docs, and test surface.

1. Changesets (do before the next `changeset version` run): delete the stale pending .changeset/792-cockpit-orchestrator-status.md and .changeset/793-cockpit-journal-stuck-detection.md (they announce the exact features #808 deleted), and add one changeset recording the breaking removals (deleted exports createOrchestratorClient/StuckReason/JournalLivenessResult/ReadJournalLivenessOptions/appendChildIssue; removed config fields orchestrator.*/stuckThresholdMinutes; removed stuck/recovered watch events and the STALE status column).
2. packages/cockpit/README.md: delete the orchestrator-client documentation (the "Talk to a running orchestrator" section, the two-mode client bullet, config.orchestrator keys in examples, the ORCHESTRATOR_URL/ORCHESTRATOR_API_TOKEN env table rows, and the "Degraded mode" section).
3. packages/cockpit/package.json description: drop "and orchestrator client".
4. packages/cockpit/src/index.ts header comment: remove the references to deleted orchestrator/http and orchestrator/stub modules.
5. Add a legacy-config tolerance test: a fixture carrying the removed orchestrator:/stuckThresholdMinutes: keys must parse cleanly (guards the data-model R4 promise — Zod strip mode — against a future .strict()).
6. Test residue, skip any file already rewritten by #806/#807: shared.scoping.test.ts:9 typed literal still carries the deleted orchestrator field (TS2353 if tests are ever typechecked); orchestrator: {} in mocked configs in state/advance/clarify-context/queue tests; status.render.test.ts tombstone assertion expect(parsed.orchestrator).toBeUndefined() should assert the envelope's actual keys instead.

Owns (isolation): .changeset/** ; packages/cockpit/{README.md,package.json,src/index.ts,src/__tests__/**} ; listed CLI test files (post-#806/#807 versions)

Acceptance: no reference to the deleted subsystems outside git history and the plan doc; next release's changelog describes the removal, not the removed features; a legacy-key config parses in a test.

Depends on: G-S2, G-S3 (test files overlap their rewrites) (see the epic checklist for issue numbers)

---
Part of the Epic Cockpit. Plan: docs/epic-cockpit-plan.md in tetrad-development (S4 / G-S4). Source: PR #808 review findings.


## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

## Clarifications

### Batch 1 — 2026-07-06

- **Q1 (Changeset reconciliation)**: Keep `.changeset/805-cockpit-delete-orchestrator-journal.md` as the authoritative removal changeset at **MINOR** bump (pre-1.0 convention — package is 0.2.0; a `major` bump would cut 1.0.0, which is not being declared; precedent set by #801/#802 scoping break at 0.1→0.2). Append one line to `805-*.md` covering the `STALE` status column and the stuck fields it currently omits. Do **not** add a second changeset. FR-001 stands unchanged: `.changeset/792-cockpit-orchestrator-status.md` and `.changeset/793-cockpit-journal-stuck-detection.md` must still be deleted.
- **Q2 (README audit)**: Re-audit the current `packages/cockpit/README.md` — exactly one orchestrator reference remains (verified by grep). Remove it if stale; keep only if it legitimately describes the generacy orchestrator context. No other README edits.
- **Q3 (Legacy-config test)**: Fixture nests the removed `orchestrator:` and `stuckThresholdMinutes:` keys under the `cockpit:` block (only nested placement exercises strip mode — the loader passes only `doc['cockpit']` to the schema). Test asserts (1) no throw, (2) `parsed.orchestrator === undefined`, (3) `parsed.stuckThresholdMinutes === undefined`. Locks strip behavior explicitly; unambiguously breaks under `.strict()`.
- **Q4 (Test residue scope)**: CLI test files `state.test.ts`, `advance.test.ts`, `clarify-context.test.ts`, `queue.test.ts`, `status.render.test.ts` all exist in the current tree. Only `shared.scoping.test.ts` is gone (deleted by #806 with the manifest scoping it tested) — **FR-007 is moot**. Proceed with FR-001–FR-006 AND FR-009 (status.render.test.ts is not in #807's file ownership). **Skip FR-008** — the four state/advance/clarify-context/queue tests are owned by in-flight #807; verify orchestrator-mock removal at #807's implementation review rather than editing them here. No follow-up issue.
- **Q5 (FR-009 assertion shape)**: Replace `expect(parsed.orchestrator).toBeUndefined()` with positive assertions on the envelope's load-bearing keys (tolerant of additive envelope changes), decidable now from the current `status.render.test.ts` envelope. Do it in this PR per Q4.

---

*Generated by speckit*

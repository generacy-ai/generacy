# Feature Specification: G-S4 — Cockpit residue sweep after G-S1 deletion

**Branch**: `810-epic-generacy-ai-tetrad` | **Date**: 2026-07-06 | **Status**: Draft
**Epic**: `generacy-ai/tetrad-development#85` | **Phase**: S4 | **Tier**: v1-simplification | **Issue**: G-S4
**Source**: PR #808 review findings

## Summary

PR #808 (G-S1) deleted the cockpit's orchestrator-client and journal-stuck detection subsystems cleanly at the code level — no dangling imports were left behind. But the sweep missed the *surrounding* artifacts that describe or exercise those subsystems: release-metadata (changesets), user-facing docs (README, package description), a source-file header comment, and a residual pattern in tests that still names the removed config keys and exported symbols. This feature closes those gaps so the next release's changelog describes the removals rather than announcing features that no longer exist, and so nothing outside git history and the plan doc still references the deleted subsystems.

The scope is deliberately narrow and mechanical: delete, replace, or rewrite specific artifacts in `.changeset/`, `packages/cockpit/README.md`, `packages/cockpit/package.json`, `packages/cockpit/src/index.ts`, and a set of test files. One net-new test (legacy-config tolerance) guards the R4 promise (Zod strip mode) so a future tightening to `.strict()` cannot silently break users who still carry the removed keys.

## User Stories

### US1: Maintainer cutting the next cockpit release

**As a** cockpit maintainer preparing the next release,
**I want** the pending changesets and the generated changelog to describe what actually changed,
**So that** users read "these APIs and config keys were removed" instead of "these features were added" for functionality that no longer exists.

**Acceptance Criteria**:
- [ ] `.changeset/792-cockpit-orchestrator-status.md` is deleted.
- [ ] `.changeset/793-cockpit-journal-stuck-detection.md` is deleted.
- [ ] A new changeset entry records the breaking removals: exports `createOrchestratorClient`, `StuckReason`, `JournalLivenessResult`, `ReadJournalLivenessOptions`, `appendChildIssue`; config fields `orchestrator.*` and `stuckThresholdMinutes`; watch events `stuck` / `recovered`; the `STALE` status column.
- [ ] Running `changeset version` in a clean checkout produces a changelog that mentions the removals and does not mention the deleted features.

### US2: Developer reading the cockpit docs

**As a** developer evaluating or using `@generacy-ai/cockpit`,
**I want** the README, `package.json` description, and `src/index.ts` header to describe only what the package still does,
**So that** I do not try to configure or call APIs that no longer exist.

**Acceptance Criteria**:
- [ ] `packages/cockpit/README.md` no longer contains the "Talk to a running orchestrator" section, the two-mode client bullet, `config.orchestrator` keys in examples, the `ORCHESTRATOR_URL` / `ORCHESTRATOR_API_TOKEN` env-table rows, or the "Degraded mode" section.
- [ ] `packages/cockpit/package.json` `description` field no longer contains the phrase "and orchestrator client".
- [ ] `packages/cockpit/src/index.ts` header comment no longer references the deleted `orchestrator/http` or `orchestrator/stub` modules.

### US3: User upgrading with a legacy config file

**As a** cockpit user whose config file still carries the removed `orchestrator:` and `stuckThresholdMinutes:` keys,
**I want** my config to keep parsing without errors after upgrading,
**So that** the upgrade path is a no-op for me — I can remove the dead keys on my own schedule.

**Acceptance Criteria**:
- [ ] A test fixture containing the removed `orchestrator:` block and `stuckThresholdMinutes:` key parses without throwing.
- [ ] The test is written so it will fail if the schema is ever tightened from Zod strip mode to `.strict()`.

### US4: Contributor running the cockpit test suite

**As a** contributor running `pnpm test` or a future `tsc --noEmit` across cockpit tests,
**I want** the test files to reference only symbols and config keys that still exist,
**So that** the suite does not carry TS2353 errors (excess-property checks on typed literals) or assert against tombstones for keys that were never in the shape.

**Acceptance Criteria**:
- [ ] `shared.scoping.test.ts:9` typed-literal no longer carries the deleted `orchestrator` field.
- [ ] `orchestrator: {}` no longer appears in mocked configs in the state / advance / clarify-context / queue CLI tests.
- [ ] `status.render.test.ts` tombstone assertion `expect(parsed.orchestrator).toBeUndefined()` is replaced by an assertion against the envelope's actual current keys.
- [ ] Any file already rewritten by PR #806 or PR #807 is left untouched (this issue's edits apply on top of those PRs).

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                                                                    | Priority | Notes                                                                                             |
|--------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|---------------------------------------------------------------------------------------------------|
| FR-001 | Delete `.changeset/792-cockpit-orchestrator-status.md` and `.changeset/793-cockpit-journal-stuck-detection.md`.                                                                                                                                 | P1       | Must land before the next `changeset version` run to keep the changelog honest.                   |
| FR-002 | Add one new changeset recording the breaking removals from #808 (exports, config fields, watch events, and status column enumerated in the issue).                                                                                             | P1       | Semver bump: `major` (breaking removal of public API surface).                                    |
| FR-003 | Remove the orchestrator-client sections from `packages/cockpit/README.md`: the "Talk to a running orchestrator" section, the two-mode client bullet, `config.orchestrator` keys in examples, the two env-table rows, and the "Degraded mode" section. | P1       | README must remain internally consistent (no orphaned references or dangling links).              |
| FR-004 | Drop "and orchestrator client" from `packages/cockpit/package.json` `description`.                                                                                                                                                             | P1       | Keep the rest of the description intact.                                                          |
| FR-005 | Remove references to the deleted `orchestrator/http` and `orchestrator/stub` modules from the `packages/cockpit/src/index.ts` header comment.                                                                                                  | P1       | Header should describe only currently exported modules.                                           |
| FR-006 | Add a legacy-config tolerance test: a fixture carrying `orchestrator:` and `stuckThresholdMinutes:` keys must parse without error.                                                                                                             | P1       | Guards R4 (Zod strip mode) against a future `.strict()`. Test lives under `packages/cockpit/src/__tests__/**`. |
| FR-007 | Remove the deleted `orchestrator` field from the typed literal at `shared.scoping.test.ts:9`.                                                                                                                                                  | P1       | Skip if PR #806 or #807 already rewrote this file.                                                |
| FR-008 | Remove `orchestrator: {}` from mocked configs in the state / advance / clarify-context / queue CLI tests.                                                                                                                                       | P1       | Skip any file already rewritten by #806/#807.                                                     |
| FR-009 | Replace the `status.render.test.ts` tombstone assertion `expect(parsed.orchestrator).toBeUndefined()` with an assertion against the envelope's current keys.                                                                                    | P2       | The tombstone asserts absence of a key that was never in the shape; assert the real shape instead. |

## Success Criteria

| ID     | Metric                                                                                                                                                     | Target                             | Measurement                                                                                          |
|--------|------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------|------------------------------------------------------------------------------------------------------|
| SC-001 | References to deleted subsystems (`createOrchestratorClient`, `orchestrator.*` config, `stuckThresholdMinutes`, `STALE` column, `stuck`/`recovered` events) outside git history and the epic plan doc. | 0                                  | `grep` sweep across the working tree (excluding `.git/` and `docs/epic-cockpit-plan.md`) after the change. |
| SC-002 | Next release's changelog entry for `@generacy-ai/cockpit` describes the removals, not the removed features.                                                | Removal-only wording               | Run `changeset version` in a clean checkout and read the generated `CHANGELOG.md`.                    |
| SC-003 | Legacy-key config parses in a test.                                                                                                                        | Test passes                        | Run `pnpm --filter @generacy-ai/cockpit test` including the new fixture.                              |
| SC-004 | Cockpit test suite still passes after the sweep.                                                                                                           | 100% pass                          | `pnpm --filter @generacy-ai/cockpit test` exits 0.                                                    |
| SC-005 | No TS2353 excess-property errors on the touched test literals.                                                                                             | 0 errors                           | If the suite is ever typechecked, `tsc --noEmit` over the touched test files exits clean.             |

## Assumptions

- PR #806 and PR #807 have landed (or will land before this PR) — this issue's test edits apply on top of their rewrites, not before them.
- The `.changeset/` directory follows the standard Changesets format: one Markdown file per pending release entry with a YAML front-matter block naming the affected packages and bump level.
- The cockpit is under Zod strip mode today (R4 promise). The legacy-config tolerance test locks in that promise; it does not change it.
- The `orchestrator/http` and `orchestrator/stub` module deletions from PR #808 are already merged and are the only reason those header-comment references are dead.

## Out of Scope

- Any code change beyond docs, changesets, and test surface. All runtime code deletion happened in PR #808.
- Re-introducing any form of orchestrator client, journal-stuck detection, or `STALE` status. The epic decision to remove them stands.
- Broader test-file cleanup beyond the four specific residues named in the issue (`shared.scoping.test.ts`, the state/advance/clarify-context/queue mocks, `status.render.test.ts` tombstone).
- Tightening the config schema from Zod `strip` to `.strict()`. The new test locks in `strip`; changing it is a separate decision.
- Updates to `docs/epic-cockpit-plan.md` in the `tetrad-development` repo — the plan doc is the intentional exception to SC-001.

## Dependencies

- **G-S2**, **G-S3** — test-file overlap with their rewrites. Any file already touched by #806/#807 is skipped here (FR-007, FR-008 explicitly note this).

## Ownership / Isolation

Files this feature is allowed to change (per the issue's Owns clause):

- `.changeset/**`
- `packages/cockpit/README.md`
- `packages/cockpit/package.json`
- `packages/cockpit/src/index.ts`
- `packages/cockpit/src/__tests__/**`
- The listed CLI test files, post-#806/#807 versions only.

---

*Generated by speckit*

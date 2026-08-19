# Feature Specification: Cockpit doorbell — deliver gate answers when gateKey and epicRef differ only by owner/repo letter case

**Branch**: `1106-summary-answersfilesource-s` | **Date**: 2026-08-18 | **Status**: Draft
**Issue**: [generacy-ai/generacy#1106](https://github.com/generacy-ai/generacy/issues/1106) | **Workflow**: `speckit-bugfix`

## Summary

`AnswersFileSource`'s repo-scope filter (`packages/generacy/src/cli/commands/cockpit/doorbell/answers-file-source.ts:645-653`) compares `gateKey` owner/repo against the bound `epicRef` owner/repo with a raw case-sensitive `!==`. GitHub owner/repo names are case-insensitive, and the gate producers do not agree on casing:

| Gate family | Ref casing observed in live `answers.ndjson` |
|---|---|
| Epic-level (`phase-queue`, `scope-drained`) | epic ref **as typed** by the operator (e.g. `painworth/doc-intel#3`) |
| Child-issue gates in the cluster's **primary** repo | lowercase |
| Child-issue gates in a **secondary** (`repos.dev`) repo | GitHub **canonical** casing (e.g. `Painworth/doc-intel#23`) |

On a multi-repo cluster where the canonical owner casing differs from the typed/lowercase form, **every human gate answer for the epic's child issues is silently dropped** as "cross-epic" and the `/cockpit:auto` doorbell never fires. No single `epicRef` casing rescues both families: replaying a real 168-line `answers.ndjson`, binding `painworth/doc-intel#3` emits 4 / drops 164; binding `Painworth/doc-intel#3` emits 81 / drops 87 (all `phase-queue` gates lost).

This is **not** the documented cross-repo limitation on `AnswersFileSourceOptions.epicRef` — in the observed failure the child issues live in the **same repo as the epic**; only the letter case differs. `epicScope` comes from `parseEpicRef(options.epicRef)` verbatim, and no case normalization exists anywhere in the doorbell or cockpit CLI path.

## User Stories

### US1: Case-divergent same-repo answers are delivered (Primary)

**As a** `/cockpit:auto` operator on a multi-repo cluster,
**I want** gate answers whose `gateKey` differs from my bound `epicRef` only by owner/repo letter case to be delivered to the doorbell,
**So that** the auto session wakes on my inbox answers instead of requiring me to relay them by hand.

**Acceptance Criteria**:
- [ ] An answer keyed `Painworth/x#1:...` is emitted when the doorbell is bound to epic `painworth/x#1`.
- [ ] An answer keyed `painworth/x#1:...` is emitted when the doorbell is bound to epic `Painworth/x#1` (both directions).
- [ ] Behavior does not depend on which producer (epic-level, primary-repo, secondary-repo) wrote the `gateKey`.

### US2: Genuine foreign-repo answers keep today's disposition

**As a** `/cockpit:auto` operator running multiple epics on one cluster (shared `answers.ndjson`),
**I want** answers for genuinely different repos to remain filtered (or, if the filter is removed, to be harmlessly ignored by downstream `gateId` matching),
**So that** the case-insensitivity fix does not introduce cross-epic wake-up noise or misdelivery.

**Acceptance Criteria**:
- [ ] An answer keyed to a different owner/repo (beyond casing) is still dropped with today's dropped-and-logged disposition (clarification Q1=C: the repo-scope filter is retained; filter removal is a tracked follow-up, not part of this fix).

### US3: Regression protection

**As a** maintainer,
**I want** a regression test replaying the observed casing divergence through the actual filter function,
**So that** a future refactor cannot silently reintroduce the case-sensitive comparison.

**Acceptance Criteria**:
- [ ] Test covers `Painworth/x#1` answer vs `painworth/x#1` binding and the inverse.
- [ ] Test covers a genuine foreign-repo answer retaining its intended disposition.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The repo-scope filter in `AnswersFileSource` MUST treat owner and repo comparisons as case-insensitive (GitHub semantics). | P1 | Suggested: compare `.toLowerCase()` on both sides at `answers-file-source.ts:645-653`. |
| FR-002 | A gate answer whose `gateKey` differs from the bound `epicRef` only by owner/repo letter case MUST be delivered (not dropped as cross-epic). | P1 | Direct restatement of the acceptance bullet in #1106. |
| FR-003 | Answers for genuinely different repos MUST remain filtered (dropped-and-logged, today's disposition). The repo-scope filter is retained. | P1 | Resolved by clarification Q1=C: minimal fix ships now; filter removal / cross-repo `epicRef` support is filed as a separate follow-up issue, not bundled into this bugfix. |
| FR-004 | Regression tests MUST cover both case-divergence directions and the foreign-repo case. | P1 | See US3. |
| FR-005 | The issue-number portion of the scope comparison MUST be unaffected — only owner/repo comparison semantics change. | P2 | |
| FR-006 | Producer-side casing normalization (making `gateKey` casing stable at write time) is NOT required for this fix; the consumer-side filter MUST NOT depend on producer casing agreement. | P2 | Issue notes producer normalization as "separately worth" doing — out of scope here. |
| FR-007 | `/plan` MUST audit the doorbell/cockpit consumer path for other case-sensitive owner/repo string comparisons; any additional sites found MUST be fixed in this same PR with matching regression tests. | P1 | Resolved by clarification Q2=B. Audit is bounded to owner/repo string comparisons in the doorbell + cockpit consumer path so the PR stays reviewable. Baseline evidence: grep for `toLowerCase` across `dist/cli/commands/cockpit/` shows only three unrelated hits. |
| FR-008 | A follow-up issue MUST be filed for the repo-scope filter removal / cross-repo `epicRef` support option. | P2 | Second half of clarification Q1=C. Filing the issue is part of this work; implementing it is not. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Replay of the observed multi-repo `answers.ndjson` pattern (mixed-case same-repo gateKeys) against a lowercase `epicRef` binding | 0 same-repo answers dropped for casing reasons | Unit test replaying representative fixture lines through the filter |
| SC-002 | Case-divergence regression tests (both directions) | Pass; fail if `!==` comparison is restored | Vitest suite for `answers-file-source` |
| SC-003 | Genuine foreign-repo answer disposition | Unchanged from today (dropped), or documented-safe over-delivery if filter removed | Same suite |
| SC-004 | No behavior change for single-repo (uniformly lowercase) clusters | Existing `answers-file-source` tests pass unmodified | Existing suite |

## Assumptions

1. GitHub owner and repo names are case-insensitive; two refs differing only in case always denote the same repo. Case-insensitive comparison is therefore correct regardless of which producer's casing is "right".
2. ~~The minimal fix and the broader fix are both admissible; which to ship is a `/plan`-time decision.~~ **Resolved by clarification Q1=C**: ship the minimal case-insensitive compare; the repo-scope filter stays. Filter removal (which would incidentally resolve the documented cross-repo `epicRef` limitation) is tracked in a separate follow-up issue (FR-008). Measured cost that motivated the split: the finetooth cluster's single `answers.ndjson` carries gates from at least four distinct epics, so foreign-epic no-op wake-ups under filter removal are real, not hypothetical.
3. The bug is consumer-side only. `cockpit-answers-writer` and doorbell code are byte-identical across `stable` and `preview` channels, so no channel/version interplay is in scope.
4. Primary fix location is `packages/generacy/src/cli/commands/cockpit/doorbell/answers-file-source.ts` (non-test file under `packages/generacy/src/`) — a changeset for `@generacy-ai/generacy` is required (patch: defect fix per `workflow:speckit-bugfix`). Per clarification Q2=B (FR-007), the `/plan` audit may add further comparison sites in the doorbell/cockpit consumer path to this same PR.

## Out of Scope

- Normalizing producer-side `gateKey` casing (epic-level gate emitters, primary/secondary repo gate producers).
- The pre-existing, documented cross-repo `epicRef` limitation — per clarification Q1=C it stays out of scope; a follow-up issue for filter removal / cross-repo support is filed instead (FR-008).
- Repairing already-dropped answers on live clusters (operators re-answer or relay manually; no replay/migration tooling).
- Any change to the answers-file wire format, `gateId` derivation, or the `cluster.cockpit` channel.

---

*Generated by speckit*

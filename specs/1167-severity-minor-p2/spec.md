# Feature Specification: Reconcile review/remediate docs with shipped behavior

**Branch**: `1167-severity-minor-p2` | **Date**: 2026-08-21 | **Status**: Draft

## Summary

**Severity: minor (P2) — documentation + cosmetic sync.** The #1136 closeout docs
for the engine-native review/remediate epic (generacy-ai/generacy#1120) describe
*planned* behavior in several places where the epic shipped something narrower.
Three of the four major doc gaps trace verbatim to plan text never reconciled
against the merged code. This issue is the pure-reconciliation remainder of the
post-merge doc audit — the *functional* gaps it surfaced are tracked separately
(#1160 config keys, #1161 blockingSeverity default) and are **out of scope here**.

Concretely, this change corrects four documentation inaccuracies, the remaining
stale code comment(s), and four cosmetic-union omissions so that published docs,
in-repo comments, and enumerations match what the code actually does. No runtime
behavior changes.

**Baseline (clarified)**: this branch was cut from `ea0b2437` (= #1161), which is
newer than the spec's originally cited `155b3464`. #1156/#1160/#1161 have since
merged and already resolved several FR premises. Per Q1, the audit is re-anchored
to current branch HEAD: FRs whose cited inaccuracy is already gone are
verify-and-skip no-ops (FR-005, FR-007, FR-011 — see per-FR notes), and only what
remains inaccurate is changed. The source of truth is the cited *symbol*, not the
line number.

## User Stories

### US1: Operator reading the migration guide trusts it (Primary)

**As a** cluster operator configuring review/remediate,
**I want** the migration guide and profile reference to describe only behavior the
engine actually implements,
**So that** I don't mis-configure a cluster based on over-generalized precedence
rules, a misquoted default command, or a feature (auto-narrowing) that only
applies to one workflow.

**Acceptance Criteria**:
- [ ] The diff-classification / auto-narrowing section is explicitly scoped to
  `speckit-bugfix` (matches `phase-loop.ts:690`), not presented as general engine
  behavior.
- [ ] Config-key precedence is described accurately: the repo tier exists **only**
  for `validateCommand` / `preValidateCommand`; `maxRemediations` and `review.*`
  resolve workflow → built-in default with no repo tier
  (`worker/config.ts:57-61`).
- [ ] The documented default validate command reads `pnpm test && pnpm build`
  (matches `DEFAULT_VALIDATE_COMMAND`, `worker/config.ts:38`), not
  `pnpm build && pnpm test`.
- [ ] `blocked:stuck-feedback-loop` is not described as "retired" — it is live on
  the default flag-OFF path (`pr-feedback-handler.ts:45,617-624`).

### US2: Engineer reading source comments is not misled

**As a** developer navigating the orchestrator worker,
**I want** in-code comments to reflect the current wiring,
**So that** I don't reason about the phase loop / reader wiring from stale claims.

**Acceptance Criteria**:
- [ ] (FR-005, resolved at HEAD) `claude-cli-worker.ts` no longer claims "#1124
  will supply the reader" — verify-and-skip; the reader was wired in #1156 and the
  text is already gone. Note resolved in the PR.
- [ ] (FR-006, verify-and-fix) `phase-loop.ts` correctly scopes deadness to the
  *undefined default* of `remediateTrigger`, but any residual future-tense wording
  ("concrete triggers land in later epic issues"; "dead in production") is
  corrected — a concrete `remediateTrigger` did land (`claude-cli-worker.ts`).
- [ ] (FR-007, resolved at HEAD) `worker/config.ts` `ciWaitTimeoutMs` comment
  already documents the per-workflow override precedence accurately (#1160) —
  verify-and-skip. Note resolved in the PR.

### US3: Cockpit / workflow enumerations include the new gates

**As a** developer relying on gate-ordering enumerations,
**I want** the new review/remediate gate labels present in the ordering lists and
type unions,
**So that** ordering is deterministic (not falling back to the default) and the
type surface is complete.

**Acceptance Criteria**:
- [ ] `waiting-for:remediation-limit` and `waiting-for:ci` appear in cockpit
  `WAITING_PIPELINE_ORDER` (`precedence.ts:26`), positioned per Q2:
  `remediation-limit` immediately after `waiting-for:implementation-review`, and
  `ci` at the very end (after `waiting-for:manual-validation`).
- [ ] `completed:validate` / `completed:review` / `completed:remediate` appear in
  `STAGE_COMPLETE_PIPELINE_ORDER` (`precedence.ts:71`), positioned per Q3:
  `completed:validate` at index 0, then `completed:implementation-review`,
  `completed:remediate`, `completed:review`, `completed:implement`, …
- [ ] The workflow-engine `ReviewGate` union (`github.ts:256`) includes the two
  new gates.
- [ ] (FR-011, resolved at HEAD) The seed-aware executor already stamps seeded
  findings consistently with the artifact round (single `round` source,
  `seed-aware-review-executor.ts`) — verify-and-skip; there is no `round: 0`
  literal (unified by #1161). Note resolved in the PR.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Scope the auto-narrowing / diff-classification section of `review-remediate-migration.md:50-71` to `speckit-bugfix` only | P1 | Behavior lives at `phase-loop.ts:690`; feature workflow does not narrow |
| FR-002 | Correct config-key precedence prose in `review-remediate-migration.md:76-78` and `bugfix-profile-config.md:69-70` | P1 | Repo tier only for `validateCommand`/`preValidateCommand`; `maxRemediations`/`review.*` are workflow → built-in |
| FR-003 | Fix the default validate command quote to `pnpm test && pnpm build` in `review-remediate-migration.md:52-53` | P1 | Source of truth `worker/config.ts:38` |
| FR-004 | Remove "retired" characterization of `blocked:stuck-feedback-loop` in `review-remediate-migration.md:140-142`; reword per Q5 (legacy flag-OFF bounded stop still active when review is disabled; `waiting-for:remediation-limit` framed as the resumable flag-ON equivalent) | P1 | Label is live on default flag-OFF path |
| FR-005 | **Resolved at HEAD (Q1) — verify-and-skip.** "#1124 will supply the reader" comment no longer exists (reader wired in #1156) | P2 | Note resolved in PR |
| FR-006 | **Verify-and-fix (Q1).** `phase-loop.ts` scopes deadness to the undefined default correctly; fix residual future-tense wording ("concrete triggers land in later epic issues"/"dead in production") — a concrete `remediateTrigger` landed | P2 | `remediateTrigger` is live via `claude-cli-worker.ts` |
| FR-007 | **Resolved at HEAD (Q1) — verify-and-skip.** `ciWaitTimeoutMs` comment already documents per-workflow override accurately (#1160) | P2 | Note resolved in PR |
| FR-008 | Add `waiting-for:remediation-limit` (immediately after `waiting-for:implementation-review`) and `waiting-for:ci` (at the very end) to `WAITING_PIPELINE_ORDER` per Q2 | P2 | Deterministic ordering vs default fallback |
| FR-009 | Add `completed:validate` (index 0), `completed:remediate`, `completed:review` to `STAGE_COMPLETE_PIPELINE_ORDER` per Q3 ordering (validate, implementation-review, remediate, review, implement, …) | P2 | Same |
| FR-010 | Extend the `ReviewGate` union with the two new gates (`github.ts:256`) | P2 | Type completeness |
| FR-011 | **Resolved at HEAD (Q4) — verify-and-skip.** Single `round` source already stamps findings + artifact identically; no `round: 0` literal (unified by #1161) | P2 | Note resolved in PR |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Doc/code agreement on the four migration-doc claims | 100% | Each corrected passage matches the cited source line at the current develop SHA |
| SC-002 | Stale comments corrected | 1 fixed + 2 verified-resolved | FR-006 residual wording fixed; FR-005/FR-007 confirmed already resolved at HEAD (grep confirms the misleading phrases are gone) |
| SC-003 | Enumerations complete | 3/3 + 1 verified | New gate/completed labels present in both ordering lists + `ReviewGate` union; FR-011 seeded-round confirmed already unified at HEAD |
| SC-004 | No runtime behavior change | 0 behavior diffs | Existing tests pass unchanged; changes are docs/comments/enumeration-ordering only |

## Assumptions

- The functional gaps (#1160, #1161) are handled in their own issues; this issue
  does not change config resolution, defaults, or executor logic beyond the
  cosmetic seeded-round alignment.
- The cockpit ordering lists are ordering-only fallbacks today; adding the labels
  makes ordering deterministic but does not change gate semantics.
- Line references were originally anchored at develop `155b3464`; the audit is
  re-anchored to current branch HEAD (`ea0b2437`, per Q1). The source of truth is
  the cited symbol, not the line number.
- FR-005, FR-007, and FR-011 are already resolved by the #1156/#1160/#1161 merges;
  they are handled as verify-and-skip no-ops and noted resolved in the PR rather
  than forced as literal edits.

## Out of Scope

- Config-key functional wiring (#1160).
- `blockingSeverity` default change (#1161).
- Any change to review/remediate runtime behavior, gate evaluation, or phase-loop
  control flow.
- Rewriting the docs beyond the four cited inaccuracies.

---

*Generated by speckit*

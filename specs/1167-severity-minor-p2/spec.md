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

Concretely, this change corrects four documentation inaccuracies, three stale
code comments, and four cosmetic-union omissions so that published docs, in-repo
comments, and enumerations match what the code actually does at develop `155b3464`.
No runtime behavior changes.

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
- [ ] `claude-cli-worker.ts:743` no longer claims "#1124 will supply the reader"
  (the reader was wired in #1156).
- [ ] `phase-loop.ts:146-152` no longer claims `remediateTrigger` is "dead in
  production" — it is live.
- [ ] `worker/config.ts:155` no longer labels `ciWaitTimeoutMs`
  "per-workflow-overridable" in a way that contradicts its actual resolution.

### US3: Cockpit / workflow enumerations include the new gates

**As a** developer relying on gate-ordering enumerations,
**I want** the new review/remediate gate labels present in the ordering lists and
type unions,
**So that** ordering is deterministic (not falling back to the default) and the
type surface is complete.

**Acceptance Criteria**:
- [ ] `waiting-for:remediation-limit` and `waiting-for:ci` appear in cockpit
  `WAITING_PIPELINE_ORDER` (`precedence.ts:26`).
- [ ] `completed:validate` / `completed:review` / `completed:remediate` appear in
  `STAGE_COMPLETE_PIPELINE_ORDER` (`precedence.ts:71`).
- [ ] The workflow-engine `ReviewGate` union (`github.ts:256`) includes the two
  new gates.
- [ ] The seed-aware executor stamps seeded findings consistently with the
  artifact round (resolve the `round: 0` vs `round: 1` mismatch,
  `seed-aware-review-executor.ts:76`).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Scope the auto-narrowing / diff-classification section of `review-remediate-migration.md:50-71` to `speckit-bugfix` only | P1 | Behavior lives at `phase-loop.ts:690`; feature workflow does not narrow |
| FR-002 | Correct config-key precedence prose in `review-remediate-migration.md:76-78` and `bugfix-profile-config.md:69-70` | P1 | Repo tier only for `validateCommand`/`preValidateCommand`; `maxRemediations`/`review.*` are workflow → built-in |
| FR-003 | Fix the default validate command quote to `pnpm test && pnpm build` in `review-remediate-migration.md:52-53` | P1 | Source of truth `worker/config.ts:38` |
| FR-004 | Remove "retired" characterization of `blocked:stuck-feedback-loop` in `review-remediate-migration.md:140-142` | P1 | Label is live on default flag-OFF path |
| FR-005 | Update stale comment at `claude-cli-worker.ts:743` | P2 | Reader wired in #1156 |
| FR-006 | Update stale comment at `phase-loop.ts:146-152` | P2 | `remediateTrigger` is live |
| FR-007 | Update stale comment at `worker/config.ts:155` | P2 | `ciWaitTimeoutMs` labeling |
| FR-008 | Add `waiting-for:remediation-limit` and `waiting-for:ci` to `WAITING_PIPELINE_ORDER` | P2 | Deterministic ordering vs default fallback |
| FR-009 | Add `completed:validate`/`completed:review`/`completed:remediate` to `STAGE_COMPLETE_PIPELINE_ORDER` | P2 | Same |
| FR-010 | Extend the `ReviewGate` union with the two new gates (`github.ts:256`) | P2 | Type completeness |
| FR-011 | Align seeded-finding round stamping in `seed-aware-review-executor.ts:76` with artifact round | P2 | `round: 0` vs `round: 1` mismatch |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Doc/code agreement on the four migration-doc claims | 100% | Each corrected passage matches the cited source line at the current develop SHA |
| SC-002 | Stale comments removed | 3/3 | grep confirms the three misleading phrases are gone |
| SC-003 | Enumerations complete | 4/4 | New gate/completed labels present in both ordering lists + `ReviewGate` union; seeded-round mismatch resolved |
| SC-004 | No runtime behavior change | 0 behavior diffs | Existing tests pass unchanged; changes are docs/comments/enumeration-ordering only |

## Assumptions

- The functional gaps (#1160, #1161) are handled in their own issues; this issue
  does not change config resolution, defaults, or executor logic beyond the
  cosmetic seeded-round alignment.
- The cockpit ordering lists are ordering-only fallbacks today; adding the labels
  makes ordering deterministic but does not change gate semantics.
- Line references are anchored at develop `155b3464` and may drift; the source of
  truth is the cited symbol, not the line number.

## Out of Scope

- Config-key functional wiring (#1160).
- `blockingSeverity` default change (#1161).
- Any change to review/remediate runtime behavior, gate evaluation, or phase-loop
  control flow.
- Rewriting the docs beyond the four cited inaccuracies.

---

*Generated by speckit*

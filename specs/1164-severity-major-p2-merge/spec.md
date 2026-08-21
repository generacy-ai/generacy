# Feature Specification: Merge-conflict scoped-review lifecycle fixes

**Branch**: `1164-severity-major-p2-merge` | **Date**: 2026-08-21 | **Status**: Draft

## Summary

**Severity: major (P2).** The merge-conflict → scoped-review path (introduced with the
engine-native review/remediate epic, generacy-ai/generacy#1120) has four related defects
that either burn the remediation budget on an already-fixed defect, review far more code
than the resolution touched, raise spurious findings on valid small resolutions, or skip
the `validate` phase entirely on a specific flag combination. This is part of follow-up
epic generacy-ai/generacy#1153. All original line refs are at develop `155b3464`.

The four defects:

1. **Stale `reviewScope` burns the loop to the cap.** The review executor scopes every
   review to `context.reviewScope` (fixed SHAs supplied by the merge-conflict handler) and
   nothing ever clears it. A resolution-scoped review that returns `changes-required` →
   remediate pushes fix commits → the re-entered review is *still* scoped to the original
   pre-remediation window, whose charter says "Ignore files and changes outside this
   range." The fix commits are invisible to the reviewer, the same findings re-report every
   round, and the loop burns to the remediation cap **with the defect actually fixed**.

2. **"Resolution diff" includes the entire upstream base delta.** The scope's `baseSha` is
   `HEAD^1` (the pre-merge branch tip) and `headSha` is the merge commit — the parent-1
   diff. That diff contains *all* base-branch changes merged in, not just the conflict
   resolution. After a long-lived branch catches up to `develop`, the "scoped" review
   dwarfs the PR and invites findings on unrelated upstream code.

3. **Trivial-diff charter rule flags valid resolutions.** The charter's "empty or trivial
   diff → blocking finding" instruction penalizes small changes. A small but valid conflict
   resolution triggers a spurious `changes-required` → remediate loop over nothing.

4. **Flag-combo validate bypass.** With `ciMergeGateEnabled=true` and
   `reviewPhaseEnabled=false`, a post-approval conflict resolution re-arms `continue`;
   flag-OFF ignores `metadata.startPhase`, the resolver returns `validate`, and the #1133
   terminal short-circuit sees both `completed:validate` and `completed:implementation-review`
   labels → `completed: true` + mark-ready **without `validate` ever running on the
   post-merge tree**. External CI is the only backstop. A secondary crash window exists:
   `applySuccessDisposition` clears ownership labels before the re-arm item is enqueued, so
   a crash in that window silently stalls the issue.

## User Stories

### US1: Remediation converges after a scoped review (Defect 1)

**As a** cluster operator relying on the engine to resolve merge conflicts,
**I want** a resolution-scoped review to re-review the remediation commits (not the stale
original window),
**So that** a genuinely-fixed defect is recognized as fixed and the loop converges instead
of burning to the remediation cap and pausing on a resolved issue.

**Acceptance Criteria**:
- [ ] After the first scoped review round produces `changes-required`, the subsequent
      re-review round's window includes the remediation commits that were pushed in
      response.
- [ ] A defect that is actually fixed by remediation is reported `clean` on the next round
      and the loop advances past `review`.
- [ ] The review loop no longer exhausts the remediation cap when the underlying defect was
      addressed.

### US2: Scoped review sees only the resolution (Defect 2)

**As a** cluster operator merging a long-lived branch that has caught up to the base,
**I want** the scoped review window to contain only the conflict-resolution changes,
**So that** the reviewer does not raise findings on unrelated upstream code merged in from
the base branch.

**Acceptance Criteria**:
- [ ] For a merge that pulls in a large base delta, the review window excludes files and
      changes that came only from the base branch (not from the resolution).
- [ ] The review scope reflects the conflict-touched surface, not the full parent-1 diff.

### US3: Valid small resolutions are not flagged as trivial (Defect 3)

**As a** cluster operator whose conflict resolution is small but correct,
**I want** the reviewer to not treat a small scoped diff as an "empty/trivial" failure,
**So that** a valid resolution is not forced into a spurious remediation loop.

**Acceptance Criteria**:
- [ ] The "empty or trivial diff" blocking-finding instruction is not emitted for a
      resolution-scoped (windowed) review.
- [ ] A small valid resolution passes review without a `changes-required` verdict caused
      solely by the trivial-diff rule.

### US4: `validate` runs on the post-merge tree (Defect 4)

**As a** cluster operator relying on the merge gate to guarantee validation,
**I want** a post-approval conflict resolution to run `validate` against the merged tree
before the PR is marked ready,
**So that** a broken post-merge tree cannot pass the engine gate with external CI as the
only backstop.

**Acceptance Criteria**:
- [ ] With `ciMergeGateEnabled=true` and `reviewPhaseEnabled=false`, a re-armed
      post-resolution `continue` runs `validate` on the post-merge tree before mark-ready.
- [ ] The terminal short-circuit does not treat pre-resolution `completed:*` labels as
      authoritative for a tree that changed after those labels were granted.
- [ ] Ownership/re-arm labels are managed so that a crash between clearing ownership labels
      and enqueuing the re-arm item does not silently strand the issue.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | After a scoped review round, the scope MUST NOT persist unchanged into the next round when remediation commits were pushed — the window is either cleared or extended to include the remediation commits. | P1 | Defect 1. Prevents invisible fix commits. |
| FR-002 | A scoped re-review MUST evaluate the remediation commits pushed since the prior scoped round. | P1 | Defect 1 outcome. |
| FR-003 | The resolution-scoped review window MUST be limited to the conflict-resolution changes and MUST NOT include changes that originate solely from the merged-in base branch. | P1 | Defect 2. Scope to conflict-touched files. |
| FR-004 | The "empty or trivial diff → blocking finding" charter instruction MUST be suppressed for resolution-scoped (windowed) reviews. | P1 | Defect 3. |
| FR-005 | A small, valid conflict resolution MUST be able to pass a scoped review without a `changes-required` verdict arising solely from the trivial-diff rule. | P1 | Defect 3 outcome. |
| FR-006 | With `ciMergeGateEnabled=true` and `reviewPhaseEnabled=false`, a post-resolution `continue` MUST run `validate` on the post-merge tree before the PR is marked ready. | P1 | Defect 4. Closes the validate bypass. |
| FR-007 | The terminal short-circuit MUST NOT mark a PR ready based on `completed:*` labels granted before the tree changed by a subsequent conflict resolution. | P1 | Defect 4. |
| FR-008 | The re-arm sequence MUST NOT leave an issue silently stalled if a crash occurs between clearing ownership labels and enqueuing the re-arm item. | P2 | Defect 4 crash window. Ordering / idempotency. |
| FR-009 | Changes MUST preserve existing behavior for non-merge-conflict reviews and for the flag-ON review path (no regression to whole-PR reviews). | P1 | Guard rails. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Remediation convergence after a scoped review with a real fix | Loop reaches `clean` and advances; does not hit the remediation cap | Test: scoped review → changes-required → remediation commit fixes defect → next round is `clean`. |
| SC-002 | Scoped review window excludes base-only changes | 0 files that come only from the merged-in base appear in the review window | Test: merge with a large base delta; assert window == conflict-touched surface. |
| SC-003 | Trivial-diff rule suppressed for scoped reviews | Charter for a windowed review contains no "empty or trivial diff" blocking instruction | Test: assert the scoped charter string omits the trivial-diff paragraph. |
| SC-004 | `validate` runs on the post-merge tree under the flag combo | `validate` executes before mark-ready | Test: `ciMergeGateEnabled=true`, `reviewPhaseEnabled=false`, post-resolution re-arm → `validate` invoked on merged tree. |
| SC-005 | No crash-window stall | An interrupted re-arm converges on retry rather than stranding | Test/inspection: crash between label clear and enqueue leaves recoverable state. |
| SC-006 | No regression to unscoped reviews | Whole-PR and flag-ON review paths behave byte-identically | Existing review tests pass unchanged. |

## Assumptions

- The fixes are orchestrator-internal (`packages/orchestrator/src/worker/`) — review
  executor, review charter, merge-conflict handler, phase loop, and the worker re-arm path.
- No new label vocabulary is required; the fix operates on the existing scope/label/phase
  machinery.
- The two epic flags (`reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED`,
  `ciMergeGateEnabled` / `WORKER_CI_MERGE_GATE_ENABLED`) remain the on/off switches; a
  cluster with both OFF is unaffected.
- Line references in the issue are at develop `155b3464`; the exact current-tree call sites
  are resolved during `/plan`.

## Out of Scope

- Redesigning the review/remediate gate or resume label protocol.
- Changing the merge-conflict *resolution* strategy itself (only how the resulting review
  is scoped and how the subsequent lifecycle behaves).
- Cloud-side or cockpit-side changes (agency / generacy-cloud repos).
- Adding an independent CI-only merge backstop beyond what #1133 already provides.

---

*Generated by speckit*

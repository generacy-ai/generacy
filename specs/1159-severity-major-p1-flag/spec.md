# Feature Specification: External-feedback re-entry resets the remediation budget and can re-enqueue every poll

**Branch**: `1159-severity-major-p1-flag` | **Date**: 2026-08-21 | **Status**: Draft

## Summary

**Severity: major (P1).** On the flag-ON `address-pr-feedback` route, a PR that receives external review feedback but does not converge cleanly can enter a runaway loop: the remediation budget resets on every re-entry, and the monitor re-enqueues the same unaddressed feedback on every poll. This is the #883-class runaway that the engine-native review/remediate epic (#1120) set out to retire — reachable again on the flag-ON path. Three independent defects compose to produce (and worsen) the runaway; this spec fixes all three.

### Defect 1 — remediation budget resets across re-entries (the runaway)

- The external-feedback convergence resolver (which resolves the human review threads) runs **only** when `loopResult.completed` (`claude-cli-worker.ts:987-1015`). If the loop instead exits via a different gate (`waiting-for:merge-conflicts`, an on-ci-green pause) or via a phase-failure escalation (`failed:review`, `failed:validate-repeated`), the resolver is bypassed and the human threads stay unresolved.
- Unresolved threads keep the monitor's Case A "trust-live thread present" condition true, so the issue is re-enqueued on the next poll (`pr-feedback-monitor-service.ts`, Case A tail).
- The monitor's skip gate covers `blocked:*` (`:557`) and `waiting-for:remediation-limit` (`:473`) but **not** `failed:*`. A `failed:review` / `failed:validate-repeated` escalation therefore does not suppress re-enqueue.
- On re-entry the seeding adapter calls `clearReviewArtifact(checkoutPath, workflowId)` (`claude-cli-worker.ts:593`) before re-seeding. The seed-aware executor then writes `remediationCount: prior?.remediationCount ?? 0` (`seed-aware-review-executor.ts:96`) — with the artifact cleared, `prior === null`, so the budget starts fresh at 0 every re-entry. The `on-remediation-limit` cap (`phase-loop.ts:1437`, `remediationCount >= maxRemediations`) is therefore per-entry, never global — it can never fire across re-entries.

### Defect 2 — prompt-injection surface regression

- The seeding round sets each finding's `detail` to the **raw** trusted-author comment body (`seed-aware-review-executor.ts:75`, `detail: f.body`), and #1129 validate findings set `detail` to raw validate stdout/stderr tails (`phase-loop.ts:1037`).
- These `detail` strings are embedded **unfenced** into the remediate charter prompt (`remediate-charter.ts:54-62`, `- **Detail:** ${finding.detail}`).
- The legacy fixer fenced ingested content with `wrapUntrustedData` (`packages/workflow-engine/src/security/untrusted-data-fence.ts`; used at `pr-feedback-handler.ts:855` and in the clarify phase). That fencing was not carried onto the flag-ON remediate path — restore it.

### Defect 3 — branch derived from issue number, not PR head ref

- The re-entry derives the working branch via `createFeature(issueNumber)` (`claude-cli-worker.ts:461-501`) rather than the PR's `head.ref`.
- Under slug drift (the #1043 duplicate-branch mode), `createFeature` can produce a branch name that differs from the PR's actual head branch. Remediation commits then land on the wrong branch, and `commitPushAndEnsurePr('remediate')` can open a **duplicate** PR.

Filed from a post-merge code review of epic generacy-ai/generacy#1120. Part of follow-up epic generacy-ai/generacy#1153. All line refs at develop `155b3464`.

## User Stories

### US1: Bounded remediation budget across re-entries (Defect 1)

**As a** cluster operator running the flag-ON review/remediate path,
**I want** the remediation budget to be enforced globally per PR rather than reset on each re-entry,
**So that** a PR that fails to converge parks at the `remediation-limit` gate for human attention instead of silently re-running the seed→review→remediate cycle every monitor poll (burning CLI time and racking up commits).

**Acceptance Criteria**:
- [ ] Re-entering the `address-pr-feedback` route for a PR that already has remediation history preserves the accumulated `remediationCount` (does not reset it to 0).
- [ ] When the accumulated budget reaches `maxRemediations`, the PR parks at `waiting-for:remediation-limit` + `agent:paused` and is not re-enqueued until an operator resumes it.
- [ ] A loop exit via a phase-failure escalation (`failed:review`, `failed:validate-repeated`) or a non-convergence gate does not cause the same unaddressed feedback to be re-enqueued on the next poll without bound.

### US2: Untrusted ingested content is fenced in the remediate charter (Defect 2)

**As a** security-conscious maintainer,
**I want** externally-sourced text (review comment bodies, raw validate output) embedded in the remediate charter to be wrapped in the untrusted-data fence,
**So that** a crafted comment or tool output cannot inject instructions into the remediate agent's prompt.

**Acceptance Criteria**:
- [ ] Seeded finding `detail` values (raw comment bodies) are wrapped with `wrapUntrustedData` before they reach the remediate charter.
- [ ] Validate-evidence finding `detail` values (raw validate stdout/stderr tails) are wrapped with `wrapUntrustedData`.
- [ ] Engine-authored finding detail (from the real review executor) is not double-wrapped or otherwise altered in a way that changes its meaning.

### US3: Remediation commits land on the PR's own branch (Defect 3)

**As a** cluster operator,
**I want** the re-entry to check out and commit to the PR's actual `head.ref`,
**So that** remediation work lands on the existing PR instead of creating a duplicate branch and duplicate PR under slug drift.

**Acceptance Criteria**:
- [ ] The `address-pr-feedback` re-entry derives the working branch from the PR's `head.ref`, not from `createFeature(issueNumber)`.
- [ ] Under a slug-drift condition where the issue-derived slug differs from the PR head branch, remediation commits are pushed to the PR head branch and no duplicate PR is opened.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The remediation budget (`remediationCount`) MUST persist across `address-pr-feedback` re-entries for the same PR — either by not clearing the review artifact on re-entry, or by tracking a global per-PR budget. | P1 | Root cause: `clearReviewArtifact` at `claude-cli-worker.ts:593` + `prior?.remediationCount ?? 0` at `seed-aware-review-executor.ts:96`. |
| FR-002 | When the persisted budget reaches `maxRemediations`, the PR MUST park at the `remediation-limit` gate and MUST NOT be re-enqueued until an operator resume clears/rearms it. | P1 | Gate at `phase-loop.ts:1437`. |
| FR-003 | The monitor skip MUST suppress re-enqueue for in-flight / parked terminal states reachable on this path beyond `blocked:*` — specifically `failed:*` escalations that today fall through to Case A re-enqueue. | P1 | `pr-feedback-monitor-service.ts:473,557`. |
| FR-004 | Seeded finding `detail` (raw comment bodies) MUST be wrapped with `wrapUntrustedData` before embedding in the remediate charter. | P1 | `seed-aware-review-executor.ts:75` → `remediate-charter.ts:54-62`. |
| FR-005 | Validate-evidence finding `detail` (raw validate output tails) MUST be wrapped with `wrapUntrustedData` before embedding in the remediate charter. | P1 | `phase-loop.ts:1037`. |
| FR-006 | The `address-pr-feedback` re-entry MUST derive the working branch from the PR's `head.ref` rather than from `createFeature(issueNumber)`. | P1 | `claude-cli-worker.ts:461-501`. |
| FR-007 | The re-entry MUST NOT open a duplicate PR when the issue-derived slug diverges from the PR head branch (the #1043 dup-branch mode). | P1 | `commitPushAndEnsurePr('remediate')`. |
| FR-008 | The whole flow MUST remain behind the existing review/remediate feature flag; a flag-OFF cluster's behavior MUST be byte-identical to today. | P1 | `reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED`. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Bounded budget: a non-converging PR that re-enters N times (N > maxRemediations) reaches the `remediation-limit` gate. | Parks within `maxRemediations` total remediate executions, not per-entry. | Integration test drives repeated re-entries; asserts the gate fires and `remediationCount` is monotonic across entries. |
| SC-002 | No unbounded re-enqueue: a `failed:*` escalation with unresolved human threads does not re-enqueue on subsequent polls. | 0 re-enqueues while the `failed:*` / parked state is present. | Monitor unit test with a `failed:review`-labeled issue asserts skip. |
| SC-003 | Injection fencing: crafted comment / validate-output text appears inside an `<untrusted-data …>` fence in the charter, never as bare charter instructions. | 100% of seeded and validate-evidence `detail` fenced. | Charter unit test asserts `wrapUntrustedData` wrapping for both finding sources. |
| SC-004 | Correct branch: under slug drift, remediation commits land on the PR head branch and no second PR is created. | Exactly 1 PR for the issue. | Integration test with a diverging slug asserts single PR + commits on head ref. |
| SC-005 | Flag-OFF parity: with the review/remediate flag disabled, observable behavior is unchanged. | Byte-identical. | Existing flag-OFF path tests pass unchanged. |

## Assumptions

- `maxRemediations` is resolved per workflow (speckit-bugfix vs. default) as it is today; this spec changes *when the budget resets*, not the cap value.
- The PR number / `head.ref` is available (or resolvable via `findPRForBranch` / issue-linked PR lookup) at the re-entry point; if the PR does not yet exist, the fresh-request path (budget 0) is correct.
- `wrapUntrustedData` and its `<untrusted-data>` fence are the canonical fencing mechanism; no new fencing primitive is introduced.
- The convergence resolver's completion-gating is intentional; the fix is to *bound re-enqueue* on the non-completion paths, not to force thread resolution on failure.

## Out of Scope

- Redesigning the review/remediate executors, the CI merge gate, or the convergence resolver's core logic (all land as-is from #1120).
- Auto-resolving human review threads on phase-failure or gate-hit exits (deliberately not done — a failed run should surface, not silently resolve threads).
- The cockpit gate-answer wording / operator UX (agency repo).
- The legacy flag-OFF `pr-feedback-handler` route (already fences via `wrapUntrustedData`).
- Repairing PRs already stuck in the runaway state before this fix deploys.

---

*Generated by speckit*

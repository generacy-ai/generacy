# Feature Specification: Keep engine bookkeeping sidecars out of PR branches

**Branch**: `1162-severity-major-p1-engine` | **Date**: 2026-08-21 | **Status**: Draft

## Summary

**Severity: major (P1).** Engine bookkeeping sidecars are committed and pushed into PR branches. The review executor writes `.generacy/review-findings-<id>.json` (and `review-candidate-<id>.json`), and pause writes `.generacy/pause-context-<id>.json`, into the checkout working tree. Every phase-completion commit runs `stageAll()` (`git add -A`, `pr-manager.ts` `commitAndPush` at `:126-133` → `gh-cli.ts:1380`), which indiscriminately stages those sidecars. `.generacy/` is **not** in `.gitignore` (verified in the generacy repo), **not** under the product-diff `EXCLUDED_PATH_PREFIXES` (which contains only `specs/`), and **not** in `EXCLUDED_EXACT_PATHS`. Confirmed by two independent traces.

Consequences:

- Every review/remediate round commits engine state into the PR diff.
- The committed findings sidecar includes #1129-synthesized findings that carry **raw validate stderr tails** (`phase-loop.ts:1029`) — internal diagnostic text that has no business in a product PR.
- The next review round then reviews the engine's own committed bookkeeping as if it were product code.
- On squash-merge, the sidecars land on the default branch.

**Deliberate side effect to preserve.** Committing the findings sidecar is currently what makes `remediationCount` (`review-artifact.ts:55`, persisted via `bumpRemediationCount`/`resetRemediationCount`) survive a worker re-clone. The counter must survive worker restart per the resumability invariant. Any fix that removes the sidecars from git must persist the counter another way that survives restart/re-clone.

Fix direction (to be settled in `/clarify` + `/plan`): exclude the sidecar paths from staging (targeted `git add` of product paths only, or write sidecars outside the repo tree keyed by workflow id, or gitignore + product-diff exclusion). Also verify whether any already-shipped repos have committed sidecars that need cleanup.

---
Filed from a post-merge code review of epic generacy-ai/generacy#1120. Part of follow-up epic generacy-ai/generacy#1153. All line refs at develop `155b3464`.

## User Stories

### US1: Engine bookkeeping never appears in a product PR (primary)

**As a** human reviewer (or the cockpit auto-driver) reviewing a speckit PR,
**I want** the PR diff to contain only product changes,
**So that** I never review the engine's own `.generacy/` sidecars — and especially never see raw validate stderr tails carried in synthesized findings.

**Acceptance Criteria**:
- [ ] After any number of review/remediate rounds, no `.generacy/review-findings-*.json`, `.generacy/review-candidate-*.json`, or `.generacy/pause-context-*.json` file appears in the PR diff.
- [ ] The next review round does not see committed engine bookkeeping among the changed files it reviews.
- [ ] A squash-merge of the PR does not land any `.generacy/` sidecar on the default branch.

### US2: Remediation budget still survives worker restart / re-clone

**As** the workflow engine resuming a remediate loop after a worker restart or a fresh checkout,
**I want** `remediationCount` to reflect the attempts already spent,
**So that** the remediation cap is enforced correctly and the loop does not restart the budget from zero.

**Acceptance Criteria**:
- [ ] After the sidecars are no longer committed, `remediationCount` still reflects prior attempts following a worker restart or re-clone of the checkout.
- [ ] The remediation-limit gate fires at the same effective attempt count as before the fix.

### US3: Already-shipped repos with committed sidecars are handled

**As** an operator of clusters that already ran the buggy engine,
**I want** a known disposition for repos that already have `.generacy/` sidecars committed,
**So that** the fix does not silently leave stale engine state on those branches / default branches.

**Acceptance Criteria**:
- [ ] The disposition for pre-existing committed sidecars (leave / clean up / document) is decided and recorded.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Engine sidecars under `.generacy/` (`review-findings-*`, `review-candidate-*`, `pause-context-*`) MUST NOT be staged or committed by the phase-completion commit path. | P1 | Root cause is the unscoped `git add -A` in `stageAll()` called from `pr-manager.ts` `commitAndPush`. |
| FR-002 | Product commits MUST continue to include all genuine product changes made during the phase. | P1 | Whatever staging change is made must not drop real edits. |
| FR-003 | `remediationCount` (and any other resumability state currently carried by a committed sidecar) MUST survive worker restart and checkout re-clone after the sidecars stop being committed. | P1 | The deliberate side effect the current bug relies on. [NEEDS CLARIFICATION: persistence mechanism if sidecars move out of git — e.g. Redis-keyed by workflow id, `.gitignore`d in-tree file, or out-of-tree path.] |
| FR-004 | The chosen approach MUST NOT reintroduce the #1129 raw-validate-stderr content, or any engine bookkeeping, into the reviewed product diff. | P1 | The exclusion must be effective for the review-round diff, not only the final PR. |
| FR-005 | The disposition for repos that already have committed `.generacy/` sidecars MUST be determined (no-op with rationale, or an explicit cleanup step). | P2 | [NEEDS CLARIFICATION: leave existing committed sidecars, or clean them up, and how.] |
| FR-006 | The fix MUST apply uniformly to all workflows that run the review/remediate phases (`speckit-feature`, `speckit-bugfix`). | P2 | The affected code path is workflow-agnostic. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `.generacy/` sidecars in a PR diff after N review/remediate rounds | 0 | Integration test runs a review→remediate→review loop and asserts no `.generacy/*` path in the pushed diff. |
| SC-002 | Raw validate stderr text reaching the reviewed product diff | 0 occurrences | Test drives a synthesized-finding round and asserts the stderr tail never appears in the committed/reviewed files. |
| SC-003 | `remediationCount` after a simulated worker restart / re-clone | Equals attempts already spent (unchanged from pre-fix behavior) | Test persists a count, simulates restart/re-clone, asserts the count is recovered and the cap fires correctly. |
| SC-004 | Genuine product changes committed per phase | 100% preserved | Test asserts a phase's real product edits are still staged and committed after the staging change. |

## Assumptions

- The only resumability state currently dependent on committing a sidecar is `remediationCount`; other sidecar contents are recomputed per round or per checkout. (Verify in `/plan`.)
- `.generacy/` is used exclusively for engine bookkeeping in the checkout and contains no product artifacts that a PR should carry.
- The product-diff exclusion set (`EXCLUDED_PATH_PREFIXES` = `['specs/']`, `EXCLUDED_EXACT_PATHS`) and staging (`stageAll`) are separate mechanisms; a complete fix addresses whichever ones the chosen approach relies on.

## Out of Scope

- Redesigning the review/remediate sidecar schema or the review executor's finding synthesis.
- Changing the #1129 validate-stderr capture itself (the concern here is that it must not be committed, not how it is produced).
- Broad refactor of the `stageAll` / `commitAndPush` contract beyond what is needed to exclude engine bookkeeping.
- Any cloud-side or cockpit-side change.

---

*Generated by speckit*

# Contract: `address-pr-feedback` head-ref branch resolution

**Feature**: `1159-severity-major-p1-flag` · **FR-006/FR-007 (Q4→C)** · **SC-004**
**Site**: `packages/orchestrator/src/worker/claude-cli-worker.ts` (`:491-495`, address-pr-feedback branch)

## Rule

For `command === 'address-pr-feedback'`, the working branch MUST be resolved from
the PR head ref, not from `createFeature({ number: issueNumber })`. Resolution
follows the zero/one/many rule:

| Linked open PRs | Action | Budget |
|---|---|---|
| exactly one | `getPullRequest(prNumber).head.ref` → `repoCheckout.switchBranch(checkoutPath, headRef)` | preserved (existing artifact) |
| zero | fresh-request: keep current `createFeature({ number })` path | 0 |
| more than one | park this poll (skip), surface for operator attention | n/a — no mutation |

Every command other than `address-pr-feedback` keeps `createFeature` unchanged.

**Precedent**: `pr-feedback-handler.ts:225` (`const branchName = pr.head.ref;` →
`switchBranch`). The single-PR PR number is already known
(`metadata.prNumber`, asserted non-null at `claude-cli-worker.ts:519`).

## Preconditions

- `command === 'address-pr-feedback'`.
- Checkout exists (`ensureCheckout` / `getDefaultBranch` already run).

## Postconditions

- Single-PR case: HEAD is on the PR's `head.ref`; remediation commits land on that
  branch; `commitPushAndEnsurePr('remediate')` updates the existing PR and opens NO
  duplicate PR (FR-007), even under #1043 slug drift.
- Zero-PR case: behavior identical to today's fresh-request path (budget 0).
- Many-PR case: no branch switch, no commit, no PR; the poll is skipped and the
  ambiguity is surfaced.

## Non-goals

- Does not fall back to `createFeature` + warn on ambiguity (Q4 option A, rejected
  — preserves dup-PR risk).
- Does not refuse/park on the unambiguous single-PR case (Q4 option B, rejected —
  over-parks).

## Test (SC-004)

`claude-cli-worker.*.test.ts`: under a slug-drift condition where the issue-derived
slug differs from the PR head branch, assert remediation commits are pushed to the
PR head branch and exactly **1** PR exists for the issue. A separate unit assertion
covers the `>1` linked-PR park path.

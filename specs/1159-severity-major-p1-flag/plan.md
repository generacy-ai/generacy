# Implementation Plan: External-feedback re-entry budget bounding + charter fencing + head-ref checkout

**Feature**: Stop the flag-ON `address-pr-feedback` route from resetting the remediation budget on every re-entry, fence untrusted `detail` in the remediate charter, and check out the PR head ref instead of an issue-derived slug.
**Branch**: `1159-severity-major-p1-flag`
**Status**: Complete

## Summary

Three independent defects on the flag-ON review/remediate `address-pr-feedback` route
compose into a #883-class runaway (the loop the engine-native review/remediate epic
#1120 was meant to retire). This plan fixes all three, all inside
`@generacy-ai/orchestrator` (one new `wrapUntrustedData` import from
`@generacy-ai/workflow-engine`, already a dependency):

- **Defect 1 (the runaway, US1/FR-001..FR-003)** — On a non-completing loop exit
  (phase-failure escalation `failed:review` / `failed:validate-repeated`, or a
  non-convergence gate) the convergence resolver at `claude-cli-worker.ts:987-1015`
  is bypassed, human threads stay unresolved, and the monitor re-enqueues on the next
  poll. The monitor skip covers `blocked:*` (`pr-feedback-monitor-service.ts:557`) and
  `waiting-for:remediation-limit` (`:473`) but **not** `failed:*`. Each re-enqueue
  reaches `clearReviewArtifact` (`claude-cli-worker.ts:593`), wiping the budget so the
  seed-aware executor restarts at `remediationCount: 0` — the `on-remediation-limit`
  cap (`phase-loop.ts:1437`) is per-entry and never fires globally.
  **Fix**: add a blanket `failed:*` prefix skip to the monitor (mirrors the `blocked:*`
  gate, no allow-list). Once same-feedback re-enqueue is suppressed (by the `failed:*`
  skip, the existing `waiting-for:remediation-limit` skip, and — on convergence — the
  resolver), the `clearReviewArtifact` at `:593` is reached only on the two correct
  reset occasions (operator resume of the gate, or a genuinely new review that changed
  the unresolved-thread set), which is exactly the D-2 reset semantics the comment at
  `:580-592` already claims (Q1→A, Q2→B). No new budget store, no artifact-lifecycle
  change beyond what the `failed:*` skip makes reachable.

- **Defect 2 (prompt-injection regression, US2/FR-004..FR-005)** — Seed findings set
  `detail` to the **raw** trusted-author comment body
  (`seed-aware-review-executor.ts:75`) and #1129 validate findings set `detail` to raw
  validate stdout/stderr tails (`phase-loop.ts:1037`). These land **unfenced** in the
  remediate charter (`remediate-charter.ts:60`, `- **Detail:** ${finding.detail}`). The
  legacy fixer fenced ingested content with `wrapUntrustedData`
  (`untrusted-data-fence.ts`; used at `pr-feedback-handler.ts:855`,
  `validate-fix-handler.ts:235`). **Fix**: wrap `detail` with `wrapUntrustedData` at the
  **two ingestion sites only** (Q5→A) — seed synthesis and validate-evidence synthesis —
  leaving engine-authored review findings untouched (no central charter-level wrap, no
  double-wrap risk).

- **Defect 3 (wrong branch, US3/FR-006..FR-007)** — The re-entry derives the working
  branch via `createFeature({ number: issueNumber })` (`claude-cli-worker.ts:491-495`).
  Under slug drift (#1043) that can differ from the PR's real `head.ref`, so remediation
  commits land on the wrong branch and `commitPushAndEnsurePr('remediate')` can open a
  duplicate PR. **Fix**: on the `address-pr-feedback` path, resolve the branch from the
  PR head ref via `getPullRequest(prNumber).head.ref` + `repoCheckout.switchBranch`
  (the `pr-feedback-handler.ts:225` precedent). Resolution rule (Q4→C): exactly one
  linked open PR → its `head.ref`; zero → fresh-request (budget 0, current
  `createFeature` path); more than one → park for operator attention.

Whole flow stays behind `reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED`; a flag-OFF
cluster is byte-identical to today (FR-008).

## Technical Context

- **Language / runtime**: TypeScript, ESM, Node >=22. Monorepo (pnpm workspaces).
- **Primary package**: `@generacy-ai/orchestrator` (worker + monitor).
- **Cross-package**: `@generacy-ai/workflow-engine` — `wrapUntrustedData` from
  `src/security/untrusted-data-fence.ts` (existing export, already a dependency).
- **Test runner**: Vitest.
- **No new dependencies**, no new persisted state (the review artifact remains the
  single source of truth for the budget — Q1→A), no new label vocabulary
  (`failed:*` and `waiting-for:remediation-limit` already ship).

## Constitution Check

No `.specify/memory/constitution.md` present in this repository → constitution check
skipped.

## Project Structure

```
packages/orchestrator/src/
  services/
    pr-feedback-monitor-service.ts        # FR-003: add blanket failed:* skip (mirror blocked:* @ :557)
  worker/
    claude-cli-worker.ts                  # FR-001/FR-002a: keep clearReviewArtifact reachable only on
                                          #   the two reset occasions (via FR-003 upstream);
                                          # FR-006/FR-007: head-ref checkout for address-pr-feedback
    seed-aware-review-executor.ts         # FR-004: wrap seed detail with wrapUntrustedData at :75
    phase-loop.ts                         # FR-005: wrap validate-evidence detail with wrapUntrustedData at :1037
    remediate-charter.ts                  # unchanged — embeds already-fenced detail verbatim (Q5→A)
    __tests__/
      pr-feedback-monitor-service.*.test.ts     # SC-002: failed:* skip
      claude-cli-worker.*.test.ts / helpers     # SC-001 re-entry budget; SC-004 head-ref/dup-PR
      seed-aware-review-executor.test.ts        # SC-003: seed detail fenced
      phase-loop.*.test.ts                      # SC-003: validate-evidence detail fenced

packages/workflow-engine/src/security/untrusted-data-fence.ts   # reused, unchanged
```

## Implementation Phases

1. **FR-003 monitor skip** — add a blanket `startsWith('failed:')` skip in
   `pr-feedback-monitor-service.ts`, placed next to the `blocked:*` short-circuit at
   `:557` (after the `waiting-for:remediation-limit` and `blocked:fixer-timeout`
   branches so retry-eligible carve-outs are unaffected). Log shape mirrors the
   `blocked:*` skip. This is the load-bearing runaway fix — it makes the existing
   `clearReviewArtifact` reachable only on the correct reset occasions (Q1→A/Q2→B).
2. **FR-004/FR-005 fencing** — wrap `detail` with `wrapUntrustedData(body, source)` at
   the two ingestion sites: `seed-aware-review-executor.ts:75` (source label e.g.
   `pr-review-comment` / the author) and `phase-loop.ts:1037` (source label
   `validate-output`). Charter untouched.
3. **FR-006/FR-007 head-ref checkout** — for `command === 'address-pr-feedback'`,
   resolve the PR head ref (single-PR case from the known `metadata.prNumber` via
   `getPullRequest`; apply the Q4→C zero/one/many rule for linked-PR resolution) and
   `switchBranch` instead of calling `createFeature`. Keep `createFeature` for all other
   commands. Park (skip this poll, surface for operator) when more than one linked open
   PR is found.
4. **Tests** — one focused test per success criterion (SC-001..SC-005), reusing existing
   worker/monitor/charter test harnesses.
5. **Changeset** — add `.changeset/1159-*.md` (`@generacy-ai/orchestrator` **patch**,
   `workflow:speckit-bugfix`).

## Risks & Mitigations

- **Reset-occasion correctness (Q2→B)**: the fix relies on the `failed:*` skip + existing
  gate skip + convergence resolver jointly ensuring the worker reaches
  `clearReviewArtifact` only on the two legitimate occasions. Mitigation: SC-001
  integration test drives repeated same-feedback re-entries and asserts monotonic
  `remediationCount` + gate fire; SC-002 asserts the `failed:*` skip suppresses
  re-enqueue.
- **Head-ref ambiguity (Q4→C)**: `>1` linked open PR must park, not guess. Mitigation:
  explicit branch in the resolver + SC-004 covers the single-PR slug-drift case; the
  multi-PR park path gets a unit assertion.
- **Flag-OFF parity (FR-008/SC-005)**: all changes are on the flag-ON
  `address-pr-feedback` path or the monitor's `failed:*` skip (which only affects issues
  that already carry a `failed:*` label). Existing flag-OFF path tests must pass
  unchanged.

## Next Step

Run `/speckit:tasks` to generate the dependency-ordered task list.

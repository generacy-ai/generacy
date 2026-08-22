# Quickstart: Verifying the merge-conflict scoped-review lifecycle fixes

**Branch**: `1164-severity-major-p2-merge`
**Package**: `@generacy-ai/orchestrator`

All four fixes are orchestrator-internal. Verify with Vitest; the merge-conflict / phase-loop
integration tests use `execFileAsync` against real temp git checkouts (established pattern).

---

## Run the tests

```bash
# Full package suite
pnpm --filter @generacy-ai/orchestrator test

# Targeted files (fast loop)
pnpm --filter @generacy-ai/orchestrator test \
  worker/__tests__/phase-loop.merge-conflict-scoped-review \
  worker/__tests__/review-charter.scoped \
  worker/__tests__/merge-conflict-handler.success-disposition \
  worker/__tests__/merge-conflict-handler.rearm-crash-window \
  services/__tests__/worker-dispatcher.rearm-afterenqueue
```

---

## Verify each fix → Success Criteria

### SC-001 — Remediation converges after a scoped review (Defect 1 / FR-001, FR-002)
1. Drive a scoped review round 1 → `changes-required`.
2. Push a remediation commit that actually fixes the finding.
3. Re-enter `review`.
- **Expect**: round 2 window is `lastReviewedCommitSha`..HEAD (includes the remediation
  commit), verdict is `clean`, the loop advances past `review`, and the remediation cap is
  **not** reached.
- **Regression check**: without the fix, round 2 re-uses the pre-remediation scope, re-reports
  the same finding, and burns to the cap.

### SC-002 — Scoped window excludes base-only changes (Defect 2 / FR-003)
1. Construct a merge that pulls in a large base delta plus a small conflict resolution.
2. Inspect the round-1 scoped charter.
- **Expect**: the review surface equals the conflicted-path allowlist; 0 files that came
  only from the merged-in base appear.

### SC-003 — Trivial-diff rule suppressed for scoped reviews (Defect 3 / FR-004, FR-005)
1. Build a charter for a windowed (scoped) review.
- **Expect**: the string contains no "empty or trivial diff" blocking instruction.
2. Build a charter for a whole-PR round-1 review.
- **Expect**: the trivial-diff paragraph is still present (unchanged).

### SC-004 — `validate` runs on the post-merge tree (Defect 4 / FR-006, FR-007)
1. Set `ciMergeGateEnabled=true`, `reviewPhaseEnabled=false`.
2. Trigger a post-approval conflict resolution → re-arm `continue`.
- **Expect**: `applySuccessDisposition` removed `completed:validate` +
  `completed:implementation-review`; the #1133 terminal short-circuit does not fire;
  `validate` executes on the merged tree before mark-ready.

### SC-005 — No crash-window stall (Defect 4 crash window / FR-008)
1. Simulate a crash between `enqueueIfAbsent` and `afterEnqueue`.
- **Expect**: a queued re-arm item plus a stale `agent:*` ownership label — recoverable
  (overwritten by `onResumeStart`), not a silent stall.
2. Assert dispatcher order: `afterEnqueue` runs strictly after `enqueueIfAbsent`, and not at
  all when `enqueueIfAbsent` throws.

### SC-006 — No regression to unscoped reviews (FR-009)
- **Expect**: existing whole-PR and flag-ON review tests pass unchanged; a `ReviewScope`
  without `conflictedPaths` produces the pre-#1164 range charter byte-for-byte; round 2+ of an
  ordinary PR is unchanged.

---

## Manual smoke (optional, cluster)

With both epic flags OFF (default), the entire re-arm path is inert — a cluster is unaffected.
To exercise the fix end-to-end, enable `WORKER_REVIEW_PHASE_ENABLED=true` and
`WORKER_CI_MERGE_GATE_ENABLED=true`, then drive a PR into a merge conflict, let the engine
resolve it, and confirm: (a) the scoped review names only the conflicted paths, (b) a
remediation converges on the next round, and (c) `validate` runs on the merged tree before the
PR is marked ready.

---

## Troubleshooting

- **Round 2 still scoped**: confirm `priorRound` is read before the `reviewScope` branch and
  that the empty-window check, delta pauseContext, and charter `diffWindow` are all gated on
  `!priorRound`.
- **Charter shows the full parent-1 range**: confirm `conflictedPaths` was threaded through
  `pushAndSucceed → finishSuccess → getResolutionScope` and is non-empty on the
  post-resolution path.
- **Short-circuit still fires**: confirm both `completed:validate` and
  `completed:implementation-review` are in the `applySuccessDisposition` remove batch.
- **Ownership label cleared too early**: confirm `agent:*` clearing moved out of
  `applySuccessDisposition` into the `afterEnqueue` closure invoked post-enqueue.

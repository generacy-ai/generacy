# Quickstart: Validate-origin remediation budget + reliable stop (#1158)

## What changed

When the review/remediate flow is enabled, a failing `validate` phase now flows through the **same** `RemediateExecutor` as review-origin remediation. It consumes the shared `remediationCount` budget, is bounded by the CLI timeout, respects the fixer exit code, and cites the effective validate command in evidence/alerts.

## Feature flag

Everything is behind `reviewPhaseEnabled` (env `WORKER_REVIEW_PHASE_ENABLED`, default `false`). Flag OFF ⇒ no validate routing, behavior identical to pre-change (FR-009).

```bash
export WORKER_REVIEW_PHASE_ENABLED=true   # to exercise the path
```

## Behavior walkthrough

1. `validate` fails on a bugfix branch → the loop builds a **stable** fingerprint (`effectiveValidateCommand :: hashValidationEvidence(stdout).hash`), posts a failure alert, and synthesizes a `changes-required` critical finding carrying the validate output.
2. The loop backtracks to `review` (synthetic success), then hits the remediate seam.
3. `RemediateExecutor.execute` spawns the fixer with the SIGTERM→grace→SIGKILL envelope and **bumps `remediationCount` by one**.
   - Clean exit → commit + push.
   - Timeout-kill (`timedOut === true`) → commit + push partial work.
   - Clean-run non-zero exit → **no** commit/push.
4. Loop re-enters `review` → `validate` re-runs.
   - Pass → proceed (clean escape).
   - Fail → re-synthesize; when `remediationCount >= maxRemediations`, `on-remediation-limit` pauses (`waiting-for:remediation-limit` + `agent:paused`).
5. On a repeated-identical validate failure, the stable fingerprint trips the `failed:validate-repeated` backstop at `REPEAT_FAILURE_THRESHOLD` before the cap.

## Resuming a capped loop

Add `completed:remediation-limit` to the issue (per #1128 gate protocol). The next poll resets the count, clears the label, and re-arms.

## Verifying locally

```bash
pnpm --filter @generacy-ai/orchestrator test -- phase-loop
pnpm --filter @generacy-ai/orchestrator test -- remediate-executor
```

Key assertions:
- validate-origin remediation pauses at exactly `maxRemediations` (SC-001)
- identical fingerprint for output-noise-only variation (SC-002)
- hung fixer killed at timeout, partial work pushed (SC-004)
- clean-run non-zero fixer exit leaves the branch untouched (SC-005)
- flag OFF ⇒ byte-identical (SC-006)

## Troubleshooting

- **Gate never fires:** confirm `RemediateExecutor` is injected into `PhaseLoopDeps` (not the retired stub) and that `remediationCount` is advancing on the sidecar (`.generacy/review-findings-*.json`).
- **Fingerprint still flapping:** ensure the validate `reason` is set (the `explicitReason` arg to `buildErrorEvidence`), not left to fall back to `outputTail`.
- **Alert cites the wrong command:** confirm `effectiveValidateCommand` was hoisted and used at the fingerprint/finding sites (FR-008).
- **Sibling-file overlap:** the retired `ValidateFixHandler`'s per-file guard is gone (plan RISK-1); rely on the #1051 push-guard, or port the guard as a follow-up.

# Quickstart: Review executor phantom-clean fix (#1155)

## What this changes

A review round that fails, times out, crashes, or produces no fresh findings sidecar is now treated as a **phase failure / no-verdict** — never a phantom `clean`. The loop halts instead of advancing an unreviewed change to `validate` / marking the PR ready.

## Files to edit

- `packages/orchestrator/src/worker/review-artifact.ts` — add candidate-path helpers + `clearReviewCandidate`; point `readCandidateFindings` at the candidate path and return `ReviewFinding[] | null`.
- `packages/orchestrator/src/worker/review-executor.ts` — candidate write target, pre-spawn clear, post-exit gate, propagate exit code.
- `packages/orchestrator/src/worker/__tests__/review-artifact.test.ts` — candidate path + null contract.
- `packages/orchestrator/src/worker/__tests__/review-executor.test.ts` — regression cases.
- `.changeset/1155-review-executor-phantom-clean.md` — `@generacy-ai/orchestrator` **patch**.

## Build / test

```bash
pnpm --filter @generacy-ai/orchestrator build
pnpm --filter @generacy-ai/orchestrator test review-executor
pnpm --filter @generacy-ai/orchestrator test review-artifact
```

## Regression cases (FR-006)

| Case | Setup | Expected |
|------|-------|----------|
| Missing sidecar | Agent exits 0, writes no candidate | `success: false`; no artifact; no `clean`; loop halts |
| Non-zero exit | Agent exits 1 | `success: false, exitCode: 1`; no artifact |
| Timeout | CLI killed via SIGTERM/SIGKILL | `success: false`; no artifact |
| Round ≥ 2 no-op | Prior engine artifact exists; agent writes no candidate this round | `readCandidateFindings → null`; `success: false`; prior artifact + `remediationCount` untouched |
| Crash window | Engine artifact intact, candidate half-written/invalid | Engine artifact + `remediationCount` preserved; candidate → `null` → `success: false` |
| Happy path (FR-007) | Agent writes valid candidate, exits 0 | `success: true`; artifact written; `round` +1; verdict recomputed by engine |

## Manual verification of the SC-004 no-regression claim

The existing `review-executor.test.ts` SC-004 test (engine recomputes verdict, ignoring the agent-claimed `verdict`) must remain green after repointing the fake launcher's write target from `getReviewArtifactPath` to the new candidate path.

## Rollout note

The review phase is behind `reviewPhaseEnabled` (default OFF); this fix does not change the flag or its default. No cluster migration required — the candidate path is created/cleared per round.

## Next step

`/speckit:tasks`

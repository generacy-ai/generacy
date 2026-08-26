# Quickstart: Resume label-strip fix (#1154)

## What this fixes
Answering the remediation-limit gate (`completed:remediation-limit`) or approving the on-ci-green implementation-review gate (`completed:implementation-review`) now actually resumes and advances/terminates the workflow, instead of having the answer silently stripped on resume and the gate re-park.

## Files changed
- `packages/orchestrator/src/worker/label-manager.ts` — guard completed-strip with `isHumanGateCompletion()` (FR-001)
- `packages/orchestrator/src/worker/phase-resolver.ts` — add `ci` to `GATE_MAPPING` (FR-004)
- `packages/orchestrator/src/worker/phase-loop.ts` — marker-dedupe the remediation-limit comment (FR-005); defensive clear of `completed:remediation-limit` on clean review (FR-006)
- Tests under `packages/orchestrator/src/worker/__tests__/`

## Build & test

```bash
pnpm install
pnpm --filter @generacy-ai/orchestrator build
pnpm --filter @generacy-ai/orchestrator test
```

Run the targeted suites:

```bash
pnpm --filter @generacy-ai/orchestrator test label-manager.onresumestart
pnpm --filter @generacy-ai/orchestrator test phase-loop.resume-gates
pnpm --filter @generacy-ai/orchestrator test phase-resolver.ci-gate
pnpm --filter @generacy-ai/orchestrator test phase-loop.remediation-comment-dedupe
```

## Verifying the acceptance criteria

| SC | How to verify |
|----|---------------|
| SC-001 | `phase-loop.resume-gates.integration.test.ts`: add `completed:remediation-limit`, resume through real `onResumeStart`, assert counter reset + gate cleared + loop proceeds (no immediate re-pause on same count). |
| SC-002 | Same suite: add `completed:implementation-review` with `completed:validate` present (ciMergeGate ON), resume, assert terminal no-op short-circuit taken and `validate` not re-run. |
| SC-003 | `label-manager.onresumestart.test.ts`: assert human-gate completions retained while stale `waiting-for:*` / `agent:paused` removed. |
| SC-004 | `phase-loop.remediation-comment-dedupe.test.ts`: assert marker suppresses a second "Remediation limit reached" comment on a re-pause cycle. |
| SC-005 | `phase-resolver.ci-gate.test.ts`: assert `completed:ci` resolves `validate` and `HUMAN_GATE_SUFFIXES.has('ci')`. |

## Feature flags
Both P0 fixes are behind the epic's existing flags — a flag-OFF cluster is unaffected:
- `reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED`
- `ciMergeGateEnabled` / `WORKER_CI_MERGE_GATE_ENABLED`

## Changeset
`.changeset/1154-resume-gate-strip.md` — `@generacy-ai/orchestrator` **patch**.

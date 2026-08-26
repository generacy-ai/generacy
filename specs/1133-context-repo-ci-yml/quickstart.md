# Quickstart: CI-aware merge readiness (#1133)

## What this changes

With `ciMergeGateEnabled` ON, a speckit PR becomes merge-ready only when **both** are true:
1. The `validate` phase succeeds on the worker.
2. CI is **actually green** on the ready-for-review PR (skipped/neutral runs do NOT count as green).

The `implementation-review` approval gate then fires on the `validate` phase — only once CI is confirmed green.

## Enabling

```bash
# Orchestrator / worker env
export WORKER_CI_MERGE_GATE_ENABLED=true      # default: false (byte-identical to today when off)
export WORKER_CI_WAIT_TIMEOUT_MS=900000       # optional; default 15 min. Per-workflow overridable.
```

Or per-workflow in worker config (mirrors `phaseTimeoutMs` overrides):

```yaml
worker:
  ciMergeGateEnabled: true
  ciWaitTimeoutMs: 900000
```

## Target-repo migration (FR-008 / US4)

CI must trigger on the draft→ready flip. Add `ready_for_review` to the target repo's `ci.yml`:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
```

Without this, CI never runs on the draft→ready flip, and the engine's readiness wait times out into a `waiting-for:ci` pause.

**Readiness contract**: merge-ready = `validate` success AND CI green. **skipped≠passed** — a run whose conclusion is `skipped`, `neutral`, `cancelled`, `timed_out`, `action_required`, or `failure` is NOT green; only `success` is.

## Flow

```
clean review → PR marked ready-for-review → validate (worker) ∥ CI (GitHub)
   validate ✔ + CI green      → implementation-review gate raised → human approve → merge-eligible
   validate ✔ + CI pending    → bounded backoff wait (≤ ciWaitTimeoutMs)
                                   → green → gate raised
                                   → not-passed → readiness blocked (no gate)
                                   → timeout → waiting-for:ci + agent:paused (resumable)
   validate ✘                 → existing review→remediate routing (#1129), no CI wait
```

## Resuming a `waiting-for:ci` pause

Once CI is green (e.g. after a re-run or the migration above), resume the worker; readiness is re-evaluated and the gate fires if green.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| PR stuck on `waiting-for:ci` | No CI run for the head SHA (unmigrated repo) | Add `ready_for_review` to the target `ci.yml` trigger types |
| Gate never fires despite green checkmarks | All runs were `skipped`/`neutral` | Ensure a real (non-skipped) CI job runs on ready PRs |
| Readiness uses `actions-runs` source in logs | Token lacks `checks:read` | Expected — the fallback yields the same verdict (SC-004) |
| Behavior unchanged after enabling | Flag not threaded to the worker | Confirm `WORKER_CI_MERGE_GATE_ENABLED=true` reached the worker process |

## Verifying (dev)

- Unit: `pnpm --filter @generacy-ai/workflow-engine test ci-verdict`
- Unit: `pnpm --filter @generacy-ai/orchestrator test ci-merge-readiness`
- Integration: `pnpm --filter @generacy-ai/orchestrator test phase-loop.ci-merge-gate`

# Quickstart: PR-feedback monitor rewrite (#1130)

## What this feature changes

- The PR-feedback monitor **ignores** review threads the engine itself authored (marker-matched),
  so the monitor and the engine never race on the engine's own review rounds.
- Genuine **external trusted feedback** (human CHANGES_REQUESTED or inline threads) is routed into
  the engine's shared `review`/`remediate` loop — one round counter, one code path — instead of the
  legacy fixer.
- The `blocked:stuck-feedback-loop` dead-end is retired; exhaustion now lands on
  `waiting-for:remediation-limit`.

## Prerequisites

- Epic #1120 siblings merged: #1121 (phase machinery), #1124 (review executor + findings artifact),
  #1125 (PR review posting + markers), #1126 (re-review convergence), #1127 (engine-authored marker
  helpers).
- The `review` phase enabled: `WORKER_REVIEW_PHASE_ENABLED=true` (worker `reviewPhaseEnabled`).
  With the flag off, the new routing path is unreachable and clusters behave as before.

## Key files

| Concern                         | File                                                                   |
|---------------------------------|------------------------------------------------------------------------|
| Engine-thread exclusion         | `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`    |
| Thin adapter (parser + seed)    | `packages/orchestrator/src/worker/pr-feedback-handler.ts`              |
| External-feedback seed          | `packages/orchestrator/src/worker/external-feedback-seed.ts` (new)     |
| Seed-aware review wrapper       | `packages/orchestrator/src/worker/seed-aware-review-executor.ts` (new) |
| Adapter routing / DI            | `packages/orchestrator/src/worker/claude-cli-worker.ts`                |
| Label removal                   | `packages/workflow-engine/src/actions/github/label-definitions.ts`     |

## How the flow works (external feedback → remediate)

1. A trusted human submits a CHANGES_REQUESTED review or inline threads.
2. The monitor's trust loop keeps those threads live (they contain external comments) and enqueues
   `command: 'address-pr-feedback'`. Engine-authored-only threads are excluded and do not trigger.
3. The worker's `address-pr-feedback` job parses the feedback (inline threads AND review bodies),
   clears the prior review artifact (fresh remediation budget), writes an external-feedback seed,
   and runs the phase loop starting at `review`.
4. `SeedAwareReviewExecutor` sees the seed, writes the findings artifact with
   `verdict = changes-required` (no CLI spawn), and deletes the seed.
5. `remediateTrigger` fires → the engine's `remediate` phase addresses the feedback → re-enters
   `review`.
6. The convergence round finds no seed → the real `ReviewExecutor` re-reviews; when clean, the PR
   returns to ready-for-review.
7. On cap exhaustion, the `on-remediation-limit` gate pauses with `waiting-for:remediation-limit`.
   A new human review/comment resets the budget (the adapter clears the artifact again).

## Running tests

```bash
pnpm --filter @generacy-ai/orchestrator test        # monitor + worker + wrapper suites
pnpm --filter @generacy-ai/workflow-engine test     # label-definitions
```

Regression oracle (SC-006): the existing `pr-feedback-monitor-service` test suites must stay green
(untrusted-notice, `blocked:*` skip, adaptive interval).

## Changeset

Add `.changeset/1130-pr-feedback-remediate-routing.md`:
- `@generacy-ai/orchestrator` — **patch** (internal service/worker changes, no new public exports).
- `@generacy-ai/workflow-engine` — **minor** (removal of `blocked:stuck-feedback-loop` label
  vocabulary).

Verify both bumps at implement time (grep for remaining `stuck-feedback-loop` references before
deleting the label).

## Troubleshooting

- **External feedback isn't remediated / still hits the legacy path**: confirm
  `WORKER_REVIEW_PHASE_ENABLED=true`; with the flag off, `review` is absent from the effective
  sequence and the routing is inert.
- **Body-only findings dropped**: check the seed file
  (`.generacy/external-feedback-<id>.json`) contains the review-body findings with the
  `"review body (no file anchor)"` prefix; if empty, the dual-source parser didn't extract them.
- **Engine's own threads re-trigger the monitor**: verify the exclusion predicate uses
  `commentCarriesEngineAuthoredReviewMarker` on raw comment bodies and that ALL comments in the
  thread are engine-authored (a mixed thread is intentionally kept live).
- **Stuck on `waiting-for:remediation-limit`**: expected after the cap; a new trusted human
  review/comment resets the budget and re-enters the loop.

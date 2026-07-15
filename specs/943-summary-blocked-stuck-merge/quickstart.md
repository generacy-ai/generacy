# Quickstart: Cockpit classifier — `blocked:*` error tier (#943)

## What changes for a caller

Nothing at the API surface. `classify(labels)` still returns `{ state, sourceLabel }`. What changes is the disposition of two labels:

- `blocked:stuck-merge-conflicts` now returns `state: 'error'` (was `'waiting'`).
- `blocked:stuck-validate-fix` now returns `state: 'error'` (was `'waiting'`).
- `blocked:stuck-feedback-loop` still returns `state: 'waiting'` (unchanged).

Downstream consumers reading `sourceLabel` now see the `blocked:stuck-*` name when it co-occurs with `agent:error` or `failed:*`; before, one of those two generic labels would have won the tie-break.

## Installation

None. This is a pure code change in `@generacy-ai/cockpit`. Upgrading the cockpit package (via a fresh install, orchestrator rebuild, or `pnpm install && pnpm build`) picks up the new behaviour on the next process start.

## Verifying the change locally

```bash
# 1) Run the classifier tests.
cd packages/cockpit
pnpm vitest run src/__tests__/classifier.test.ts

# 2) Smoke-check the mapping in a REPL.
pnpm --silent build
node -e "
  const { classify } = require('./dist/index.js');
  const { mapLabelToState } = require('./dist/state/label-map.js');
  console.log(mapLabelToState('blocked:stuck-merge-conflicts'));      // 'error'
  console.log(mapLabelToState('blocked:stuck-validate-fix'));          // 'error'
  console.log(mapLabelToState('blocked:stuck-feedback-loop'));         // 'waiting'
  console.log(classify(['waiting-for:merge-conflicts', 'blocked:stuck-merge-conflicts']));
  // { state: 'error', sourceLabel: 'blocked:stuck-merge-conflicts' }
  console.log(classify(['agent:error', 'blocked:stuck-merge-conflicts']));
  // { state: 'error', sourceLabel: 'blocked:stuck-merge-conflicts' }
"
```

## Verifying against a live issue

```bash
# View labels on an issue that the merge-conflict handler blocked.
gh issue view <n> --repo <owner>/<repo> --json labels --jq '.labels[].name'

# Cockpit status will render the promoted state.
generacy cockpit status <owner>/<repo>#<n>
# Expected: state=error, sourceLabel=blocked:stuck-merge-conflicts

# Watching an issue mid-block emits a transition when the block is applied.
generacy cockpit watch <owner>/<repo>#<n>
# Expected on block: one JSON line with state=error, sourceLabel=blocked:stuck-merge-conflicts
```

## Rolling back

Delete the two-line `if (ERROR_BLOCKED_LABELS.has(label)) return 'error';` guard in `packages/cockpit/src/state/label-map.ts` and remove the `error`-tier branch from `compareSourceLabels` in `packages/cockpit/src/state/precedence.ts`. Both files revert cleanly. Rollback does not require a data migration.

## Troubleshooting

- **`cockpit status` still shows `waiting` for a blocked issue.** Check that `@generacy-ai/cockpit` was rebuilt (`pnpm --filter @generacy-ai/cockpit build`) and the process that renders the status (CLI or long-running watch) has been restarted. The classifier's `LABEL_TO_STATE` is built at module load.
- **Transition event fires but `sourceLabel` is `agent:error` or `failed:*`, not the blocked label.** Confirm `ERROR_PIPELINE_ORDER` in `precedence.ts` includes the label. Confirm `compareSourceLabels` has an `if (tier === 'error')` branch (a missing branch silently falls through to `workflowLabelIndex`, giving the pre-fix behaviour).
- **A new `blocked:*` label was added to `WORKFLOW_LABELS` and it classifies as `waiting`.** Expected. Promoting it to `error` requires adding it to `ERROR_BLOCKED_LABELS` (and, if you want it to outrank `agent:error` / `failed:*`, to `ERROR_PIPELINE_ORDER` as well).
- **`blocked:stuck-feedback-loop` classifies as `error`.** Regression. The enumerated allow-list must not contain it (per CD-1); check `ERROR_BLOCKED_LABELS` in `label-map.ts`.

## Related documents

- Spec: `specs/943-summary-blocked-stuck-merge/spec.md`
- Clarifications: `specs/943-summary-blocked-stuck-merge/clarifications.md`
- Plan: `specs/943-summary-blocked-stuck-merge/plan.md`
- Data model: `specs/943-summary-blocked-stuck-merge/data-model.md`
- Contract: `specs/943-summary-blocked-stuck-merge/contracts/classifier-error-tier.md`
- Prior art: `specs/883-found-during-cockpit-v1/plan.md` (waiting-tier pin), `specs/892-found-during-cockpit-v1/plan.md` (validate-fix handler)

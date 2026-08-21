---
"@generacy-ai/orchestrator": patch
"@generacy-ai/workflow-engine": patch
---

Red CI must not silently complete the workflow (#1157).

With `ciMergeGateEnabled` on (#1133), a successful `validate` followed by red CI
terminated the workflow indistinguishably from success: the `not-passed` verdict
merely skipped the `on-ci-green` gate, control fell through to
`onPhaseComplete('validate')` (granting `completed:validate`, cockpit's
merge-eligible surface), the loop returned `completed: true`, and the completion
flow re-marked the PR ready. No pause, no `waiting-for:*`, no comment.

Fix (defect fix, no new public exports):

- `@generacy-ai/orchestrator`: the `not-passed` verdict now pauses the workflow
  in the same recoverable state as the existing `timeout` pause
  (`waiting-for:ci` + `agent:paused`, no `completed:validate`), posting a
  best-effort reason comment. An unresolvable head SHA fast-fails into the same
  pause before `waitForCiGreen` is ever called. The shared `pauseForCiReadiness`
  helper never calls `onPhaseComplete`, so the red path can never grant
  `completed:validate` or reach `completed: true`. Also fail-closes the
  `actions/runs` fallback: a would-be `green` aggregated from the fallback
  (token lacks `checks:read`, third-party required checks invisible) is
  downgraded to `not-passed`.
- `@generacy-ai/workflow-engine`: `startup_failure` and `stale` become
  first-class failing CI conclusions (union-member widening is a semantic
  correction of already-passed-through values), so a hard CI failure resolves
  promptly to `not-passed` instead of falling through to `pending` and forcing
  the slow 15-minute timeout.

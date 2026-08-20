---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/generacy-plugin-claude-code": minor
"@generacy-ai/orchestrator": patch
---

Remediate phase executor — remediation counter + remediation-limit gate (#1128).

Replaces the inert `runStubPhase('remediate')` (from #1121) with a real `RemediateExecutor` that runs a single code-change pass over the open blocking findings recorded in the review sidecar, then backtracks to `review` for verification. The loop is bounded by an explicit, resettable `remediationCount` (distinct from the monotonic `round`) that is incremented by exactly one on every executor return path — normal exit, timeout kill, and spawn failure — so a perpetually-timing-out attempt still consumes budget. At the cap the `on-remediation-limit` gate pauses with `waiting-for:remediation-limit` + `agent:paused` and posts a gate-body comment; an operator adds `completed:remediation-limit` to reset the counter and re-arm the gate. No terminal `blocked:*` label is ever applied, and the executor never resolves review threads, marks the PR ready, writes GitHub review state, or touches `round`/`verdict`. Remains byte-identical when `reviewPhaseEnabled=false`.

`@generacy-ai/workflow-engine` (minor) adds the `completed:remediation-limit` label vocabulary.

`@generacy-ai/generacy-plugin-claude-code` (minor) adds the `remediate` launch intent kind.

`@generacy-ai/orchestrator` (patch) adds the remediate charter builder, the `RemediateExecutor`, the `remediationCount` sidecar field and bump/reset helpers, and the phase-loop/worker wiring — internal plumbing with no new public exports.

---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/generacy-plugin-claude-code": minor
"@generacy-ai/orchestrator": patch
---

Review phase executor — structured findings artifact + engine-internal verdict (#1124).

Replaces the inert `runStubPhase('review')` (from #1121) with a real executor. The engine builds an in-process charter prompt (selected by `review.profile`), spawns the CLI via a new `review` launch intent, the agent writes a structured findings sidecar, and the engine Zod-validates the findings and **recomputes** the verdict (`clean` | `changes-required`) — the agent-claimed verdict is ignored and GitHub review state is never used (the cluster account 422s on `REQUEST_CHANGES` against its own PR). The next-phase decision is driven through the synchronous `remediateTrigger` seam, bounded by `maxRemediations` with a `waiting-for:remediation-limit` gate pause. Remains byte-identical when `reviewPhaseEnabled=false`.

`@generacy-ai/workflow-engine` (minor) adds the `waiting-for:remediation-limit` label vocabulary.

`@generacy-ai/generacy-plugin-claude-code` (minor) adds the `review` launch intent kind.

`@generacy-ai/orchestrator` (patch) adds the review-artifact sidecar module, the review charter builder, the `ReviewExecutor`, the `on-remediation-limit` gate condition, and the phase-loop/worker wiring — internal plumbing with no new public exports.

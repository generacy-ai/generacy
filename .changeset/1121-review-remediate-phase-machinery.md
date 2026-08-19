---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/config": minor
"@generacy-ai/orchestrator": patch
"@generacy-ai/generacy": patch
---

Add `review` and `remediate` to the workflow phase machinery (#1121).

Widens the canonical `WorkflowPhase` vocabulary with two new phases and threads them through every hand-maintained duplication site so the packages compile and existing runs stay byte-identical. This ships type/config/label plumbing plus inert stub execution only — real executors, prompts, verdict/finding logic, and concrete `remediate` triggers land in later epic issues.

`@generacy-ai/workflow-engine` (minor) adds the `phase:`/`completed:`/`failed:`/`failed:*-repeated` label families for both `review` and `remediate` to `WORKFLOW_LABELS` (no `waiting-for:` gate labels) and widens the `CorePhase` union.

`@generacy-ai/config` (minor) widens the public `template-schema` `phases` keys to accept optional `review` / `remediate` agent entries.

`@generacy-ai/orchestrator` (patch) inserts `review` into `PHASE_SEQUENCE` between `implement` and `validate` (feature/bugfix inherit it; `speckit-epic` unchanged), maps both new phases to the `implementation` stage, adds a `reviewPhaseEnabled` flag (default `false`) that skips `review` before any label side effect fires, adds an inert stub executor for both phases, and adds an off-sequence `remediate` seam gated on an injectable `remediateTrigger` (undefined in production → dead by default).

`@generacy-ai/generacy` (patch) adds `review` / `remediate` to the cockpit `resume` `KNOWN_PHASES` list.

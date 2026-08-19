---
"@generacy-ai/config": minor
"@generacy-ai/orchestrator": patch
---

Add per-workflow orchestrator overrides to `.generacy/config.yaml` (#1122).

`@generacy-ai/config` gains a new `orchestrator.workflows.<name>` map so a target repo can vary `validateCommand`, `preValidateCommand`, `maxRemediations`, and a `review` block per workflow (e.g. `speckit-feature` vs `speckit-bugfix`). New public schema/type exports: `WorkflowReviewSchema`, `WorkflowOverrideSchema`, `WorkflowReview`, `WorkflowOverride`. Value schemas are `.strict()` so unknown keys fail loudly.

`@generacy-ai/orchestrator` gains an internal `resolveWorkflowOverrides` resolver (plus `DEFAULT_REVIEW` and `ResolvedWorkflowConfig`) that walks each field independently with `??` — precedence workflow-level > repo-level > cluster default for validate commands, and workflow-level > built-in default for `maxRemediations`/`review` (no repo tier). No consumer wiring yet; the review/remediate phases consume it under epic #1120.

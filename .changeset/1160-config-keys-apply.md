---
"@generacy-ai/config": minor
"@generacy-ai/orchestrator": patch
---

Wire four silently-dropped per-workflow/agent config keys so they take effect at runtime (#1160).

Four config keys shipped by the engine-native review/remediate epic parsed cleanly (or were documented) but were ignored at their runtime call sites:

- `validateCommand` — the non-bugfix validate seed now resolves through `resolveWorkflowOverrides` so a per-workflow `workflows.<name>.validateCommand` reaches the validate spawn. `speckit-bugfix` keeps its targeted-validate narrowing composed over the resolved base.
- `preValidateCommand` — the pre-validate install step now reads the resolved value; an explicit `""` at the workflow tier skips the install, while an unset tier falls through to the repo/cluster default.
- `phases.review` / `phases.remediate` agent selection — the review and remediate executors now resolve the agent via a new field-by-field `resolveReviewLikeAgent`, preferring the phase tier and falling back to the full `implement` resolution per field. Remediate never inherits the `review` tier.
- `ciWaitTimeoutMs` — added as an optional per-workflow override on the public `WorkflowOverride` schema (bounded `>= 30_000`, mirroring the cluster floor) and wired into the CI-readiness wait.

`@generacy-ai/config` bumps **minor** (additive optional `ciWaitTimeoutMs` on the public `WorkflowOverride` type — new user-facing config surface). `@generacy-ai/orchestrator` bumps **patch** (internal call-site wiring plus the new non-exported `resolveReviewLikeAgent`; no public export change).

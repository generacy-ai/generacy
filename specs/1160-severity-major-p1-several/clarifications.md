# Clarifications

## Batch 2026-08-21T15:10:00Z

### Q1: Review/remediate agent selection (FR-005)
**Context**: `phases.review`/`phases.remediate` model/effort selection is documented as a cost knob (`bugfix-profile-config.md:44-65`), but `review-executor.ts:121-127` and `remediate-executor.ts:95` deliberately resolve the `implement` agent, so the key is a silent no-op. This decision determines whether code changes land at the executor call sites or the schema rejects the keys.
**Question**: Should `phases.review`/`phases.remediate` agent selection be implemented (resolve those agents, falling back to `implement`), or rejected loudly at parse time with the docs corrected?
**Options**:
- A: Implement per-phase agent selection — resolve the `review`/`remediate` agent, fall back to `implement` (spec default, Decision A).
- B: Reject `phases.review`/`phases.remediate` at parse time with a clear message and correct the docs.

**Answer**: A) Implement per-phase agent selection — resolve the review/remediate agent, fall back to implement (spec default, Decision A). Rationale: `WorkflowAgentEntriesSchema.phases` already enumerates review/remediate and `resolveAgentForPhase` resolves per-phase with tier fallback; the executors merely pass the `implement` literal (review-executor.ts:126, remediate-executor.ts:98). Fix the literal — no schema change.

### Q2: `ciWaitTimeoutMs` per-workflow claim (FR-006)
**Context**: The migration guide (`review-remediate-migration.md:96-97`) presents `ciWaitTimeoutMs` as a per-workflow key, but `WorkflowOverrideSchema` is `.strict()` without it, so the documented YAML fails parsing. It currently exists only as cluster env (`WORKER_CI_WAIT_TIMEOUT_MS`). The "Per-workflow-overridable" comment at `worker/config.ts:155` is stale plan text.
**Question**: Should `ciWaitTimeoutMs` become a real per-workflow override, or stay cluster-env-only?
**Options**:
- A: Add `ciWaitTimeoutMs` to `WorkflowOverrideSchema` and resolve it per-workflow, mirroring `phaseTimeoutMs`/`maxRemediations` (spec default, Decision B). Makes the documented YAML valid.
- B: Keep it cluster-env-only — remove the stale "Per-workflow-overridable" comment and correct the docs so schema and docs agree.

**Answer**: A) Add `ciWaitTimeoutMs` to `WorkflowOverrideSchema` and resolve it per-workflow, mirroring `phaseTimeoutMs`/`maxRemediations` (spec default, Decision B). Rationale: `WorkerConfig` already carries the "Per-workflow-overridable" comment (config.ts:155); add one optional field beside `maxRemediations` to make the documented YAML valid.

### Q3: Remediate agent fallback when only `phases.review` is set
**Context**: Only relevant if Q1 = A (implement). An operator may set `phases.review` to a cheaper model without setting `phases.remediate`. The remediate phase writes code, so the fallback target changes cost/quality behavior.
**Question**: When `phases.remediate` is unset, what should the remediate executor fall back to?
**Options**:
- A: Fall back directly to the `implement` agent, ignoring `phases.review` for remediate (spec default — matches "fall back to `implement`").
- B: Fall back to the `phases.review` agent first, then `implement`.

**Answer**: A) Fall back directly to the `implement` agent, ignoring `phases.review` for remediate (spec default). Rationale: the remediate phase writes code, so inheriting a deliberately cheaper `phases.review` model would silently downgrade a code-writing phase (remediate-executor.ts:93-99).

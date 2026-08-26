# Feature Specification: Per-workflow/agent config keys parse but do not apply

**Branch**: `1160-severity-major-p1-several` | **Date**: 2026-08-21 | **Status**: Draft

## Summary

**Severity: major (P1).** Four configuration keys shipped by the engine-native review/remediate epic (generacy-ai/generacy#1120) parse cleanly — or are documented as usable — but are silently ignored at runtime. A silently-dropped config key is the worst kind of config surface: the operator sets it, sees no error, and gets none of the promised behavior. Each key must either take effect at its call site or be rejected loudly at parse time, and each must be pinned by a round-trip test that proves it changes runtime behavior for the workflow it names.

Confirmed against develop `155b3464`:

1. **`orchestrator.workflows.<name>.validateCommand`** — resolved by `resolveWorkflowOverrides` (`worker/config.ts:73`) but the phase loop reads `config.validateCommand` raw (`phase-loop.ts:~688`) and only diverges from it inside the `speckit-bugfix` branch via `resolveTargetedValidate`. For `speckit-feature` the per-workflow override is dropped — the migration guide's headline example (`review-remediate-migration.md:86-88`) does not work.
2. **`orchestrator.workflows.<name>.preValidateCommand`** — schema-valid (`template-schema.ts:100-107`) and resolved by `resolveWorkflowOverrides` (`worker/config.ts:74`) but has **zero** consumers: the install site reads `config.preValidateCommand` raw (`phase-loop.ts:654-656`).
3. **`orchestrator.agents...phases.review` (and `phases.remediate`) model/effort selection** — documented (`bugfix-profile-config.md:44-65`) but non-functional: `review-executor.ts:121-127` and `remediate-executor.ts:95` deliberately resolve the `implement` agent, and `cli-spawner` structurally excludes review/remediate. The documented cost knob (a cheaper model for bugfix review) is a silent no-op.
4. **`ciWaitTimeoutMs`** — documented as a per-workflow key (`review-remediate-migration.md:96-97`) but `WorkflowOverrideSchema` is `.strict()` without it, so the documented YAML **fails parsing**. It exists only as cluster-level env (`WORKER_CI_WAIT_TIMEOUT_MS`, `config/loader.ts:263-271`). The "Per-workflow-overridable" comment at `worker/config.ts:155` is stale plan text.

Filed from a post-merge code review of epic generacy-ai/generacy#1120. Part of follow-up epic generacy-ai/generacy#1153.

## User Stories

### US1: Per-workflow validate command applies to every workflow

**As a** cluster operator configuring a target repo,
**I want** `orchestrator.workflows.speckit-feature.validateCommand` to control the validate-phase command for feature jobs,
**So that** the migration guide's headline example actually changes what runs, instead of being silently ignored for `speckit-feature`.

**Acceptance Criteria**:
- [ ] A per-workflow `validateCommand` override set on `speckit-feature` is the command executed in the validate phase for a `speckit-feature` job.
- [ ] `speckit-bugfix` behavior (targeted-validate narrowing) is preserved: the per-workflow override is honored where present, and the existing `resolveTargetedValidate` narrowing still applies to the resolved command.
- [ ] The precedence chain (`workflows.<name>` → repo-level `validateCommand` → global default) is preserved.

### US2: Per-workflow pre-validate command applies

**As a** cluster operator,
**I want** `orchestrator.workflows.<name>.preValidateCommand` to control the pre-validate install step for that workflow,
**So that** a per-workflow install command (or an empty string to skip install) takes effect.

**Acceptance Criteria**:
- [ ] The pre-validate install step uses the resolved per-workflow `preValidateCommand` when set.
- [ ] An empty-string override skips the install step for that workflow.
- [ ] Repo-level and global fallbacks are preserved when no per-workflow value is set.

### US3: Documented review/remediate agent selection either works or is rejected

**As a** cluster operator wanting a cheaper model for bugfix review,
**I want** `orchestrator.agents...phases.review` (and `phases.remediate`) to either select the model/effort for those phases, or be rejected at parse time with a clear message,
**So that** I never believe I have configured a cost knob that does nothing.

**Acceptance Criteria**:
- [ ] Either: the review executor resolves the `review` agent (and remediate the `remediate` agent) when configured, falling back to the `implement` agent otherwise; OR the `phases.review`/`phases.remediate` keys are rejected loudly at parse time and the doc is corrected (tracked in the docs issue).
- [ ] Whichever resolution is chosen, no configuration path leaves the operator with a silently-ignored key.

### US4: `ciWaitTimeoutMs` per-workflow claim is made true or removed

**As a** cluster operator,
**I want** `ciWaitTimeoutMs` to either be accepted as a per-workflow override or clearly not be one,
**So that** the documented YAML parses, or fails with a clear message and correct docs.

**Acceptance Criteria**:
- [ ] Either: `ciWaitTimeoutMs` is added to `WorkflowOverrideSchema` and resolved per-workflow (mirroring `phaseTimeoutMs`/`maxRemediations`); OR the stale "Per-workflow-overridable" comment is removed and the docs/schema agree it is cluster-env only.
- [ ] The documented example either parses and takes effect, or is replaced with a correct example.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The validate phase MUST use the per-workflow-resolved `validateCommand` for all workflows, not just `speckit-bugfix`. | P1 | Wire `resolveWorkflowOverrides(...).validateCommand` into `effectiveValidateCommand` at `phase-loop.ts:~688`. |
| FR-002 | The `speckit-bugfix` targeted-validate narrowing MUST continue to apply on top of the resolved command. | P1 | Preserve `resolveTargetedValidate` behavior. |
| FR-003 | The pre-validate install step MUST use the per-workflow-resolved `preValidateCommand`. | P1 | Replace raw `config.preValidateCommand` at `phase-loop.ts:654`. |
| FR-004 | An empty-string `preValidateCommand` override MUST skip the install step. | P1 | Distinguish empty-string (skip) from unset (fall back). |
| FR-005 | `phases.review`/`phases.remediate` agent selection MUST be implemented at the executor call sites: resolve the `review`/`remediate` agent, falling back to the `implement` agent when unset. When `phases.remediate` is unset the fallback is directly `implement` (never `phases.review`). | P1 | Resolved (clarify Q1=A, Q3=A). Fix the `implement` literal at review-executor.ts:126 / remediate-executor.ts:98; no schema change. |
| FR-006 | `ciWaitTimeoutMs` MUST be a valid per-workflow override key, resolved per-workflow. | P1 | Resolved (clarify Q2=A). Add to `WorkflowOverrideSchema` beside `maxRemediations`; resolve in `resolveWorkflowOverrides`. |
| FR-007 | No configuration key named in this spec may be silently ignored: each MUST either change runtime behavior or be rejected at parse time. | P1 | Governing acceptance principle. |
| FR-008 | Each key MUST be covered by a config round-trip test proving it changes runtime behavior (or is rejected) for the workflow it names. | P1 | Per-key test is the acceptance gate. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Per-workflow `validateCommand` on `speckit-feature` changes the executed validate command. | Applies | Round-trip test asserts the resolved command reaches the spawn call for a `speckit-feature` job. |
| SC-002 | Per-workflow `preValidateCommand` changes the install step (including empty-string skip). | Applies | Round-trip test asserts the resolved command (or skip) at the install call site. |
| SC-003 | `phases.review`/`phases.remediate` selection either applies or is rejected at parse. | Applies or rejected | Test asserts either the resolved agent at the executor, or a parse-time rejection. |
| SC-004 | `ciWaitTimeoutMs` documented usage either parses+applies or is corrected. | Consistent | Test asserts schema acceptance+resolution, or asserts rejection with corrected docs/comment. |
| SC-005 | No config key in scope is silently dropped. | 0 silent drops | Per-key round-trip tests (FR-008) all pass. |

## Assumptions

- **Decision A (FR-005) — RESOLVED (clarify Q1 = A):** **Implement** per-phase agent selection for `review`/`remediate` — resolve the `review`/`remediate` agent, fall back to `implement`. `WorkflowAgentEntriesSchema.phases` already enumerates review/remediate and `resolveAgentForPhase` resolves per-phase with tier fallback; the executors merely pass the `implement` literal (review-executor.ts:126, remediate-executor.ts:98). Fix the literal — no schema change.
- **Decision A2 (FR-005) — RESOLVED (clarify Q3 = A):** When `phases.remediate` is unset, the remediate executor falls back **directly to the `implement` agent**, ignoring `phases.review`. The remediate phase writes code, so inheriting a deliberately cheaper `phases.review` model would silently downgrade a code-writing phase (remediate-executor.ts:93-99).
- **Decision B (FR-006) — RESOLVED (clarify Q2 = A):** **Add** `ciWaitTimeoutMs` to `WorkflowOverrideSchema` and resolve it per-workflow, mirroring `phaseTimeoutMs`/`maxRemediations`, making the documented YAML valid. `WorkerConfig` already carries the "Per-workflow-overridable" comment (config.ts:155); add one optional field beside `maxRemediations`.
- Doc reconciliation (migration guide, bugfix-profile-config) is tracked separately in the docs issue; this spec settles behavior, and docs follow.
- Existing precedence chains (`workflows.<name>` → repo-level → global/default) are the intended semantics for each key.

## Out of Scope

- Rewriting the docs pages beyond the minimal change needed to stop them contradicting shipped behavior (owned by the docs issue).
- Any change to review/remediate/CI-merge-gate runtime logic beyond agent selection and config resolution.
- New config keys not named in this spec.
- Changes to cluster-env-only handling of `WORKER_CI_WAIT_TIMEOUT_MS` beyond the per-workflow decision in FR-006.

---

*Generated by speckit*

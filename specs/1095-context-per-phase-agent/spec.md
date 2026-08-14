# Feature Specification: Per-phase agent effort configuration and fixer model/effort parity

**Branch**: `1095-context-per-phase-agent` | **Date**: 2026-08-14 | **Status**: Draft
**Issue**: [#1095](https://github.com/generacy-ai/generacy/issues/1095) | **Type**: `type:feature`

## Summary

Per-phase agent **model** selection already exists (#814/#815): `orchestrator.agents` in `.generacy/config.yaml` resolves `{provider, model}` per workflow/phase via `resolveAgentForPhase` (`packages/orchestrator/src/worker/config.ts`) and the claude-code launch plugin pushes `--model`. Three gaps prevent operators from fully controlling per-phase agent behavior:

1. **Reasoning effort has no representation anywhere** — no schema field, no flag or env var at spawn. Operators cannot express e.g. "plan on Fable at xhigh, implement on Opus at high".
2. **Two fixer paths ignore agent config entirely** — `validate-fix-handler` and `merge-conflict-handler` build intents with no `model` field (`ValidateFixIntent` / `MergeConflictIntent` in `packages/orchestrator/src/launcher/types.ts`), so they always run on the container CLI's ambient default even when the repo is fully configured. (`pr-feedback-handler` correctly resolves against the `implement` phase entry.)
3. **The CLI authoring schema doesn't know the `agents` block** — `packages/generacy/src/config/schema.ts` silently strips `orchestrator.agents` (and would strip `effort`), so `generacy validate` gives no feedback; the block is undocumented in `docs/docs/getting-started/configuration.md`.

This feature adds per-phase `effort` alongside `model`, plumbs both through the two ignored fixer paths, and wires the `agents` block through `generacy validate` + user-facing docs. It is behavior-preserving for any repo that does not opt in.

## User Stories

### US1: Operator configures per-phase effort alongside model

**As an** operator authoring `.generacy/config.yaml` for a workspace,
**I want** to specify a reasoning `effort` per phase (and per workflow) using the same shape as `model` — including workflow default, phase-specific overrides, and independent-field merging over cluster defaults,
**So that** I can express workflow-specific reasoning budgets (e.g. `plan: xhigh`, `implement: high`) without having to make model and effort move together.

**Acceptance Criteria**:
- [ ] `AgentEntrySchema` in `packages/config/src/template-schema.ts` accepts an optional `effort` field with the closed enum `low | medium | high | xhigh | max`.
- [ ] `resolveAgentForPhase` resolves `effort` via the same independent-field chain used for `model`: phase entry → workflow default → `agents.default` → unset.
- [ ] `mergeAgentEntry` merges `effort` field-by-field with repo-over-cluster precedence, matching how `model` merges today (setting `effort` in the repo does not force `model` to be re-specified, and vice versa).
- [ ] The example config in the issue (`plan: fable/xhigh`, `implement: opus/high`) validates and resolves as specified.

### US2: Fixer paths honor the same agent config as phase paths

**As an** operator with `orchestrator.agents.workflows.speckit-feature.phases.implement` set to a specific `{model, effort}`,
**I want** the two fixer paths that today bypass agent config (`validate-fix-handler` and `merge-conflict-handler`) to resolve `{provider, model, effort}` the same way `pr-feedback-handler` already does — bound to the `implement` phase entry,
**So that** fixer runs use my chosen model + effort, not the container CLI's ambient default, and the config is not silently ignored on those two paths.

**Acceptance Criteria**:
- [ ] `ValidateFixIntent` and `MergeConflictIntent` gain `provider`, `model`, `effort` fields (or the same shape `PrFeedbackIntent` carries today).
- [ ] `validate-fix-handler` and `merge-conflict-handler` call the shared resolution helper against the `implement` phase entry before building their intent.
- [ ] The two corresponding `build*Launch` builders and the claude-code launch plugin thread `model` and `effort` through to spawn argv/env identically to how the phase path does today.
- [ ] With no `agents` block configured, argv/env for both fixer paths is byte-identical to today.

### US3: Launch plugin translates `effort` into a real CLI mechanism

**As a** developer maintaining the claude-code launch plugin,
**I want** the plugin (`packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts`) to be the single site that translates `effort` into whatever the installed Claude CLI supports (flag, env var, or settings file),
**So that** orchestrator core stays provider-agnostic and future providers with different effort mechanisms can slot in without core changes.

**Acceptance Criteria**:
- [ ] The launch plugin, not orchestrator core, owns the translation of `effort` into a CLI-observable mechanism.
- [ ] The `/plan` phase includes a research task that determines the current CLI's supported mechanism for effort/reasoning-effort at the installed Claude Code version.
- [ ] If the CLI exposes no mechanism, `effort` is validated at the schema layer but is a no-op at spawn time; the limitation is documented; the field is wired end-to-end so a future CLI change is a plugin-only patch.

### US4: `generacy validate` accepts and type-checks the `agents` block

**As an** operator running `generacy validate` on my `.generacy/config.yaml`,
**I want** the CLI to accept the `orchestrator.agents` block (including `effort`) and surface schema errors on typos and out-of-range enum values,
**So that** authoring feedback matches the actual runtime resolution, not a silently-stripped subset.

**Acceptance Criteria**:
- [ ] `packages/generacy/src/config/schema.ts` accepts the `agents` block with the same shape as `AgentEntrySchema`, including `effort`.
- [ ] `generacy validate` rejects an unknown `effort` value (e.g. `super`) with a schema error naming the field.
- [ ] `generacy validate` rejects unknown keys inside `agents`, `workflows`, `phases`, or entries (no silent strip).
- [ ] `docs/docs/getting-started/configuration.md` documents the `agents` block with a worked example matching the issue's example config.
- [ ] `packages/generacy/examples/config-full.yaml` includes an `orchestrator.agents` example.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add optional `effort: low | medium | high | xhigh | max` to `AgentEntrySchema` in `packages/config/src/template-schema.ts`. | P1 | Closed enum; no default; unset stays unset. |
| FR-002 | Extend `resolveAgentForPhase` in `packages/orchestrator/src/worker/config.ts` so `effort` resolves via the same independent-field precedence chain as `model` (phase entry → workflow default → `agents.default` → unset). | P1 | Field-level, not entry-level, merging. |
| FR-003 | Extend `mergeAgentEntry` so `effort` merges field-by-field with repo-over-cluster precedence, independently of `model`. | P1 | Setting one field in the repo must not force the other. |
| FR-004 | Thread `effort` through `CliSpawnOptions` (`packages/orchestrator/src/worker/types.ts`) → `PhaseIntent` and `PrFeedbackIntent` (`packages/orchestrator/src/launcher/types.ts`) → the claude-code launch plugin. | P1 | Same shape as the existing `model` plumbing. |
| FR-005 | The claude-code launch plugin (`packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts`) — not orchestrator core — is the sole site that translates `effort` into a CLI mechanism (flag, env var, or settings). | P1 | Provider-specific; keep orchestrator core provider-agnostic. |
| FR-006 | The `/plan` phase includes a research task to determine the installed Claude CLI's supported mechanism for reasoning effort. If no mechanism exists, document the limitation and wire `effort` as a validated no-op ready for future CLI support. | P1 | No guessing at flag names; either it works or it's a validated no-op. |
| FR-007 | Extend `ValidateFixIntent` and `MergeConflictIntent` (`packages/orchestrator/src/launcher/types.ts`) with `provider`, `model`, `effort` fields, matching the shape `PrFeedbackIntent` already carries. | P1 | Fixer parity with pr-feedback-handler. |
| FR-008 | `validate-fix-handler` and `merge-conflict-handler` resolve `{provider, model, effort}` bound to the `implement` phase entry via the same shared helper `pr-feedback-handler` uses, then pass the resolved fields on their intents. When `merge-conflict-handler` runs against a PR with no resolvable `workflow:*`/`process:*` label, it mirrors `pr-feedback`'s precedent — `resolveWorkflowName` → `"unknown"`, then `resolveAgentForPhase("unknown", "implement")` degrades through `agents.default` tiers and, when nothing is configured, to the container CLI ambient default (per Q1). | P1 | Bind to `implement` — do not add a dedicated `prFeedback` or `validate` agent key (out of scope). No workflow-invented fallback. |
| FR-009 | Extend the corresponding `buildValidateFixLaunch` and `buildMergeConflictLaunch` builders to forward `model` and `effort` to the launch plugin identically to how the phase builder does. | P1 | End-to-end parity with the phase path. |
| FR-010 | With no `agents` block configured (or with `effort` unset), spawn argv/env for phase, pr-feedback, validate-fix, and merge-conflict paths must be byte-identical to today: no `--model`, no effort mechanism, no default injection. | P1 | Backward compat. Unset stays unset; never invent defaults. |
| FR-010a | When `effort` IS set in config but the launch plugin's research (FR-006) determined the current CLI has no delivery mechanism, the system MUST warn the operator at BOTH validate time and spawn time (per Q3): (a) `generacy validate` emits a warning naming `effort` and the unsupported provider; (b) the orchestrator logs a warning once per spawn when a set `effort` is dropped. Silent no-op is explicitly rejected — the two windows catch authoring-time mistakes and runtime CLI-version drift respectively. | P1 | Both warnings required; the CLI version can change on cluster restart independently of when validate last ran. |
| FR-011 | Add the `agents` block (including `effort`, workflow default, phase overrides) to the CLI authoring schema in `packages/generacy/src/config/schema.ts` so `generacy validate` accepts and type-checks it. Reject unknown keys and unknown enum values inside the block. Apply `.strict()` ONLY to the `orchestrator.agents` sub-tree and all its descendants (workflows, phases, entries) — per Q4. Preserve the existing strip-mode `z.object` semantics on every other node in the schema. | P1 | Silent-strip is the failure mode being fixed. Zero blast radius on configs outside the block. |
| FR-012 | Document the `agents` block with a worked example in `docs/docs/getting-started/configuration.md`. | P1 | Worked example must include per-workflow `default` and phase overrides for both `model` and `effort`. |
| FR-013 | Update `packages/generacy/examples/config-full.yaml` to include an `orchestrator.agents` example. | P2 | Example config must match the shape shown in `configuration.md`. |
| FR-014 | Do NOT add a dedicated `prFeedback` (or `validateFix` / `mergeConflict`) agent key decoupled from `implement`. The three fixer paths continue to bind to the `implement` phase entry. | P1 | Out of scope; explicitly deferred by the issue. |
| FR-015 | Do NOT wire the workflow-engine YAML system into the cluster path in this PR. | P1 | Out of scope; explicitly deferred by the issue. |
| FR-016 | Do NOT change phase sequences or gate behavior. | P1 | Out of scope; explicitly deferred by the issue. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | The issue's example config (`plan: fable/xhigh`, `implement: opus/high`) authored in `.generacy/config.yaml` passes `generacy validate`. | 0 errors | Run `generacy validate` against a repo containing the example config; exit 0. |
| SC-002 | `resolveAgentForPhase` returns `{ provider: 'claude-code', model: 'fable', effort: 'xhigh' }` for the `plan` phase and `{ provider: 'claude-code', model: 'opus', effort: 'high' }` for the `implement` phase against the example config. | Exact match | Unit test in `packages/orchestrator/src/worker/__tests__/config.test.ts` (or sibling). |
| SC-003 | The two fixer handlers (`validate-fix-handler`, `merge-conflict-handler`) spawn with `--model opus` (and the effort mechanism determined by FR-006) when `agents.workflows.speckit-feature.phases.implement = { model: opus, effort: high }`. | Both paths | Integration or unit tests that capture the resolved intent and assert the model / effort fields present. |
| SC-004 | With `agents` block absent, the recorded argv + env for all four spawn paths (phase, pr-feedback, validate-fix, merge-conflict) is byte-identical to the pre-change baseline. | 0 diff | Snapshot / golden-file test comparing argv + env slice before and after the change. |
| SC-005 | `generacy validate` rejects `effort: super` (invalid enum) with a schema error naming both `effort` and the invalid value. | 1 error, correct field | CLI test invoking `generacy validate` against a malformed fixture; assert exit code + error text. |
| SC-005a | When `effort` is set but the launch plugin's FR-006 research resolved to "no CLI mechanism", `generacy validate` emits a warning naming `effort` and the unsupported provider (FR-010a-a), AND the orchestrator emits a single per-spawn warning log line when the effort value is dropped at spawn time (FR-010a-b). | 2 warnings surfaced | CLI test asserts validate warning; integration/unit test captures orchestrator log line on a spawn with `effort` set. |
| SC-006 | `generacy validate` rejects unknown keys under `agents` / `workflows.*` / `phases.*` / entries (strict / no-passthrough). Configs with unknown keys OUTSIDE the `orchestrator.agents` sub-tree remain accepted (silently stripped) — per Q4's zero-blast-radius decision. | Rejected inside `agents`; accepted outside | CLI test with a typo fixture inside `agents` (e.g. `defualt:` instead of `default:`) asserting rejection; sibling test with a typo outside the block asserting acceptance. |
| SC-007 | `docs/docs/getting-started/configuration.md` contains a documented example of the `agents` block with `effort`. | 1+ occurrence | grep for `effort` inside a documented `orchestrator.agents` YAML block in the file. |
| SC-008 | `packages/generacy/examples/config-full.yaml` includes an `orchestrator.agents` block with `effort`. | 1+ occurrence | grep for `effort:` inside `orchestrator.agents.` scope in the example file. |
| SC-009 | The `/plan` phase's research task on CLI effort mechanism is answered in the plan artifact (either "the mechanism is X" or "no mechanism exists; wired as validated no-op"). | 1 answer recorded | Plan artifact contains a research decision on the effort delivery mechanism. |

## Assumptions

1. **`AgentEntrySchema` is the sole schema owning agent fields.** `packages/config/src/template-schema.ts` is the source of truth for the shape of an `AgentEntry`. **/plan** should verify by grep that no other schema declares agent entries; if there is a peer schema (e.g. cluster-side), the same field must be added there.
2. **`resolveAgentForPhase` uses field-level merging, not entry-level replacement.** Behaviors "setting only `effort` in the repo does not drop the cluster's `model`" and vice versa are already true for `model` today. **/plan** should confirm by reading `mergeAgentEntry` and adding a test if not already covered.
3. **`pr-feedback-handler`'s resolution helper is reusable.** The issue names `pr-feedback-handler` as the reference implementation for fixer paths. **/plan** should locate the shared helper it calls (or extract one if the resolution is inlined) so that all three fixer handlers use the same code path — not three parallel implementations.
4. **Fixer paths bind to `implement`.** No dedicated `prFeedback` / `validateFix` / `mergeConflict` agent key exists; all three fixer paths resolve against the `implement` phase entry of the workflow that owns them (`speckit-feature` for pr-feedback and validate-fix; `speckit-bugfix` also uses `implement`). Per Q1, `merge-conflict-handler` mirrors `pr-feedback`'s precedent (`resolveWorkflowName` → `"unknown"` when no `workflow:*`/`process:*` label exists) and then `resolveAgentForPhase("unknown", "implement")` degrades through `agents.default` tiers to the container CLI ambient default when nothing is configured — no workflow-invented fallback. Reference: `pr-feedback-monitor-service.ts:1069-1108`; `worker/config.ts:280-296`.
5. **The claude-code CLI is the only in-tree provider that needs the effort translation today.** No other provider plugin exists that would need to translate `effort` independently. **/plan** should confirm by listing provider launch plugins; if others exist, each needs its own translation (or documented no-op).
6. **The CLI's effort mechanism is unknown at spec time and requires research at /plan time.** The issue explicitly frames this as a research task with two branches: (a) mechanism exists → use it; (b) mechanism does not exist → validate the schema field, document the limitation, wire the field end-to-end as a no-op ready for future support. Do not guess at flag names.
7. **`generacy validate` strict-mode scope is deliberately narrow.** Per Q4, every existing object in `packages/generacy/src/config/schema.ts:25-225` is strip-mode `z.object`. `.strict()` is applied ONLY to the newly-added `orchestrator.agents` sub-tree and all its descendants (workflows, phases, entries). This yields zero blast radius on existing configs while catching nested typos (`efort`, `modle`, `defualt`) at every level of the new block. Any broader strict-mode change is out of scope.
8. **Backward compat is the load-bearing invariant.** SC-004 is the ship gate: any repo that has no `agents` block, or has `agents` set but leaves `effort` unset, must produce byte-identical spawn argv + env across all four paths. This is the mechanism that makes the change safe to deploy without opt-in.
9. **Changeset bump levels.** `AgentEntrySchema` gains a new optional field (`packages/config`) → **minor**. `packages/generacy` schema gains a new documented block → **minor**. `packages/orchestrator` gains new field plumbing but no new public exports → **patch**. `packages/generacy-plugin-claude-code` gains new effort translation logic — **minor** if a new spawn flag / env var / settings write is added, **patch** if it is a validated no-op. Verify at implement time per CLAUDE.md's changeset rules.
10. **Docs live in `docs/docs/getting-started/configuration.md`.** **/plan** should confirm the exact anchor within the file (existing `orchestrator.agents` section if one exists, or a new subsection under the orchestrator config heading).

## Out of Scope

- A dedicated `prFeedback` agent key decoupled from `implement`. All fixer paths continue to bind to the `implement` phase entry (issue explicitly defers this).
- Wiring the workflow-engine YAML system into the cluster path.
- Any change to phase sequences or gate behavior.
- Any change to how `provider` or `model` resolve today (this feature is additive: new `effort` field on the same resolution chain).
- Adding effort support to any non-Claude-Code provider plugin in this PR. If additional provider plugins exist, they get validated-no-op treatment matching FR-006 branch (b).
- Changes to `.generacy/config.yaml` runtime semantics beyond adding the `effort` field.
- Any change to `pr-feedback-handler`'s resolution logic — it is the reference implementation the two fixer handlers are being brought into parity with.

---

*Generated by speckit; enhanced from issue #1095*

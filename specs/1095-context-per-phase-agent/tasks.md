# Tasks: Per-phase agent effort configuration and fixer model/effort parity

**Input**: Design documents from `/specs/1095-context-per-phase-agent/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)

---

## Phase 1: Schema foundation

Establishes the `effort` enum, extends `AgentEntrySchema`, and applies `.strict()` on
`AgentEntrySchema` / `WorkflowAgentEntriesSchema` / `AgentsConfigSchema` per Q4 / D-2.
Every downstream task depends on this landing first because the type flows through
`@generacy-ai/config` → orchestrator → plugin → CLI.

- [ ] **T001** [US1] Add `EffortSchema = z.enum(['low','medium','high','xhigh','max'])` and export `Effort` type at the top of `packages/config/src/template-schema.ts`, co-located with `AgentEntrySchema` (per data-model.md § Effort enum).
- [ ] **T002** [US1] Extend `AgentEntrySchema` in `packages/config/src/template-schema.ts:14` with optional `effort: EffortSchema.optional()` field AND append `.strict()` to reject unknown keys inside an entry (FR-001, FR-011, D-2).
- [ ] **T003** [US4] Append `.strict()` to `WorkflowAgentEntriesSchema` in `packages/config/src/template-schema.ts:25` on BOTH the outer object AND the inner `phases` object (per data-model.md § WorkflowAgentEntries).
- [ ] **T004** [US4] Append `.strict()` to `AgentsConfigSchema` in `packages/config/src/template-schema.ts:54` on the top-level `{ default, workflows }` object only — `workflows` stays a `z.record` because arbitrary workflow names are legal (per data-model.md § AgentsConfig note).
- [ ] **T005** [P] [US1] Create `packages/config/tests/template-schema.test.ts` (new dir if needed). Assert: (a) valid `AgentEntry` with `effort: 'xhigh'` parses; (b) `effort: 'super'` throws a Zod error naming `effort` and the invalid value (SC-005); (c) unknown key `defualt:` under `agents:` throws (SC-006); (d) unknown key inside `phases:` throws (`implment:`); (e) unknown key inside an entry throws (`efort:`).

---

## Phase 2: Resolver + merge extension
<!-- Depends on Phase 1: uses the extended AgentEntrySchema type. -->

Extends `mergeAgentEntry` for field-by-field `effort` merging and adds `effort` to the
resolver's return tuple. Downstream intent + spawn plumbing depends on this.

- [ ] **T006** [US1] Extend `mergeAgentEntry` in `packages/orchestrator/src/worker/config.ts:165-179` so `effort` merges field-by-field with repo-over-cluster precedence, independent of `model` and `provider` (FR-003). Setting only `effort` in the repo must NOT drop the cluster's `model` (and vice versa).
- [ ] **T007** [US1] Extend `resolveAgentForPhase` in `packages/orchestrator/src/worker/config.ts:280-295`: widen return type to `{ provider: string; model?: string; effort?: Effort }`, add the fourth independent-field walk `const effort = tiers.find((t) => t?.effort !== undefined)?.effort;`, and conditionally attach `effort` on the returned object (FR-002; per data-model.md § resolveAgentForPhase).
- [ ] **T008** [P] [US1] Create `packages/orchestrator/src/worker/__tests__/resolve-agent-for-phase.test.ts` with the SC-002 golden test: authoring `agents.workflows.speckit-feature.phases = { plan: { model: 'fable', effort: 'xhigh' }, implement: { model: 'opus-4-7', effort: 'high' } }` returns `{ provider: 'claude-code', model: 'fable', effort: 'xhigh' }` for `plan` and `{ provider: 'claude-code', model: 'opus-4-7', effort: 'high' }` for `implement`. Add sibling test for field-independence: setting only `effort` in repo preserves cluster's `model` (FR-003).

---

## Phase 3: Intent + spawn-option widening
<!-- Depends on Phase 2: needs the resolver's new return shape. -->

Threads the resolved `effort` down through orchestrator types. No behavior change yet
(builders still ignore `effort`) — this is pure type widening so callers can attach.

- [ ] **T009** [US1] Extend `CliSpawnOptions` in `packages/orchestrator/src/worker/types.ts:220-255` with optional `effort?: Effort` (import `Effort` from `@generacy-ai/config`). Note per data-model.md: do NOT add `previousEffort`.
- [ ] **T010** [US1] Extend `PhaseIntent` in `packages/orchestrator/src/launcher/types.ts:31-41` with optional `effort?: Effort`.
- [ ] **T011** [US2] Extend `PrFeedbackIntent` in `packages/orchestrator/src/launcher/types.ts:46-54` with optional `effort?: Effort`.
- [ ] **T012** [US2] Extend `ValidateFixIntent` in `packages/orchestrator/src/launcher/types.ts:61-69` with optional `provider?: string`, `model?: string`, `effort?: Effort` (matching `PrFeedbackIntent` shape; per FR-007 + data-model.md note).
- [ ] **T013** [US2] Extend `MergeConflictIntent` in `packages/orchestrator/src/launcher/types.ts:75-81` with optional `provider?: string`, `model?: string`, `effort?: Effort` (same shape as ValidateFixIntent).

---

## Phase 4: Launch plugin — argv translation + capability probe
<!-- Depends on Phase 3: reads Effort field from all four intent kinds. -->

Owns the effort→CLI translation (FR-005). `--effort <level>` is a first-class flag on
Claude CLI v2.1.150 (research.md § Decision 1). Also exposes the capability probe used
by both warning surfaces per FR-010a / D-5.

- [ ] **T014** [US3] Add public static method `hasEffortMechanism(): boolean` (or exported const `HAS_EFFORT_MECHANISM = true`) to `ClaudeCodeLaunchPlugin` in `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts`. Under CLI v2.1.150 returns `true`. Add JSDoc noting the flip when a future release removes `--effort` (per D-5, data-model.md § ClaudeCodeLaunchPlugin).
- [ ] **T015** [US3] Add `if (intent.effort) args.push('--effort', intent.effort);` immediately after the existing `--model` push in `buildPhaseLaunch` at `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts:80`.
- [ ] **T016** [US3] Add the same `--effort` push in `buildPrFeedbackLaunch` at `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts:106`.
- [ ] **T017** [US3] Add the same `--effort` push in `buildValidateFixLaunch` at `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts:127`, alongside a new `--model` push if not already present (parity with the phase builder).
- [ ] **T018** [US3] Add the same `--effort` push in `buildMergeConflictLaunch` at `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts:146`, alongside a new `--model` push if not already present.
- [ ] **T019** [P] [US3] Create/extend `packages/generacy-plugin-claude-code/src/launch/__tests__/claude-code-launch-plugin.test.ts` with (a) SC-004 inline-snapshot goldens per intent kind (`phase`, `pr-feedback`, `validate-fix`, `merge-conflict`) with `model` and `effort` unset — argv must be byte-identical to pre-change (per D-8); (b) per-kind `--effort` append test with `effort: 'xhigh'`; (c) `hasEffortMechanism()` returns `true`.

---

## Phase 5: Fixer handler resolution
<!-- Depends on Phase 4: intents now carry effort, and builders honour it. -->

Brings `validate-fix-handler` and `merge-conflict-handler` into parity with
`pr-feedback-handler`'s reference resolution at
`packages/orchestrator/src/worker/pr-feedback-handler.ts:860`. Do NOT touch pr-feedback
resolution logic — it is the reference.

- [ ] **T020** [US1] Thread `effort` through `phase-loop.ts` and `cli-spawner.ts` so the phase spawn path unpacks `resolveAgentForPhase(...).effort` from the resolver and attaches it to `CliSpawnOptions.effort` and downstream `PhaseIntent.effort`. Files: `packages/orchestrator/src/worker/phase-loop.ts`, `packages/orchestrator/src/worker/cli-spawner.ts`.
- [ ] **T021** [US2] Thread `effort` through `pr-feedback-handler.ts` — unpack `effort` from the existing `resolveAgentForPhase(...)` call at `packages/orchestrator/src/worker/pr-feedback-handler.ts:860` and attach to `PrFeedbackIntent.effort`. This is the reference-implementation extension; resolution logic itself remains unchanged.
- [ ] **T022** [US2] Add `resolveAgentForPhase(this.config, workflowName, 'implement')` call to `packages/orchestrator/src/worker/validate-fix-handler.ts`. Per D-3a / D-4, extend the handler's public method signature (NOT the constructor) with a new `workflowName: string` parameter, threaded from the phase-loop caller (which has `item.workflowName` in scope). Attach the resolved `{ provider, model, effort }` to `ValidateFixIntent` and to the outbound `LaunchRequest.provider` (matching pr-feedback-handler.ts:879 pattern).
- [ ] **T023** [US2] Add `resolveAgentForPhase(this.config, item.workflowName, 'implement')` call to `packages/orchestrator/src/worker/merge-conflict-handler.ts`. Per D-3b, `item.workflowName` is already available in scope. Attach the resolved `{ provider, model, effort }` to `MergeConflictIntent` and to the outbound `LaunchRequest.provider`. When `workflowName === "unknown"` (no `workflow:*`/`process:*` label), the resolver naturally degrades through `agents.default` tiers to the container CLI ambient default per FR-008 + Q1.
- [ ] **T024** [P] [US2] Create `packages/orchestrator/src/worker/__tests__/validate-fix-handler.test.ts` asserting SC-003: with `agents.workflows.speckit-feature.phases.implement = { model: 'opus-4-7', effort: 'high' }`, the intent captured by a mocked `AgentLauncher` carries `model: 'opus-4-7'` and `effort: 'high'`. Sibling test: with no `agents` block, intent has no `model` and no `effort` (feeds SC-004 baseline invariant).
- [ ] **T025** [P] [US2] Create `packages/orchestrator/src/worker/__tests__/merge-conflict-handler.test.ts` with the same shape as T024 — including a case where `item.workflowName` is missing/unknown so the resolver degrades cleanly to the CLI ambient default (FR-008, contracts/fixer-handler-resolution.md).

---

## Phase 6: CLI schema + validate warnings + docs
<!-- Depends on Phases 1-5: schemas + capability probe both must exist. -->

The CLI schema re-exports from `@generacy-ai/config` so Phase 1's `.strict()` flows through transparently. This phase surfaces the validate-time warning channel per D-6 and adds the required docs / examples.

- [ ] **T026** [US4] Verify `packages/generacy/src/config/schema.ts:2-14` re-exports `AgentsConfigSchema` (and by transitivity `WorkflowAgentEntriesSchema`, `AgentEntrySchema`, `EffortSchema`) from `@generacy-ai/config`. No code change expected — this is a verification step. Add a re-export line for `EffortSchema` if absent.
- [ ] **T027** [US4] Widen `loadConfig` in `packages/generacy/src/config/loader.ts` to return `{ config, warnings: string[] }` (per D-6 + data-model.md § Warning payload). Add a wrapper `loadConfigWithWarnings` if the existing `loadConfig` shape must be preserved for backward-compat callers. New warning: when any resolved `AgentEntry.effort` is set AND the plugin's `hasEffortMechanism()` returns `false`, emit `orchestrator.agents.workflows.${name}.phases.${phase}.effort — set to '${value}' but provider '${provider}' has no CLI mechanism for effort in this release. The field will be dropped at spawn time.` (FR-010a-a).
- [ ] **T028** [US4] Add a small helper `packages/generacy/src/config/effort-mechanism-probe.ts` per D-5 that imports the plugin's `hasEffortMechanism` and exposes a per-provider registry (currently `{ 'claude-code': ClaudeCodeLaunchPlugin.hasEffortMechanism }`). Used by T027's warning path.
- [ ] **T029** [US4] Extend `packages/generacy/src/cli/commands/validate.ts:189-193` (validate handler) to print warnings after `displayConfigSummary` in text mode, and add a `warnings: []` array field in JSON output. Exit code stays 0 on warnings-only; only errors exit 1 (per D-6).
- [ ] **T030** [US2] Emit a per-spawn `warn`-level pino log line when an intent carries `effort` but the resolved plugin's `hasEffortMechanism()` returns `false` (FR-010a-b). Structured payload: `{ workflow, phase, provider, effort, reason: 'no-cli-mechanism' }`. Site: orchestrator worker spawn path — closest neutral site is `cli-spawner.ts` after resolving the plugin but before invoking `AgentLauncher.launch`. Once per spawn — do not spam.
- [ ] **T031** [P] [US4] Create fixtures under `packages/generacy/src/config/__tests__/fixtures/` (per D-7): (a) `valid-with-agents-effort.yaml` (SC-002 shape); (b) `invalid-effort-enum.yaml` (`effort: super`); (c) `invalid-agents-typo.yaml` (`defualt:` under `agents:` OR `efort:` inside an entry); (d) `valid-outside-block-typo.yaml` (typo at root or under `defaults:` — must still be accepted, proving zero blast radius per Q4).
- [ ] **T032** [P] [US4] Extend `packages/generacy/src/config/__tests__/loader.test.ts` to load each fixture from T031 and assert: (a) valid fixture returns 0 warnings, 0 errors, and resolves fable/xhigh + opus/high; (b) invalid-effort-enum returns an error naming `effort` and `super` (SC-005); (c) invalid-agents-typo returns an error naming the typo path (SC-006); (d) valid-outside-block-typo is accepted (SC-006 sibling).
- [ ] **T033** [P] [US4] Create `packages/generacy/src/cli/__tests__/validate.test.ts` asserting SC-005a: with a stubbed `hasEffortMechanism()` returning `false` AND a config carrying `effort: 'high'`, `generacy validate` exits 0 AND prints exactly one warning line naming `effort` and the provider `claude-code`.
- [ ] **T034** [US4] Add an "Orchestrator Agent Selection" subsection to `docs/docs/getting-started/configuration.md` after line 107 (before `## .generacy/generacy.env`), containing a worked YAML example matching the quickstart shape: repo-wide `default`, `workflows.speckit-feature.default`, and `workflows.speckit-feature.phases.{plan,implement}` overrides for both `model` and `effort` (FR-012, SC-007).
- [ ] **T035** [US4] Add an `orchestrator.agents` example to `packages/generacy/examples/config-full.yaml` including `effort:` (FR-013, SC-008). Shape must match the `configuration.md` example added in T034.

---

## Phase 7: Verification + changeset
<!-- Depends on all prior phases. Ship gate. -->

- [ ] **T036** [US1] Add a `.changeset/1095-context-per-phase-agent.md` file with per-package bumps: `@generacy-ai/config` **minor** (new optional schema field), `@generacy-ai/orchestrator` **patch** (internal plumbing, no new exports), `@generacy-ai/generacy-plugin-claude-code` **minor** (new spawn flag + public `hasEffortMechanism()` API), `@generacy-ai/generacy` **minor** (new documented block + validate warnings channel). Verify at implement time via `pnpm changeset status` (per CLAUDE.md changeset rules).
- [ ] **T037** [US1] Run the full test suite (`pnpm test` in each affected package or repo-root). Confirm all SC targets satisfied — SC-001 through SC-009 — and that SC-004 argv-baseline snapshots produced 0 diff for the four intent kinds when `model`/`effort` are unset.
- [ ] **T038** [US1] Execute `specs/1095-context-per-phase-agent/quickstart.md` end-to-end against a scratch project: author the example config, run `generacy validate` (expect 0 errors, 0 warnings under v2.1.150), and confirm the resolved intent shape matches the quickstart expected output for both `plan` and `implement`.

---

## Dependencies & Execution Order

**Sequential phase boundaries** (must complete in order):
- Phase 1 (schema foundation) → Phase 2 (resolver) → Phase 3 (intent widening) → Phase 4 (plugin argv) → Phase 5 (fixer resolution) → Phase 6 (CLI + docs) → Phase 7 (verification).

**Parallel opportunities within phases** (`[P]` markers):
- **Phase 1**: T005 (tests) parallel with any of T001-T004 once T002 has landed.
- **Phase 2**: T008 (SC-002 test) parallel with any downstream phase after T007 lands.
- **Phase 3**: T010, T011, T012, T013 all touch the same file (`launcher/types.ts`) — must be **serial** despite each being additive. T009 (`worker/types.ts`) is a different file and can run parallel.
- **Phase 4**: T015-T018 all touch the same builder file — serial. T014 (adding `hasEffortMechanism`) can run in parallel with T015. T019 (tests) parallel with all subsequent phases once T014-T018 land.
- **Phase 5**: T024 and T025 (handler tests) parallel with each other and with Phase 6 work once T022/T023 land.
- **Phase 6**: T031, T032, T033 parallel with each other. T034 and T035 (docs + example) parallel with each other and with test tasks.

**Critical single-file bottlenecks**:
- `packages/orchestrator/src/launcher/types.ts` — T010, T011, T012, T013 all touch it. Serial.
- `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts` — T014-T018 all touch it. Serial.
- `packages/config/src/template-schema.ts` — T001, T002, T003, T004 all touch it. Serial.

**Load-bearing checkpoints**:
- After Phase 1: no downstream compiles without the `Effort` type export.
- After Phase 4: SC-004 baseline snapshots (T019) MUST show zero diff for the four intent kinds with `effort`/`model` unset. This is the backward-compat ship gate.
- Before Phase 7 merge: `.changeset/1095-context-per-phase-agent.md` must exist and pass the CI gate defined in `.github/workflows/changeset-bot.yml`.

## Ship gate

- [ ] SC-001: quickstart config validates with 0 errors.
- [ ] SC-002: resolver returns fable/xhigh for plan, opus/high for implement.
- [ ] SC-003: both fixer handlers spawn with model + effort under the example config.
- [ ] SC-004: argv byte-identical to today when `agents` block is absent (all 4 paths).
- [ ] SC-005: `effort: super` rejected with schema error naming both `effort` and `super`.
- [ ] SC-005a: both warning surfaces fire when `hasEffortMechanism()` is `false` and `effort` is set.
- [ ] SC-006: typos inside `agents` sub-tree rejected; typos outside still accepted.
- [ ] SC-007: `configuration.md` documents the block with `effort`.
- [ ] SC-008: `examples/config-full.yaml` shows `orchestrator.agents.*.effort`.
- [ ] SC-009: research decision on effort mechanism recorded (see research.md § Decision 1).

## Suggested next step

Run `/speckit:implement` to begin execution.

# Tasks: Multi-Agent Phase 1b — Config Surface + Per-Phase Model Threading

**Input**: Design documents from `/specs/814-context-part-multi-agent/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 — the whole feature is a single-story config-threading change

## Phase 1: Schema Foundation (source-of-truth types)

- [X] T001 [US1] Add `AgentEntrySchema`, `WorkflowAgentEntriesSchema`, `AgentsConfigSchema` (+ inferred type exports `AgentEntry`, `WorkflowAgentEntries`, `AgentsConfig`) and extend `OrchestratorSettingsSchema` with `agents: AgentsConfigSchema.optional()` in `packages/config/src/template-schema.ts` per data-model.md §1. Phase enum in `WorkflowAgentEntriesSchema.phases` MUST enumerate `specify | clarify | plan | tasks | implement | validate` per-field (Q5→A closed set).
- [X] T002 [P] [US1] Mirror the schema in `packages/generacy/src/config/schema.ts` per data-model.md §2 — re-export the three schemas + types from `@generacy-ai/config` (do NOT redefine), then add `agents: AgentsConfigSchema.optional()` to the CLI-facing `OrchestratorSettingsSchema`.
- [X] T003 [P] [US1] Document the block in `packages/generacy/examples/config-full.yaml` — add a commented `orchestrator.agents:` example covering `default`, `workflows.speckit-feature.default`, and `workflows.speckit-feature.phases.implement` tiers, showing partial (provider-only and model-only) entries per D-9.
- [X] T004 [P] [US1] Add a single-line pointer comment in `packages/generacy/examples/config-multi-repo.yaml` referencing `config-full.yaml` for the `agents` block (per D-9). Do NOT touch `config-minimal.yaml` or `config-single-repo.yaml`.

## Phase 2: Worker Config, Resolver, and Env Plumbing

<!-- Phase boundary: Complete Phase 1 before starting Phase 2 -->

- [X] T005 [US1] Extend `WorkerConfigSchema` in `packages/orchestrator/src/worker/config.ts` per data-model.md §3: add `agents: AgentsConfigSchema.optional()` and `defaultsAgent: z.string().min(1).optional()`. Import `AgentsConfigSchema` from `@generacy-ai/config`.
- [X] T006 [US1] Implement `applyRepoAgentOverrides(config, settings)` in `packages/orchestrator/src/worker/config.ts` per data-model.md §5 / research.md D-3 — sibling of `applyRepoValidateOverrides`, pure function, field-by-field deep merge (target-repo overlays cluster-default, partial `{provider,model}` entries preserve missing sibling fields, workflow names not in cluster default pass through).
- [X] T007 [US1] Implement `resolveAgentForPhase(config, workflowName, phase)` in `packages/orchestrator/src/worker/config.ts` per data-model.md §6 and research.md D-5. Independent walks for provider and model over tiers `phases.<phase>` → `workflows.<name>.default` → `agents.default`. Provider walk falls back to `config.defaultsAgent` then built-in `DEFAULT_PROVIDER = 'claude-code'`. Model walk terminates at tier 3 returning `undefined`. Signature: `(config: WorkerConfig, workflowName: string, phase: WorkflowPhase) => { provider: string; model?: string }`.
- [X] T008 [P] [US1] Add `WORKER_AGENT_PROVIDER` / `WORKER_AGENT_MODEL` env plumbing in `packages/orchestrator/src/config/loader.ts` per data-model.md §4 / research.md D-4 (~line 245, after credential-role env). Each written independently to `config.worker.agents.default.{provider,model}` — no paired guard. Support the `ORCHESTRATOR_` prefix alias.
- [X] T009 [P] [US1] Add `tryLoadDefaultsAgent(configPath)` sibling helper to `packages/orchestrator/src/config/loader.ts` (mirror `tryLoadDefaultsRole` at ~loader.ts:249) and write the result to `config.worker.defaultsAgent`.

## Phase 3: Threading Types + Plugin argv

<!-- Phase boundary: Complete Phase 2 before starting Phase 3 -->

- [X] T010 [US1] Extend `CliSpawnOptions` in `packages/orchestrator/src/worker/types.ts` per data-model.md §8: add `provider?: string`, `model?: string`, `previousModel?: string` fields with JSDoc explaining `previousModel` only matters when `resumeSessionId` is also set.
- [X] T011 [US1] Thread the new options in `packages/orchestrator/src/worker/cli-spawner.ts` `spawnPhase`: copy `options.provider` into `LaunchRequest.provider` and `options.model` into `PhaseIntent.model` per research.md D-8. Keep `cli-spawner` mechanical — do NOT emit the `agent.model.transition` log line here (that lives in phase-loop per D-7).
- [X] T012 [P] [US1] Modify `ClaudeCodeLaunchPlugin.buildPhaseLaunch` in `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts` to conditionally push `'--model', intent.model` when `intent.model` is set. Position per research.md D-8: immediately after `--verbose`, before `--resume <sessionId>` and the prompt payload — mirrors `buildConversationTurnLaunch`'s existing pattern.
- [X] T013 [P] [US1] Modify `ClaudeCodeLaunchPlugin.buildPrFeedbackLaunch` in the same file to push `'--model', intent.model` when set. Position: after `--verbose`, before the prompt payload (index 4 per research.md D-8).

## Phase 4: Phase-Loop Wiring + pr-feedback Binding

<!-- Phase boundary: Complete Phase 3 before starting Phase 4 -->

- [X] T014 [US1] Wire `applyRepoAgentOverrides` at the effective-config computation site in `packages/orchestrator/src/worker/claude-cli-worker.ts` (~line 479): `const effectiveConfig = applyRepoAgentOverrides(applyRepoValidateOverrides(this.config, orchSettings), orchSettings)` per research.md D-3.
- [X] T015 [US1] Add `currentProvider: string | undefined` and `currentModel: string | undefined` closure state to `executeLoop` in `packages/orchestrator/src/worker/phase-loop.ts` per data-model.md §9. Per phase, before spawn: call `resolveAgentForPhase(effectiveConfig, item.workflowName, cliPhase)`, drop `currentSessionId` when `currentProvider !== undefined && currentProvider !== nextProvider` (FR-011), thread `{provider, model, previousModel, resumeSessionId}` into the spawner, then update `currentProvider = nextProvider; currentModel = nextModel;` post-spawn.
- [X] T016 [US1] In `packages/orchestrator/src/worker/phase-loop.ts` right after the resolver call, emit `logger.info({ provider: nextProvider, prevModel: currentModel, nextModel }, 'agent.model.transition')` when `currentProvider === nextProvider && currentModel !== undefined && nextModel !== undefined && currentModel !== nextModel` (Q2→C / data-model.md §10).
- [X] T017 [US1] Bind pr-feedback to the `implement` phase in `packages/orchestrator/src/worker/pr-feedback-handler.ts` `spawnClaudeForFeedback` (~line 464): call `resolveAgentForPhase(this.config, item.workflowName, 'implement')` and thread the result into `LaunchRequest.provider` + `PrFeedbackIntent.model` per research.md D-6 / Q1→B. No new schema surface.

## Phase 5: Tests

<!-- Phase boundary: Complete Phase 4 before starting Phase 5. Tests within Phase 5 may run in parallel. -->

- [X] T018 [P] [US1] NEW test `packages/orchestrator/src/worker/__tests__/resolve-agent-for-phase.test.ts` — precedence chain coverage per plan.md Acceptance Gate #1. Cover: (a) `phases.<phase>` wins over `workflows.<name>.default` wins over `agents.default`; (b) independent provider/model walks — phase override sets only `model`, provider resolves from a lower tier; (c) `defaults.agent` supplies provider when no `agents.*` tier does; (d) env-tier folding via loader-injected `agents.default`; (e) built-in `claude-code` fallback when nothing configured; (f) model returns `undefined` when no tier sets it.
- [X] T019 [P] [US1] NEW test `packages/orchestrator/src/worker/__tests__/phase-loop-provider-switch.test.ts` — provider-switch session-drop + model-preserve per plan.md Acceptance Gate #4. Use the fake `test-agent` `AgentLaunchPlugin` harness established in #813 (`packages/orchestrator/src/launcher/__tests__/multi-provider.test.ts`) per research.md D-10. Assert: (a) provider switch clears `currentSessionId` before next spawn; (b) same-provider model change preserves `currentSessionId` and emits `agent.model.transition` log line with correct `prevModel`/`nextModel`; (c) same-provider same-model preserves session and does NOT emit the log.
- [X] T020 [P] [US1] NEW/MODIFIED test `packages/orchestrator/src/worker/__tests__/cli-spawner-model-argv.test.ts` — argv snapshot per plan.md Acceptance Gate #2 & #3. Cover: (a) fixture config with `phases.implement.model='sonnet-4-6'` produces `--model sonnet-4-6` in phase argv at the correct position (immediately after `--verbose`, before `--resume` / prompt); (b) no-config parity snapshot — `--model` absent when `agents` block is unset everywhere (byte-identical to pre-change baseline).
- [X] T021 [P] [US1] MODIFY test `packages/generacy-plugin-claude-code/src/launch/__tests__/claude-code-launch-plugin.test.ts` — add snapshots for `buildPhaseLaunch` and `buildPrFeedbackLaunch` with `intent.model` set. Verify `--model` argv position matches the conversation-turn precedent (after `--verbose`, before `--resume` for phase; after `--verbose`, before prompt for pr-feedback).
- [X] T022 [P] [US1] Add a pr-feedback-specific test (in the same file as T021 or as a sub-case of T019/T020) that fixture-configures `phases.implement.model='opus-4-7'` and asserts the pr-feedback argv snapshot picks up `--model opus-4-7` per plan.md Acceptance Gate #6 (Q1→B).
- [X] T023 [P] [US1] Add an unknown-provider negative test (extend T019 or a sibling file) proving the phase-loop's `spawn-error` catch surfaces `UnknownProviderError` (from #813 `AgentLauncher.launch()`) via the stage-comment error path when `phases.implement.provider='does-not-exist'` is configured. No silent fallback to Claude. Per plan.md Acceptance Gate #5.

## Dependencies & Execution Order

**Sequential dependencies (phase boundaries)**:
- Phase 1 (schemas) blocks Phase 2 — worker/loader import from `@generacy-ai/config`.
- Phase 2 (`resolveAgentForPhase` + env plumbing) blocks Phase 3 — spawner/plugin need the resolver's shape.
- Phase 3 (types + plugin argv) blocks Phase 4 — phase-loop threads `CliSpawnOptions.model` into the spawner.
- Phase 4 (wiring) blocks Phase 5 — tests need the real wiring to exercise.

**Intra-phase parallelization**:
- **Phase 1**: T002 / T003 / T004 all `[P]` — different files, both depend only on T001 landing the source-of-truth types.
- **Phase 2**: T008 / T009 `[P]` — different regions of `loader.ts`, no ordering constraint. T005 → T006 → T007 sequential within `worker/config.ts`.
- **Phase 3**: T012 / T013 `[P]` — same file (`claude-code-launch-plugin.ts`) but different functions (`buildPhaseLaunch` vs `buildPrFeedbackLaunch`); mark parallel but note the file collision — if one agent handles both, merge sequentially.
- **Phase 4**: T014 → T015 → T016 sequential (all touch phase-loop / worker call site). T017 `[P]` with any of them (`pr-feedback-handler.ts` is a separate file).
- **Phase 5**: T018 / T019 / T020 / T021 / T022 / T023 all `[P]` — separate test files (or independent test cases in the same file).

**No-config parity invariant** (call it out to every implementer): every argv snapshot must remain byte-identical when the `agents` block is absent from every tier. `--model` only appears when someone explicitly configures it. T020(b) is the load-bearing test.

---

*Generated by speckit — 23 tasks, 5 phases, single-story*

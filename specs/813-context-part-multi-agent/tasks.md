# Tasks: Multi-Agent Provider — Phase 1, Issue 1 (Launcher Registry)

**Input**: Design documents from `/specs/813-context-part-multi-agent/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Single-story feature — omitted (all tasks map to the launcher-registry widening)

## Phase 1: Constants & Errors (new files, no dependents yet)

- [X] T001 [P] Create `packages/orchestrator/src/launcher/constants.ts` with `SYSTEM_PROVIDER = 'system'` and `DEFAULT_PROVIDER = 'claude-code'` as `const` assertions. Neither symbol will be re-exported from the launcher `index.ts` — enforced by test in T017.
- [X] T002 [P] Create `packages/orchestrator/src/launcher/errors.ts` with `UnknownProviderError` and `DuplicatePluginRegistrationError` classes per `contracts/registry-contract.md` and `contracts/dispatch-contract.md`. Both classes: `readonly name`, explicit `readonly` fields (`provider`, `kind`, and either `availableProviders` or `existingPluginId`), message text as specified in `data-model.md` §5.

## Phase 2: Move intent types into orchestrator core

- [X] T003 Move all six agent intents (`PhaseIntent`, `PrFeedbackIntent`, `ValidateFixIntent`, `MergeConflictIntent`, `ConversationTurnIntent`, `InvokeIntent`) from `packages/generacy-plugin-claude-code/src/launch/types.ts` into `packages/orchestrator/src/launcher/types.ts`. Add optional `model?: string` to `PhaseIntent` and `PrFeedbackIntent` (data-model §2.1–2.2). Widen the `LaunchIntent` union in `types.ts` to include all six new intents. Remove the `import type { ClaudeCodeIntent } from '@generacy-ai/generacy-plugin-claude-code'` line at the top of `types.ts` (spec AC #5).
- [X] T004 Add `provider?: string` to `LaunchRequest` in `packages/orchestrator/src/launcher/types.ts` (data-model §3). Add `readonly provider: string` to the `AgentLaunchPlugin` interface (data-model §4).
- [X] T005 Delete `packages/generacy-plugin-claude-code/src/launch/types.ts`. Update `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts` to `import type { ClaudeCodeIntent, PhaseIntent, PrFeedbackIntent, ValidateFixIntent, MergeConflictIntent, ConversationTurnIntent, InvokeIntent } from '@generacy-ai/orchestrator/launcher/types'` (types-only). Note: `ClaudeCodeIntent` name is deleted from orchestrator core per intent-types-contract §Ownership — if the plugin still needs the union alias internally, define it locally (or use `LaunchIntent`).
- [X] T006 Update `packages/generacy-plugin-claude-code/src/index.ts` to re-export the six intent types from `@generacy-ai/orchestrator/launcher/types` instead of `./launch/types.js` (intent-types-contract §Downstream re-exports). Drop the `ClaudeCodeIntent` re-export line (alias no longer exists in orchestrator core).

## Phase 3: Wire `provider` onto plugins

- [X] T007 Add `readonly provider = 'claude-code'` to `ClaudeCodeLaunchPlugin` in `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts`. No change to `pluginId`, `supportedKinds`, or `buildLaunch` behavior.
- [X] T008 Add `readonly provider = SYSTEM_PROVIDER` to `GenericSubprocessPlugin` in `packages/orchestrator/src/launcher/generic-subprocess-plugin.ts`, importing the constant from `./constants.js`.

## Phase 4: Re-key the registry + typed errors + default fallback

- [X] T009 Rewrite `packages/orchestrator/src/launcher/agent-launcher.ts` per contracts:
  - Rename `kindToPlugin` → `registry` (`Map<string, AgentLaunchPlugin>`), keys composed as `${provider}:${kind}`.
  - `registerPlugin`: for each `kind` in `plugin.supportedKinds`, throw `DuplicatePluginRegistrationError(plugin.provider, kind, existing.pluginId)` on duplicate key (registry-contract §Behavior). Validate `plugin.provider` is a non-empty string (plain `Error` on empty).
  - `launch`: resolve `provider = request.provider ?? DEFAULT_PROVIDER` once at top (research D-9). Compose `${provider}:${intent.kind}` key. If miss: apply the fallback in dispatch-contract §Resolution step 4b — if `provider === DEFAULT_PROVIDER` and `registry.has(${SYSTEM_PROVIDER}:${intent.kind})`, use that plugin. Otherwise apply the classification scan (step 5): keys with prefix `${provider}:` → plain `Error` (unknown kind for known provider, message per dispatch-contract); else → `UnknownProviderError(provider, intent.kind, availableProviders)` where `availableProviders` is the sorted, deduped set of provider prefixes.
  - Preserve the credentials interceptor + factory-select + spawn steps (5–7) byte-for-byte.
- [X] T010 Update `packages/orchestrator/src/launcher/index.ts` to add exports for `UnknownProviderError`, `DuplicatePluginRegistrationError` (from `./errors.js`), plus the new intent types (`PhaseIntent`, `PrFeedbackIntent`, `ValidateFixIntent`, `MergeConflictIntent`, `ConversationTurnIntent`, `InvokeIntent`). Do **not** export `SYSTEM_PROVIDER` or `DEFAULT_PROVIDER` (registry-contract §Constants).

## Phase 5: External-contract mirror

- [X] T011 Update `packages/orchestrator-types/src/launcher-types.ts`: add `readonly provider: string` to the `AgentLaunchPlugin` interface (line ~81) and `provider?: string` to the `LaunchRequest` interface (line ~58). Do **not** widen the `LaunchIntent` union — the subset-by-design comment at line 51-53 stays (research D-8).

## Phase 6: Tests

- [X] T012 [P] Update `packages/orchestrator/src/launcher/__tests__/agent-launcher.test.ts`: change any existing "duplicate kind" assertions to expect `DuplicatePluginRegistrationError` (`instanceof` + `.provider`/`.kind`/`.existingPluginId` fields per data-model §5). Change "unknown kind" tests to reflect the classified error paths (plain `Error` for known-provider-unknown-kind vs. `UnknownProviderError` for unknown provider). Add a test for the `SYSTEM_PROVIDER` fallback: registering `GenericSubprocessPlugin` and calling `launch({ intent: { kind: 'generic-subprocess', ... } })` with no `provider` field succeeds (dispatch-contract §No-op parity).
- [X] T013 [P] Create `packages/orchestrator/src/launcher/__tests__/multi-provider.test.ts` (spec AC #2 + plan §Project Structure): register a fake plugin with `provider: 'test-agent'` and `supportedKinds: ['phase']` alongside `ClaudeCodeLaunchPlugin` (both claim `kind: 'phase'`), then launch a `PhaseIntent` with `request.provider: 'test-agent'` and assert the fake plugin's `buildLaunch` was called. Also assert that launching the same intent with `request.provider: 'claude-code'` (or omitted) resolves to `ClaudeCodeLaunchPlugin`. Include one negative test that launching with `request.provider: 'nonexistent'` throws `UnknownProviderError` with populated `.availableProviders`.
- [X] T014 [P] Add tests in `multi-provider.test.ts` (or a sibling file) for `DuplicatePluginRegistrationError`: register two plugins that both declare `provider: 'test-agent'` and `supportedKinds: ['phase']` and assert the second `registerPlugin` throws `DuplicatePluginRegistrationError` with `.provider === 'test-agent'`, `.kind === 'phase'`, and `.existingPluginId` equal to the first plugin's id. Also cover `provider === ''` → plain `Error` at registration.
- [X] T015 [P] Confirm the argv snapshot tests (`packages/orchestrator/src/__tests__/worker/cli-spawner-snapshot.test.ts` and neighbors) still pass **byte-identical** — no snapshot files should regenerate (spec AC #1, dispatch-contract §Snapshot parity). If any snapshot drift appears, treat as regression, not as expected update.
- [X] T016 [P] Add a source-grep test enforcing that `packages/orchestrator/src/launcher/types.ts` contains **zero** occurrences of the substring `generacy-plugin-claude-code` (spec AC #5; intent-types-contract §Forbidden import). Reads the file with `readFileSync` and asserts `.includes(...)` is `false`.
- [X] T017 [P] Add a source-grep test enforcing that `packages/orchestrator/src/launcher/index.ts` contains **zero** occurrences of `SYSTEM_PROVIDER` and `DEFAULT_PROVIDER` (registry-contract §Constants — enforcement note).

## Phase 7: Verification

- [X] T018 Run `pnpm --filter @generacy-ai/orchestrator typecheck` and the full launcher test suite (`pnpm --filter @generacy-ai/orchestrator test src/launcher`) plus `pnpm --filter @generacy-ai/generacy-plugin-claude-code typecheck` and its test suite. All green.
- [X] T019 Run the argv snapshot subset (`pnpm --filter @generacy-ai/orchestrator test cli-spawner-snapshot`) and confirm zero snapshot mutations occurred (`git status packages/orchestrator/src/__tests__/**/__snapshots__` shows clean). This is the mechanical proof of AC #1.
- [X] T020 Manually verify each acceptance gate item from plan.md §Acceptance Gate is satisfied and check them off in `spec.md` §Acceptance criteria + `plan.md` §Acceptance Gate.

## Dependencies & Execution Order

**Sequential phases** (each phase depends on prior):
- Phase 1 (constants + errors) → Phase 2 (types move) → Phase 3 (plugin.provider) → Phase 4 (registry rewrite) → Phase 5 (mirror package) → Phase 6 (tests) → Phase 7 (verify).

**Parallel opportunities within phases**:
- **Phase 1**: T001 + T002 are independent files.
- **Phase 2**: T003 → T004 → T005 → T006 are all in the same two files (`orchestrator/launcher/types.ts` and `plugin-claude-code/src/launch/*` + `index.ts`), so serial within-phase.
- **Phase 3**: T007 + T008 touch different files (Claude plugin vs. generic subprocess plugin) — parallel.
- **Phase 6**: T012 through T017 all touch either new test files or independent existing files → parallel; T015 is a "run-and-observe" gate that has no code writes.

**Cross-phase gates**:
- T005 requires T003 (types must exist in new home before the old file is deleted).
- T009 requires T001 (imports `SYSTEM_PROVIDER`, `DEFAULT_PROVIDER`) and T002 (imports the two error classes) and T004 (uses `AgentLaunchPlugin.provider`).
- T012 requires T009 (the new error surface is what's under test).
- T013 requires T007 + T009 (needs `ClaudeCodeLaunchPlugin.provider` and the new dispatch code path).
- T019 requires the whole change to be in place; treat as final gate before T020.

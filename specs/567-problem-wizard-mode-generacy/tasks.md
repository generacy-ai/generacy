# Tasks: Background Activation in Wizard Mode

**Input**: Design documents from `/specs/567-problem-wizard-mode-generacy/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Extract Helper Functions

- [X] T001 [US2] Extract `initializeRelayBridge()` from `packages/orchestrator/src/server.ts` lines 334-392 into a standalone async function within the same file. The function accepts `(config, server, apiKeyStore)` and returns `{ relayBridge, statusReporter }`. Replace the inline code with a call to this function.
- [X] T002 [US2] Extract `initializeConversationManager()` from `packages/orchestrator/src/server.ts` lines 394-427 into a standalone async function within the same file. The function accepts `(config, server, relayBridge)` and returns `ConversationManager | null`. Replace the inline code with a call to this function.

## Phase 2: Background Activation

- [X] T003 [US1] Create `activateInBackground()` async function in `packages/orchestrator/src/server.ts` that: (a) calls `await activate(...)`, (b) on success updates `config.relay` fields (apiKey, clusterApiKeyId, cloudUrl), (c) calls `initializeRelayBridge()`, (d) calls `initializeConversationManager()`, (e) calls `relayBridge.start()` directly (server is already listening), (f) assigns results to the outer `relayBridge`/`conversationManager` variables captured by reference.
- [X] T004 [US1] Replace the `await activate(...)` block (lines 307-332) with a conditional fire-and-forget call: when `!isWorkerMode && !config.relay.apiKey`, call `activateInBackground(...)` without `await`, with a `.catch()` that logs a warning. Preserve the existing "Cluster activation skipped" log message on failure.
- [X] T005 [US3] Ensure the `onReady` hook (line ~527) only calls `relayBridge.start()` when `relayBridge` was initialized synchronously (apiKey existed at startup). The background path calls `start()` itself after initialization. Guard with a check like `if (relayBridge && !activationPending)` or by checking if relayBridge was set before the hook fires.

## Phase 3: Verification

- [X] T006 [US1] [US3] Write or update a vitest unit test in `packages/orchestrator/src/__tests__/` verifying that `createServer()` completes and `server.listen()` binds the port even when `activate()` is a long-running promise (mock `activate` to never resolve). Assert `/health` returns 200.
- [X] T007 [US2] Write or update a vitest test verifying that when `activate()` resolves successfully in the background, `initializeRelayBridge()` and `initializeConversationManager()` are called and `relayBridge.start()` is invoked.
- [X] T008 [US3] Write or update a vitest test verifying that when `activate()` rejects in the background, the server continues running, the error is logged (not thrown), and no relay bridge is initialized.

## Dependencies & Execution Order

- **T001, T002**: Independent extractions, can run in parallel `[P]`. Pure refactor — no behavior change.
- **T003**: Depends on T001 and T002 (calls both extracted functions).
- **T004**: Depends on T003 (references `activateInBackground()`).
- **T005**: Depends on T004 (must understand the new background flow to guard the `onReady` hook).
- **T006, T007, T008**: All depend on T004+T005 (test the new behavior). Can run in parallel `[P]` with each other.

```
T001 ──┐
       ├──→ T003 → T004 → T005 ──→ T006 [P]
T002 ──┘                          → T007 [P]
                                  → T008 [P]
```

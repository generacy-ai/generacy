# Tasks: Fresh wizard clusters never clone their primary repo

**Input**: Design documents from `/specs/937-found-while-investigating/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = healthy fresh-clone path; US2 = observable defer signal)

## Phase 1: Test scaffolding (regression tests first)

Tests below assert the *new* behavior. On unmodified `main` they must **fail**, then pass once Phase 2 implementation lands. This is the RT-001..RT-004 coverage matrix from plan.md.

- [ ] T001 [P] [US1][US2] Add RT-001 to `packages/orchestrator/src/__tests__/post-activation-retry.test.ts`: `checkPostActivationState()` with `activated && !postActivationComplete` and a wizard-creds file that lacks `GH_TOKEN=` (or has `GH_TOKEN=` with empty trimmed value) → asserts `needsRetry === false`, one `logger.info` call whose message matches `/GH_TOKEN not sealed/` and includes structured `wizardCredsPath`, and one `sendRelayEvent('cluster.bootstrap', { status: 'deferred', reason: 'github-token-not-sealed' })` call. Use temp file via `mkdtempSync`/`tmpdir()` for `wizardCredsPath` seam. Also cover missing-file and I/O-error branches (D3 non-throwing invariant I1).
- [ ] T002 [P] [US1] Add RT-002 to `packages/orchestrator/src/__tests__/post-activation-retry.test.ts`: `checkPostActivationState()` with `activated && !postActivationComplete` and a wizard-creds file containing `GH_TOKEN=<non-empty>` → asserts `needsRetry === true`, no defer log line, and no `sendRelayEvent` call. Guards SC-004 (restart-recovery preserved).
- [ ] T003 [P] [US1] Add RT-003 to `packages/orchestrator/src/__tests__/post-activation-dispatch.test.ts`: fresh-activation state with `activated: true`, `postActivationComplete: false`, no sealed creds → `runPostActivationBranch()` returns `'noop'` and does NOT call `triggerPostActivationRetry` (spy on the injected factory). Complement of the existing retry-path test.
- [ ] T004 [P] [US1][US2] Add RT-004 to `packages/control-plane/__tests__/routes/lifecycle.test.ts`: `POST /lifecycle/bootstrap-complete` with `writeWizardEnvFile` stubbed to return `{ hasGitHubToken: false }` → asserts sentinel file NOT written (verify via `existsSync` on the stubbed `POST_ACTIVATION_TRIGGER` path or by asserting no `writeFile` call), response body is `{ accepted: true, action: 'bootstrap-complete', sentinel: null }` with status 200, one `getRelayPushEvent()` invocation with `('cluster.bootstrap', { status: 'awaiting-credentials', reason: 'github-token-not-sealed' })`, and neither `getCodeServerManager().start()` nor `getVsCodeTunnelManager().start()` is called. Mirror the existing `prepare-workspace` gated-sentinel test shape.
- [ ] T005 [P] [US1] Add positive-path assertion to `packages/control-plane/__tests__/routes/lifecycle.test.ts`: `POST /lifecycle/bootstrap-complete` with `hasGitHubToken: true` still writes the sentinel, still returns `sentinel: <path>`, still starts code-server and tunnel — guards D8 "defer-not-remove-behavior" and Risk row 5 (no regression of the token-present path).

## Phase 2: Orchestrator implementation (FR-001..FR-005)

Sequential — all edits target the same file `packages/orchestrator/src/services/post-activation-retry.ts`.

- [ ] T006 [US1] Extend `PostActivationRetryOptions` in `packages/orchestrator/src/services/post-activation-retry.ts` with `wizardCredsPath?: string` (see data-model.md §PostActivationRetryOptions). Add `DEFAULT_WIZARD_CREDS = '/var/lib/generacy/wizard-credentials.env'`. In the constructor, initialize `this.wizardCredsPath = options.wizardCredsPath ?? process.env.WIZARD_CREDS_PATH ?? DEFAULT_WIZARD_CREDS` (D2, FR-003). Add `readFileSync` to the `node:fs` import.
- [ ] T007 [US1] Add private `readGhToken()` helper to `PostActivationRetryService` in `packages/orchestrator/src/services/post-activation-retry.ts` per data-model.md §Internal predicate: `readFileSync(this.wizardCredsPath, 'utf8')` wrapped in try/catch, split on `/\r?\n/`, for each line take `indexOf('=')`, if `key === 'GH_TOKEN'` return `{ sealed: value.trim().length > 0, token?: value.trim() }`. All error branches return `{ sealed: false }` (invariant I1). No dep on `existsSync` — the try/catch subsumes it.
- [ ] T008 [US1][US2] Rewrite `checkPostActivationState()` in `packages/orchestrator/src/services/post-activation-retry.ts` (FR-001, FR-002, D4, D5, D6). Change `needsRetry` from `activated && !postActivationComplete` to `activated && !postActivationComplete && ghTokenSealed` (where `ghTokenSealed = this.readGhToken().sealed`). When `activated && !postActivationComplete && !ghTokenSealed`: emit `this.logger.info({ wizardCredsPath: this.wizardCredsPath }, 'Post-activation retry deferred — GH_TOKEN not sealed in wizard-credentials.env')` and `this.sendRelayEvent?.('cluster.bootstrap', { status: 'deferred', reason: 'github-token-not-sealed' })`. Do NOT emit on the token-present path (RT-002 no-defer-event assertion). Do NOT emit when `!activated` or when `postActivationComplete` — the defer signal is only meaningful in the intermediate state.

## Phase 3: Control-plane implementation (FR-006)

Sequential — edit `packages/control-plane/src/routes/lifecycle.ts`.

- [ ] T009 [US1][US2] In `packages/control-plane/src/routes/lifecycle.ts` `bootstrap-complete` branch (around line 168-206), extract `hasGitHubToken` from `writeWizardEnvFile()` result (currently ignored on this branch — cf. `prepare-workspace` at line 132). Guard the `writeFile(sentinel, …)`, `getCodeServerManager().start()`, and `getVsCodeTunnelManager().start()` calls behind `if (hasGitHubToken) { … }` (D7). In the `else` branch, `getRelayPushEvent()?.('cluster.bootstrap', { status: 'awaiting-credentials', reason: 'github-token-not-sealed' })`. Update the response body to `{ accepted: true, action: parsed.data, sentinel: hasGitHubToken ? sentinel : null }` (invariant I3). Preserve the existing `envResult.failed` warning event on both branches.

## Phase 4: Validation

- [ ] T010 [P] [US1][US2] Run unit tests: `pnpm --filter @generacy-ai/orchestrator test post-activation` and `pnpm --filter @generacy-ai/control-plane test lifecycle`. All RT-001..RT-004 must pass. Full-package runs (`pnpm --filter @generacy-ai/orchestrator test`, `pnpm --filter @generacy-ai/control-plane test`) must remain green (no unrelated regressions).
- [ ] T011 [P] [US1] Typecheck the two touched packages (`pnpm --filter @generacy-ai/orchestrator typecheck && pnpm --filter @generacy-ai/control-plane typecheck`). Confirms no downstream consumer of `PostActivationRetryOptions` or the lifecycle response body breaks.
- [ ] T012 [US1][US2] Manual smoke per `quickstart.md` §"Manual smoke (SC-001, SC-005)": provision a fresh wizard cluster; assert (a) orchestrator logs contain the FR-002 defer line exactly once and do NOT contain `replaying bootstrap-complete lifecycle action` before wizard-complete (SC-002), (b) `/workspaces/<repo>/.git` exists within 30 s of wizard finish (SC-001), (c) `/var/lib/generacy/post-activation-complete` written exactly once (SC-005), (d) cloud `cluster.bootstrap` channel shows one `{ status: 'deferred', reason: 'github-token-not-sealed' }` (SC-003).
- [ ] T013 [US1] Manual restart-recovery smoke per `quickstart.md` §"Manual smoke (SC-004)": creds sealed, `post-activation-complete` missing, container restart → retry still fires. Guards D5 / RT-002 semantically end-to-end.

## Dependencies & Execution Order

**Phase order** (sequential):
- Phase 1 (T001..T005) → Phase 2 (T006..T008) → Phase 3 (T009) → Phase 4 (T010..T013)
- Tests-first: Phase 1 is authored against unmodified `post-activation-retry.ts` / `lifecycle.ts` and MUST fail. Phase 2+3 implementation makes them pass.

**Within Phase 1** (all `[P]`):
- T001, T002, T003 all live in orchestrator test files but T001+T002 share `post-activation-retry.test.ts` — author them together but they don't step on each other (distinct describe blocks). T003 is a separate file. T004+T005 share `lifecycle.test.ts` — same pattern.
- Order within Phase 1 does not matter; only the phase boundary before Phase 2 matters.

**Within Phase 2** (sequential — same file):
- T006 (options + import) → T007 (helper method) → T008 (rewritten predicate that consumes T006+T007).

**Phase 3** (single task, no ordering):
- T009 depends only on the existing `writeWizardEnvFile` return shape (no orchestrator changes needed here).

**Within Phase 4**:
- T010 + T011 are `[P]` and can run in parallel (different pnpm scripts). T012 and T013 are manual smokes — run T012 first (it exercises the fresh-cluster fix), then T013 (restart-recovery). T012 gates SC-001/SC-002/SC-003/SC-005; T013 gates SC-004.

**Cross-package coupling**:
- Phase 2 (orchestrator) and Phase 3 (control-plane) are independent files and could technically be authored in parallel by different agents — but both are P1 in the same PR (D8), so they MUST land together. Sequenced here for clarity, not for a code dependency.

## Story→Task map

- **US1** (fresh wizard cluster clones its repo): T001, T002, T003, T004, T005, T006, T007, T008, T009, T010, T011, T012, T013
- **US2** (operator observes defer reason): T001, T004, T008, T009, T012

## Files touched

| File | Tasks |
|------|-------|
| `packages/orchestrator/src/services/post-activation-retry.ts` | T006, T007, T008 |
| `packages/orchestrator/src/__tests__/post-activation-retry.test.ts` | T001, T002 |
| `packages/orchestrator/src/__tests__/post-activation-dispatch.test.ts` | T003 |
| `packages/control-plane/src/routes/lifecycle.ts` | T009 |
| `packages/control-plane/__tests__/routes/lifecycle.test.ts` | T004, T005 |

No new files. No new dependencies. Ship as a single PR per D8.

---

*Generated by speckit*

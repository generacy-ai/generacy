# Tasks: phase-start-ref key migration + unresolvable-ref handling (#1112)

**Input**: Design documents from `/specs/1112-follow-up-1107-pr/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/git-client.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: New git capability — `commitExistsInCheckout` (US2 foundation)

- [ ] T001 [US2] Add `commitExistsInCheckout(sha: string): Promise<boolean>` to the `GitHubClient` interface in `packages/workflow-engine/src/actions/github/client/interface.ts`, next to `getCurrentCommitSha` (:422) / `getFilesChangedByOwnCommits` (:435). Include the JSDoc from `contracts/git-client.md` documenting exit 0 → true, exit 1 → false, other → throw.
- [ ] T002 [US2] Implement `commitExistsInCheckout` in `GhCliGitHubClient` at `packages/workflow-engine/src/actions/github/client/gh-cli.ts`, placed beside `getFilesChangedByOwnCommits` (~:1410). Run `git rev-parse --verify --quiet <sha>^{commit}` via `executeCommand` with `{ cwd: this.workdir }`; return true on exit 0, false on exit 1, throw with exit code + trimmed stderr otherwise. Use the reference implementation in `plan.md` §A / `contracts/git-client.md`.

## Phase 2: Capture/reuse block rewrite (US1 + US2)

<!-- Phase boundary: T001/T002 must land before T003 — the block calls the new method -->

- [ ] T003 [US1] [US2] Rewrite the phase-start-ref capture/reuse block in `packages/orchestrator/src/worker/phase-loop.ts:363-394`. Add the legacy key `phase-start-ref:<owner>:<repo>:<issue>:<phase>` (no branch component) alongside the branch-scoped key. Implement the state machine from `data-model.md`:
  - Read branch-scoped key; if valid SHA → `existing`.
  - On miss/invalid: lazily read the legacy key **once** (FR-001). If a valid SHA, `setValueRaw(branchKey, ref, PHASE_START_REF_TTL_SECONDS)` **before** clearing legacy (Q1=A), set `existing`. If shape-invalid, discard.
  - Clear the legacy key via `clearRaw` on **any** legacy read — accepted or rejected (FR-002/Q3=A), after the branch write.
  - If `existing != null`, call `context.github.commitExistsInCheckout(existing)` (FR-003); on `false` set `existing = null` to re-capture; a throw propagates to the existing `try/catch` → `phaseStartRef` undefined → `product-diff-error` (FR-005, preserved for free).
  - If `existing == null`, capture fresh HEAD, validate, persist under the branch-scoped key (FR-004).
  - Add `info`/`warn` diagnostics (migrated-legacy hit, shape-invalid discard, unresolvable re-capture) at the level of the existing capture-failure `warn` (FR-006).
  - Leave the step-5b consumption (:813-848), empty-`productFiles` escalation (:850-892), pass-path `clearRaw(branchKey)` (:894-898), TTL constant, and key namespace unchanged (US3).

## Phase 3: Tests

<!-- Phase boundary: unit tests validate the implementation from Phases 1-2 -->

- [ ] T004 [P] [US2] Create `packages/workflow-engine/src/actions/github/client/__tests__/gh-cli.commit-exists.test.ts`. Mock `executeCommand`; assert exit 0 → `true`, exit 1 → `false`, exit 128 → throws with exit code + stderr in the message. Assert the command is `git rev-parse --verify --quiet <sha>^{commit}` run in `this.workdir` (SC-005 gh-cli half).
- [ ] T005 [US1] [US2] [US3] Extend `packages/orchestrator/src/worker/__tests__/phase-loop.product-diff.test.ts`:
  - Add `commitExistsInCheckout: vi.fn().mockResolvedValue(true)` to the `makeGithub()` (`context.github`) stub so existing cases stay green.
  - **SC-001**: legacy `S` present only on the legacy key, branch-scoped miss → migrate + reuse `S`; assert `getFilesChangedByOwnCommits` called with `S`, `setValueRaw(branchKey, S)` and `clearRaw(legacyKey)` fired; phase passes.
  - **SC-002**: `clearRaw(legacyKey)` called exactly once on the accepted case and also on the shape-invalid legacy case.
  - **SC-003**: `commitExistsInCheckout` → `false` for the persisted ref → fresh HEAD captured, `setValueRaw(branchKey, HEAD)` written, phase proceeds; no throw, no `product-diff-error`, no escalation.
  - **SC-004**: branch-scoped ref present + `commitExistsInCheckout` → true → no legacy read, no re-capture, ref reused directly.
  - **SC-005**: `commitExistsInCheckout` throws (exit 128) → `phaseStartRef` undefined → `product-diff-error` classifier + escalation still raised.
- [ ] T006 [P] [US3] Audit every other phase-loop test stub that injects `phaseTracker` returning a ref (across `phase-loop*.test.ts` / `product-diff.test.ts`) and add `commitExistsInCheckout: vi.fn().mockResolvedValue(true)` to its `context.github` stub. Stubs without `phaseTracker` are unaffected (getValueRaw undefined → fresh-capture path, no resolve-check). Confirm the existing #1107 suites stay green (SC-004/SC-005 regression guard).

## Phase 4: Changeset & verification

- [ ] T007 [P] Create `.changeset/1112-phase-start-ref-migration.md`: `@generacy-ai/workflow-engine` **minor** (new public `GitHubClient.commitExistsInCheckout`), `@generacy-ai/orchestrator` **patch** (internal defect fix, `workflow:speckit-bugfix`). Single file, both bumps — mirror `.changeset/1107-implement-product-diff-guard.md` shape. Must be a **newly added** file in the diff.
- [ ] T008 Run `pnpm --filter @generacy-ai/workflow-engine --filter @generacy-ai/orchestrator test` (or the repo's targeted vitest) and typecheck; confirm new + existing suites pass and the changeset gate is satisfied.

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 → T002 (impl depends on interface method).
- T001/T002 → T003 (phase-loop block calls the new method).
- T003 → T005/T006 (phase-loop tests exercise the rewritten block).
- T002 → T004 (gh-cli unit test exercises the impl).
- All → T008 (final green run).

**Parallel opportunities**:
- T004 (workflow-engine gh-cli test) is independent of T005/T006 (orchestrator phase-loop tests) — different packages/files, both after their respective impl tasks.
- T006 (stub audit) can run alongside T005 (they touch different describe blocks but the same test file — coordinate to avoid edit conflicts; treat as sequential if editing the same file).
- T007 (changeset) is independent of test files and can be written any time before T008.

**No playbook coupling**: this issue edits no `packages/claude-plugin-cockpit/commands/*.md`, so no `playbook-verification.test.ts` re-pin task is required.

## Grouping Strategy

Default `epic-grouping:per-story` applies if converted via `/speckit:taskstoissues`. US1 (T003, T005) and US2 (T001, T002, T003, T004, T005) overlap on the shared phase-loop rewrite (T003) — implement as a single coherent PR rather than splitting by story.

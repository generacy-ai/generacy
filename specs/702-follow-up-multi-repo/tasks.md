# Tasks: Wire siblingFanoutHandler and complete agent prompt

**Input**: Design documents from `/specs/702-follow-up-multi-repo/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [ ] T001 [US1] Register `siblingFanoutHandler` in `phaseAfterHandlers` array in `packages/orchestrator/src/worker/claude-cli-worker.ts` — import `siblingFanoutHandler` and `SiblingFanoutContext` from `@generacy-ai/workflow-engine`, create adapter closure mapping `PhaseAfterContext` fields to `SiblingFanoutContext`, insert as first element before existing linkedPRs reader handler
- [ ] T002 [US1] Update misleading comment on existing linkedPRs reader handler in `claude-cli-worker.ts` to reflect that the writer is now wired (drop "Phase 2 writes" framing)
- [ ] T003 [P] [US2] Append auto-PR sentence to `buildSiblingPromptBlock()` in `packages/orchestrator/src/worker/sibling-prompt.ts` — add "Changes you make in sibling repos will be automatically committed and a draft PR opened, linked to this issue." after repo list

## Phase 2: Tests & Verification

- [ ] T004 [US2] Update snapshot/assertions in `packages/orchestrator/src/worker/__tests__/sibling-prompt.test.ts` to include the new auto-PR sentence
- [ ] T005 Run `pnpm test` across affected packages (`orchestrator`, `workflow-engine`) to verify zero regressions

## Dependencies & Execution Order

- T001 and T002 are in the same file and logically coupled — do T001 first, T002 immediately after
- T003 is independent of T001/T002 (different file) and can run in parallel [P]
- T004 depends on T003 (snapshot must match updated prompt)
- T005 depends on all prior tasks

```
T001 → T002 ─┐
              ├→ T005
T003 → T004 ─┘
```

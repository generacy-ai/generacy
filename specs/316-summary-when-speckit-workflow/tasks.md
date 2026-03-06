# Tasks: Post Clarification Questions to Issue on Gate Hit

**Input**: Design documents from `/specs/316-summary-when-speckit-workflow/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Tests

- [ ] T001 [US1] Create `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts` — unit tests for `parseClarifications()`: parse pending questions, parse answered questions, handle empty file, handle malformed markdown, extract options
- [ ] T002 [P] [US1] Add unit tests for `formatComment()`: verify HTML marker inclusion (`<!-- generacy-clarifications:{issueNumber} -->`), question formatting with context/options, answering instructions template
- [ ] T003 [P] [US1] Add integration test for `postClarifications()`: mock GitHub API, verify dedup check (existing marker → skip), verify posting with pending questions, verify no-op when no pending questions, verify no-op when file missing

## Phase 2: Core Implementation

- [ ] T004 [US1] Create `packages/orchestrator/src/worker/clarification-poster.ts` — implement `parseClarifications(content: string): ClarificationQuestion[]` to parse `clarifications.md` markdown format, extracting question number, topic, context, question text, options, and answered status based on `**Answer**: *Pending*` marker
- [ ] T005 [US1] Implement `formatComment(questions: ClarificationQuestion[], issueNumber: number): string` in `clarification-poster.ts` — format pending questions as GitHub comment with HTML dedup marker, numbered questions with context, and answering instructions
- [ ] T006 [US1] Implement `postClarifications(context, specDir: string): Promise<ClarificationPostResult>` in `clarification-poster.ts` — orchestrate: find `clarifications.md` in spec dir by issue number prefix, read file, parse, check existing comments for HTML marker, post if pending questions exist

## Phase 3: Integration

- [ ] T007 [US1] Modify `packages/orchestrator/src/worker/phase-loop.ts` — after `labelManager.onGateHit()` (line 241), add conditional call to `postClarifications()` when `gate.gateLabel === 'waiting-for:clarification'`, wrapped in try/catch to prevent posting failure from blocking gate flow

## Dependencies & Execution Order

```
T001 ─┐
T002 ─┼─ (parallel, Phase 1) ──→ T004 → T005 → T006 (sequential, Phase 2) → T007 (Phase 3)
T003 ─┘
```

- **Phase 1** (Tests): T001, T002, T003 can all run in parallel — they test different functions and don't share files
- **Phase 2** (Core): T004 → T005 → T006 are sequential — each builds on the previous function
- **Phase 3** (Integration): T007 depends on T006 being complete — it imports and calls `postClarifications()`

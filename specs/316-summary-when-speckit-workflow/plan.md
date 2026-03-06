# Implementation Plan: Post Clarification Questions to Issue on Gate Hit

**Feature**: Bug fix — clarification questions not posted to issue when clarify gate is hit
**Branch**: `316-summary-when-speckit-workflow`
**Status**: Complete

## Summary

When the speckit workflow hits the `waiting-for:clarification` gate, the orchestrator labels the issue but never posts the clarification questions as a visible comment. The clarify operation (`clarify.ts`) already has posting code (lines 268-305), but it can fail silently. The fix adds a safety-net posting mechanism in the gate-hit handler (`phase-loop.ts`) that reads `clarifications.md` and posts pending questions to the issue.

## Technical Context

- **Language**: TypeScript
- **Framework**: Node.js with pnpm monorepo
- **Key packages**: `packages/orchestrator`, `packages/workflow-engine`
- **GitHub API**: Via `context.github.addIssueComment()` (Octokit wrapper)
- **Testing**: Vitest

## Approach

**Recommended: Safety-net posting in phase-loop.ts (Option C from Q1/Q2)**

The gate-hit handler in `phase-loop.ts` is the most reliable place to ensure questions are posted because:
1. It runs after the phase completes, so `clarifications.md` is guaranteed to exist
2. It already handles label management and stage comment updates
3. It has access to the full orchestrator context (GitHub API, issue number, checkout path)

The implementation will:
1. After `labelManager.onGateHit()` in `phase-loop.ts:241`, check if the gate is `waiting-for:clarification`
2. Find the `clarifications.md` file in the specs directory
3. Parse pending questions (those with `**Answer**: *Pending*`)
4. Post a formatted comment to the issue via `context.github.addIssueComment()`
5. Include answering instructions so humans know the expected format

## Project Structure

```
packages/orchestrator/src/worker/
├── phase-loop.ts              # MODIFY — add clarification posting after gate hit
├── clarification-poster.ts    # NEW — parsing and posting logic
├── stage-comment-manager.ts   # READ ONLY — reference for comment patterns
├── label-manager.ts           # READ ONLY — reference for gate-hit flow
└── __tests__/
    └── clarification-poster.test.ts  # NEW — unit tests

packages/workflow-engine/src/actions/builtin/speckit/operations/
└── clarify.ts                 # READ ONLY — reference existing posting code
```

## Design Decisions

### 1. Separate module for clarification posting
Extract parsing and posting into `clarification-poster.ts` rather than inlining in `phase-loop.ts`. This keeps phase-loop focused on orchestration and makes the posting logic testable.

### 2. Use GitHub API instead of shell command
The existing clarify.ts uses `gh issue comment` via shell. The gate-hit handler should use `context.github.addIssueComment()` (Octokit) for consistency with the orchestrator's existing patterns (see `epic-post-tasks.ts:281`).

### 3. Find spec directory by issue number prefix
The spec directory follows the pattern `specs/{issueNumber}-{slug}/`. Use glob/readdir to find the directory matching the issue number prefix, avoiding hardcoded slug knowledge.

### 4. Idempotent posting with HTML marker
Use an HTML comment marker (e.g., `<!-- generacy-clarifications:316 -->`) to prevent duplicate posts. Check existing comments before posting, following the pattern used by `StageCommentManager`.

### 5. Include answering instructions
The posted comment will include a template showing the expected answer format (e.g., "Reply with `Q1: your answer`") to streamline the human response workflow.

## Implementation Steps

### Step 1: Create `clarification-poster.ts`
- `parseClarifications(content: string)` — parse markdown, extract pending questions
- `formatComment(questions, issueNumber)` — format as GitHub comment with instructions
- `postClarifications(context, specDir)` — orchestrate: read file, parse, check for existing post, post

### Step 2: Integrate into phase-loop.ts
- After `labelManager.onGateHit()` (line 241), add call to `postClarifications()`
- Only trigger when `gate.gateLabel === 'waiting-for:clarification'`
- Wrap in try/catch — posting failure should not block the gate-hit flow

### Step 3: Write tests
- Unit test parsing of clarifications.md (various formats, edge cases)
- Unit test comment formatting
- Integration test for the full flow with mocked GitHub API

### Step 4: Verify with existing clarify.ts
- Ensure no duplicate posting — the HTML marker check handles this
- The clarify.ts posting can remain as-is (first attempt); phase-loop posting acts as safety net

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Duplicate comments | HTML marker check before posting |
| Missing clarifications.md | Graceful no-op with warning log |
| Malformed markdown | Robust parser with fallback to raw content |
| GitHub API failure | try/catch with warning — don't block gate flow |

## Constitution Check

No `.specify/memory/constitution.md` found — no governance constraints to verify.

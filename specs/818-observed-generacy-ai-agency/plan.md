# Implementation Plan: Clarify Phase Gate-Skip Race

**Feature**: Tighten `isQuestionComment` and `parseAnswersFromComments` in the clarification poster so the `waiting-for:clarification` gate cannot be silently skipped by the bot's own questions comment or by mid-prose `Q<n>:` references. Add two distinct operator warnings and plumb the real GitHub comment id through the parser for post-mortem correlation.
**Branch**: `818-observed-generacy-ai-agency`
**Status**: Complete
**Date**: 2026-07-06
**Spec**: [spec.md](./spec.md)
**Input**: Feature specification at `/specs/818-observed-generacy-ai-agency/spec.md`

## Summary

The bug: after clarify posts questions, `integrateClarificationAnswers()` is called on the next phase-loop tick. If the just-posted questions comment fails `isQuestionComment()` (e.g., a variant heading or a missing marker), the answer parser walks the questions comment itself, treats the `### Q<n>: Topic` heading as an answer (topic text as the answer), overwrites `*Pending*` in `clarifications.md`, and `hasPendingClarifications()` returns `false`. The gate is skipped.

The fix has three surgical parts, all in `packages/orchestrator/src/worker/clarification-poster.ts`:

1. **Widen `isQuestionComment` (FR-001)** — accept any body where a `### Q<n>:` heading section contains ANY of `**Question**:`, `**Context**:`, or `**Options**:`. These markers are all question-side markup that never appears in human answer comments.
2. **Defense-in-depth in `parseAnswersFromComments` (FR-002, FR-005)** — skip captured answers whose text contains `**Question**:` / `**Context**:` markup, warn with `SKIPPED_SUSPICIOUS_ANSWER`. Anchor the `Q<n>:` answer regex at the start of a line to reject mid-prose references like "as per Q1: yes".
3. **Residual-race detector (FR-004)** — when a pending→answered transition happens from a comment that still contains `### Q<n>:` headings (i.e., FR-001+FR-002 both missed), warn with `TRANSITION_WITH_QUESTION_HEADINGS`, including the source comment's real GitHub numeric id. This requires widening the input type of `parseAnswersFromComments` from `Array<{ body: string }>` to `Array<{ id: number; body: string; created_at?: string }>` — data already carried by `Comment` in `packages/workflow-engine/src/types/github.ts`.

FR-003 (mtime timestamp check) is explicitly dropped per Clarifications Q3 (option C): `git checkout` does not preserve mtime reliably and GitHub-vs-cluster clock skew makes it fragile. FR-001 + FR-002 + FR-005 close the same race window with fewer moving parts.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js >=22 (ESM modules, `node:` builtins).
**Primary Dependencies**: `pino` (logging via `Logger` from `./types.js`), `vitest` (test runner). Only `node:fs` / `node:path` builtins used inside `clarification-poster.ts`.
**Storage**: None. Reads `<checkoutPath>/specs/<n>-<slug>/clarifications.md` (existing), writes it back with integrated answers (existing behaviour, preserved).
**Testing**: `vitest` co-located at `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`. Existing file already has ~875 lines covering `parseClarifications`, `formatComment`, `postClarifications`, `hasPendingClarifications`, `integrateClarificationAnswers`, and `isQuestionComment` — this fix extends those `describe` blocks rather than adding a new file.
**Target Platform**: Linux orchestrator container. Node-only, no browser surface.
**Project Type**: single — one package (`packages/orchestrator`) modified plus a small type surface change in `packages/workflow-engine` if we tighten the `parseAnswersFromComments` input signature to reflect the new plumbing (the interface already returns `Comment` with `id` — the type widening is inside `clarification-poster.ts` only, so `workflow-engine` is untouched).
**Performance Goals**:
- SC-001: 0 gate-skips in 100 consecutive workflow runs against a clarify-triggering spec.
- No new I/O — all changes are in-process string / regex work on comment bodies already fetched.
**Constraints**:
- Do NOT change the `GitHubClient` interface. `Comment` already has `id` and `created_at`; the plumbing is a one-line signature change on the private `parseAnswersFromComments` inside `clarification-poster.ts`, plus removing the `.map((c) => ({ body: c.body }))`-style narrowing (there is none today — comments are passed as-is through `answerComments`).
- Do NOT touch other gate paths (`on-sibling-review`, `always`) — this is scoped strictly to `on-questions`.
- Fail-forward: if the new content-based FR-002 filter fires on a false positive (a legitimate human answer that quotes markup), the effect is a warn log + a skipped integration on THAT comment; the next tick sees the still-pending questions and pauses on the gate, which is the safe direction.
- Backwards compatible: existing well-formed bot comments (with markers, matching FR-001 (A) rule today) continue to short-circuit `isQuestionComment` on marker match — the widened rule is additive.
**Scale/Scope**: Single file changed for behaviour (`clarification-poster.ts`, ~525 → ~580 LOC), single test file extended (`__tests__/clarification-poster.test.ts`), a spec directory with 4 required regression fixtures (FR-006, FR-007, FR-008, plus SC-004 legacy protection).

## Constitution Check

No `.specify/memory/constitution.md` present in this repo. No gates to evaluate. Constitution check **PASS** (vacuously).

## Project Structure

### Documentation (this feature)

```text
specs/818-observed-generacy-ai-agency/
├── spec.md                       # already authored
├── clarifications.md             # already authored (Batch 1, all 5 Qs answered)
├── plan.md                       # THIS FILE
├── research.md                   # decisions, alternatives, references
├── data-model.md                 # types touched (Comment, IntegrationResult, log payloads)
├── quickstart.md                 # how to reproduce the bug locally + how to verify the fix
├── contracts/
│   ├── log-skipped-suspicious-answer.schema.json   # FR-002 warn payload
│   └── log-transition-with-question-headings.schema.json  # FR-004 warn payload
└── tasks.md                      # produced by /speckit:tasks (not this command)
```

### Source Code (packages/orchestrator — repository monorepo)

```text
packages/orchestrator/
├── src/worker/
│   └── clarification-poster.ts                     # MODIFIED — FR-001, FR-002, FR-004, FR-005
└── src/worker/__tests__/
    └── clarification-poster.test.ts                # MODIFIED — new tests for FR-006, FR-007, FR-008, US2 warn assertions
```

**Structure Decision**: Single-file change inside the existing `clarification-poster.ts` module. No new files, no new packages, no cross-package surface changes. The `Comment` type from `@generacy-ai/workflow-engine` (`packages/workflow-engine/src/types/github.ts:72`) already carries `id: number` and `created_at: string`, so the internal `parseAnswersFromComments` signature widens without any consumer change: callers already pass through the `Comment[]` from `github.getIssueComments()` unchanged.

The only non-obvious call-site change is inside `integrateClarificationAnswers()`, which currently narrows to `{ body: string }` implicitly (line ~405 declares `let comments: Array<{ body: string }>`). We change that local type to `Array<{ id: number; body: string; created_at?: string }>` so the `id` reaches `parseAnswersFromComments` for the FR-004 warn payload.

Fifth touched location: `isQuestionComment()` (line ~102) gets a new branch — a helper `sectionsWithQuestionMarkup(body)` that walks the body from each `### Q<n>:` heading to the next `### ` heading (or end-of-body) and checks for `**Question**:` / `**Context**:` / `**Options**:` substrings.

## Complexity Tracking

> No constitution violations. Table omitted.

## Deliverables

- `plan.md` — this file.
- `research.md` — decisions D1-D5 driving the FR interpretation.
- `data-model.md` — the type widening and the two log payload shapes.
- `contracts/log-skipped-suspicious-answer.schema.json` — FR-002 warn JSON payload contract.
- `contracts/log-transition-with-question-headings.schema.json` — FR-004 warn JSON payload contract.
- `quickstart.md` — reproduction + verification playbook.
- (Downstream) `tasks.md` — generated by `/speckit:tasks`.

## Next Step

Run `/speckit:tasks` to generate the task list from this plan.

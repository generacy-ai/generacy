# Implementation Plan: PR review posting (COMMENT-event) + draft/ready lifecycle

**Feature**: Wire the review phase's findings artifact to the PR — post findings as a single COMMENT-event review per round (inline threads where diffable, marker + round in the body), drive the PR draft/ready lifecycle around review/remediate, and resolve threads on verification passes.
**Branch**: `1125-context-findings-need-human`
**Status**: Complete

## Summary

This is P2 of the engine-native review & remediate epic ([#1120](https://github.com/generacy-ai/generacy/issues/1120)). It turns the structured findings artifact produced by the review executor ([#1124](https://github.com/generacy-ai/generacy/issues/1124)) into GitHub side effects. It does **not** decide the verdict — it consumes the artifact's explicit `verdict: clean|changes-required` field.

Four behaviours land:

1. **One COMMENT review per round** (US1/FR-001–004, FR-010). Each review round posts exactly one PR review using the `COMMENT` event (never `REQUEST_CHANGES` — 422 on own PR). Diffable-anchored findings become inline threads; undiffable/unanchored findings render in the review body. The body carries a greppable engine marker + round number; each inline comment carries a stable per-finding marker. Re-posting the same round is deduped by grepping existing reviews.
2. **Clean verdict marks ready before validate** (US2/FR-005). `review` is a linear phase immediately before `validate`; a `verdict: clean` calls the existing `markReadyForReview` at review-phase end so CI runs in parallel with validate.
3. **Remediate entry converts back to draft** (US3/FR-006–007). Entering the off-sequence `remediate` phase converts the PR to draft via a **new** GraphQL `convertPullRequestToDraft` client method — but only if the engine itself marked it ready (tracked flag). The next clean verdict re-marks ready.
4. **Verification passes resolve threads** (US4/FR-009). On a re-review round (≥ 2), threads whose finding the artifact marks `resolved` are resolved via the existing `resolveReviewThread`, matched by grepping the per-finding marker in `getPRReviewThreads` comment bodies.

All GitHub transitions are idempotent + best-effort (FR-008): a failure logs a warning and never fails the workflow.

The review executor (#1124) is still a feature-flagged **stub** (`runStubPhase`) in the phase loop (landed by #1121/#1123). Until #1124 lands a real executor that writes the artifact, the new posting path is **inert in production** — it is invoked only when a findings artifact is available via an injectable reader seam (default returns `null`). The harness drives it with a fake artifact + mock client.

## Technical Context

- **Language/Runtime**: TypeScript, ESM, Node ≥ 22. pnpm monorepo.
- **Packages touched**:
  - `@generacy-ai/workflow-engine` — new `GitHubClient` methods (`createReview`, `convertPullRequestToDraft`, `listPullRequestFiles`) + `CreateReviewInput` type. New public capability → **minor** bump.
  - `@generacy-ai/orchestrator` — new `ReviewPoster` service, `PrManager` draft/flag additions, phase-loop review-side-effect wiring + `reviewRound` counter + `readFindingsArtifact` seam. Internal only, no new public exports → **patch** bump.
- **Existing surface reused** (no changes): `listReviews` (`gh-cli.ts:684`, from #1047), `getPRReviewThreads` (`gh-cli.ts:577`), `resolveReviewThread` (`gh-cli.ts:769`), `markPRReady` (`gh-cli.ts:533`, via `gh pr ready`), `PrManager.markReadyForReview` (`pr-manager.ts:424`), `markSiblingsReadyForReview` (`pr-manager.ts:453`), the `remediateTrigger` + `i--` backtrack seam (`phase-loop.ts:1154`), the `review`/`remediate` stub branch (`phase-loop.ts:473`).
- **GitHub access pattern**: `executeGh(['api', ...])`. REST (`gh api /repos/.../pulls/{n}/reviews`) for review creation + file listing; GraphQL (`gh api graphql`) for `convertPullRequestToDraft` (mutation requires the PR node ID; mirrors the `resolveReviewThread` retry/auth pattern).
- **Testing**: Vitest. Unit tests for `ReviewPoster` (fake artifact + mock `GitHubClient`), `convertPullRequestToDraft`/`createReview`/`listPullRequestFiles` in `gh-cli`, and `PrManager` draft/flag; an orchestrator integration test drives the review-side-effect block through the phase loop against a mock client.

## Constitution Check

No `.specify/memory/constitution.md` exists in the repo — constitution check **skipped**.

## Project Structure

```
packages/workflow-engine/src/
  types/github.ts                       # MODIFY: add CreateReviewInput, CreateReviewComment; Review type already present
  actions/github/client/
    interface.ts                        # MODIFY: + createReview, convertPullRequestToDraft, listPullRequestFiles
    gh-cli.ts                           # MODIFY: implement the three methods (REST reviews + files, GraphQL draft mutation)
  __tests__/ (or tests/actions/github/) # ADD: gh-cli.create-review.test.ts, gh-cli.convert-to-draft.test.ts,
                                         #      gh-cli.list-pr-files.test.ts

packages/orchestrator/src/worker/
  review-poster.ts                      # NEW: ReviewPoster — build+dedupe+post one COMMENT review/round,
                                         #      diffability pre-check, thread resolution on re-review
  review-findings-artifact.ts           # NEW: FindingsArtifact / ReviewFinding types + Zod schema + marker helpers
                                         #      (local consuming contract for #1124; import from #1124 once it lands)
  pr-manager.ts                         # MODIFY: markedReadyByEngine flag; convertToDraftIfEngineMarkedReady()
  phase-loop.ts                         # MODIFY: reviewRound counter; review-side-effect block after runStubPhase('review');
                                         #         draft-conversion on remediate entry; PhaseLoopDeps.readFindingsArtifact seam
  types.ts                              # MODIFY: PhaseLoopDeps.readFindingsArtifact?; (WorkerContext unchanged)
  claude-cli-worker.ts                  # MODIFY: construct ReviewPoster; wire into PhaseLoopDeps (reader defaults undefined)
  __tests__/
    review-poster.test.ts               # NEW: US1/FR-001–004,010; US4/FR-009 (mock client + fake artifact)
    pr-manager.draft.test.ts            # NEW: US3/FR-006 flag gating + idempotency/best-effort
    phase-loop.review-side-effects.integration.test.ts  # NEW: SC-001..006 through the loop

.changeset/
  1125-pr-review-posting.md             # NEW: workflow-engine minor + orchestrator patch
```

## Key Decisions (see research.md for rationale)

- **Artifact type lives locally in orchestrator** (`review-findings-artifact.ts`) with a Zod schema, because #1124 hasn't landed. A comment marks it as the shape #1124 must satisfy; swap to an import once #1124 exports it.
- **Artifact source is an injectable seam** `PhaseLoopDeps.readFindingsArtifact?: (context, round) => Promise<FindingsArtifact | null>` (mirrors `remediateTrigger`). Default `undefined` → poster never invoked → production-inert until #1124.
- **`createReview` uses the REST reviews endpoint** (`POST /repos/{o}/{r}/pulls/{n}/reviews`) via `gh api --input -` with a JSON body carrying `event`, `body`, and `comments[]` (`path`/`line`/`body`). One atomic call; a bad inline anchor 422s the whole review, which is exactly why FR-002a pre-checks diffability.
- **`convertPullRequestToDraft` uses GraphQL** (spec-mandated): resolve `pullRequest.id` + `isDraft` via a query, short-circuit if already draft, then run the `convertPullRequestToDraft` mutation. Retry/auth pattern copied from `resolveReviewThread`.
- **Diffability pre-check** adds `listPullRequestFiles` (REST `pulls/{n}/files`, returns `patch` per file); `ReviewPoster` parses hunk headers to the commentable line set. Anchored-but-undiffable findings fall back to the body referencing their intended file/line (FR-002a, [Q1→A]).
- **`markedReadyByEngine` is in-memory state on `PrManager`** ("engine currently holds this PR ready"). `markReadyForReview` sets it true; `convertToDraftIfEngineMarkedReady` no-ops when false and clears it on a successful draft conversion. Worker-restart-mid-loop resets it to false → the engine errs toward *not* touching the PR (safe, per FR-008); documented limitation.
- **Round counter**: `reviewRound` starts at 1 and increments on each remediate→review backtrack in the loop.

## Next Step

`/speckit:tasks` to generate the dependency-ordered task list.

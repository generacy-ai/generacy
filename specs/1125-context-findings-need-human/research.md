# Research: PR review posting (COMMENT-event) + draft/ready lifecycle (#1125)

## Existing surface (grounded in code)

| Capability | Location | Reuse in #1125 |
|---|---|---|
| `listReviews(owner,repo,prNumber): Promise<Review[]>` (REST, paginated; `Review` has `id/user.login/body/state/submittedAt`) | `packages/workflow-engine/src/actions/github/client/gh-cli.ts:684` | FR-010 dedupe — grep bodies for marker + round |
| `getPRReviewThreads(...): Promise<ReviewThread[]>` (GraphQL; thread `id`, `isResolved`, `comments[]` with `body/path/line`) | `gh-cli.ts:577` | FR-009 — grep comment bodies for per-finding marker |
| `resolveReviewThread(threadId): Promise<void>` (GraphQL mutation, 3× backoff, auth-aware) | `gh-cli.ts:769` | FR-009 — resolve matched threads |
| `markPRReady(owner,repo,number)` (`gh pr ready` CLI) | `gh-cli.ts:533` | FR-005/007 via `PrManager.markReadyForReview` |
| `PrManager.markReadyForReview(linkedPRs?)` (idempotent, best-effort, fans out to siblings) | `pr-manager.ts:424` | FR-005/007/008 |
| `PrManager.markSiblingsReadyForReview` | `pr-manager.ts:453` | Sibling parity |
| Review/remediate stub branch `runStubPhase('review'\|'remediate')` | `phase-loop.ts:473` | Hook review side effects after it |
| `remediateTrigger?` + `i--`/`continue` backtrack | `phase-loop.ts:1154` | Hook draft-conversion on remediate entry; increment `reviewRound` |
| `PhaseLoopDeps` (holds `prManager`, `remediateTrigger`) | `phase-loop.ts:62` | Add `readFindingsArtifact?` seam |

**Confirmed absent** (must add): any `createReview`/`postReview`, any `convertPullRequestToDraft`/draft method, any PR-files-with-patch method (`getFilesChangedByOwnCommits` at `gh-cli.ts:1410` returns names only).

## Decision 1 — Artifact type home & source

**Decision**: Define `FindingsArtifact`/`ReviewFinding` **locally** in `packages/orchestrator/src/worker/review-findings-artifact.ts` with a Zod schema, and source it through an injectable `PhaseLoopDeps.readFindingsArtifact?: (context, round) => Promise<FindingsArtifact | null>` seam (default `undefined`).

**Rationale**: #1124 (the producer) is not merged; no `FindingsArtifact` type exists anywhere (`grep` for `FindingsArtifact`/`ReviewFinding`/`verdict` returns only the unrelated `pr-feedback-body-parser` domain). A local type unblocks #1125 without a cross-issue import cycle. The injectable seam mirrors the existing `remediateTrigger` seam and keeps the poster production-inert (the review executor is still a stub, so no artifact is produced yet). Zod validates the sidecar at the disk boundary.

**Alternatives**: (a) block on #1124 — rejected, serializes the epic unnecessarily. (b) put the type in `workflow-engine` now — rejected, #1124 will own the canonical definition; a premature workflow-engine export risks a conflicting shape when #1124 lands. Reconciliation is a one-line import swap + delete local, tracked as a follow-up note in the file.

## Decision 2 — `createReview` transport: REST, not GraphQL

**Decision**: Implement `createReview` against REST `POST /repos/{owner}/{repo}/pulls/{n}/reviews` via `gh api --method POST ... --input -` with a JSON body `{ event, body, comments: [{ path, line, side, body }] }`.

**Rationale**: The REST reviews endpoint accepts `event` + inline `comments[]` in one atomic submission keyed by owner/repo/number — no PR node-ID lookup, no multi-step draft-review dance. A single inline comment whose `line` is not in the diff 422s the whole submission (the exact #1047 constraint), which is precisely why FR-002a pre-checks diffability before building the payload. `gh api --input -` cleanly carries the nested `comments[]` array (indexed `-f` fields are awkward for arrays of objects).

**SC-001 guarantee**: `ReviewPoster` hardcodes `event: 'COMMENT'`. `createReview` accepts a general `event` param for reuse, but the #1125 call site and a unit test pin `COMMENT`. Harness asserts no submitted review carries `event: REQUEST_CHANGES`.

**Alternative**: GraphQL `addPullRequestReview` — rejected, needs node-ID resolution and a pending-review→submit two-step for inline threads; more moving parts for no gain here.

## Decision 3 — `convertPullRequestToDraft`: GraphQL with node-ID resolve + idempotency short-circuit

**Decision**: Spec-mandated GraphQL. Two steps: (1) query `repository(owner,name){ pullRequest(number:$n){ id isDraft } }`; if `isDraft` already true, return (idempotent no-op); (2) run `mutation($id:ID!){ convertPullRequestToDraft(input:{pullRequestId:$id}){ pullRequest{ id isDraft } } }`. Copy the `resolveReviewThread` retry (3× backoff) + `GhAuthError` handling. Method is best-effort at the `PrManager` call site (try/catch → warn).

**Rationale**: US3 AC and FR-006 explicitly name the GraphQL `convertPullRequestToDraft` mutation, whose input is the PR **node ID** (not number) — hence the resolve query. Fetching `isDraft` in the same query gives a cheap idempotency short-circuit and mirrors the ready-state semantics of `markPRReady`.

**Alternative**: `gh pr ready {n} --undo` (CLI, symmetric with `markPRReady`) — rejected because the spec pins GraphQL; noted only as a fallback if GraphQL proves flaky.

## Decision 4 — Diffability pre-check (FR-002a, [Q1→A])

**Decision**: Add `listPullRequestFiles(owner,repo,prNumber): Promise<PullRequestFile[]>` (REST `GET pulls/{n}/files?per_page=100 --paginate`, each file carries `filename` + `patch`). `ReviewPoster` parses each file's unified-diff hunk headers (`@@ -a,b +c,d @@`) to compute the set of commentable RIGHT-side line numbers per file. A finding is "postable inline" iff its `{file, line}` is in that set; otherwise it falls back to the review body referencing its intended file/line. No finding is ever dropped.

**Rationale**: A bad inline anchor 422s the entire atomic review (Decision 2). Deciding "postable inline" by diffability (not anchor-presence) is [Q1→A]. Hunk parsing is small and pure — unit-testable in isolation.

**Alternative**: attempt-then-retry-demote [Q1→B] — rejected by clarification (wastes a round, risks double-post). Silent anchor-drop [Q1→C] — rejected (anti-pattern).

## Decision 5 — Marker formats (FR-003) & dedupe (FR-010)

**Decision**: HTML-comment markers (mirrors existing `<!-- generacy-... -->` conventions):
- **Review body marker** (per round): `<!-- generacy-engine-review round=<N> -->` — a stable prefix (`generacy-engine-review`) + round number. Enables FR-010 dedupe and #1130's monitor exclusion.
- **Per-finding marker** (per inline comment): `<!-- generacy-finding:<markerId> -->`, `markerId` from the artifact's stable per-finding field. Enables FR-009 cross-round thread matching.

**Dedupe (FR-010)**: before posting round N, call `listReviews`, and skip posting iff some review body contains the round-N body marker (`round=<N>` with the stable prefix). Survives mid-review retry / worker restart, since GitHub is the source of truth for "already posted."

**Rationale**: [Q2→A] marker match (not path+line equality, which drifts/collides) for thread resolution; [Q4→A] marker+round for round-level idempotency. Body marker is greppable per SC-004; round number per SC-006.

## Decision 6 — `markedReadyByEngine` flag home (FR-006, [Q3→B])

**Decision**: In-memory boolean on `PrManager` (alongside `prNumber`/`prUrl`). `markReadyForReview` sets it `true` on success. New `convertToDraftIfEngineMarkedReady(linkedPRs?)` no-ops when `false`; on a successful draft conversion it sets the flag `false` (engine no longer holds the PR ready); a failed conversion leaves it `true` (best-effort retry on a later remediate entry). The flag semantics: "the engine has marked this PR ready and has not yet reverted it."

**Rationale**: [Q3→B] never touch a PR the engine did not mark ready (human-marked-ready PRs untouched). `PrManager` already persists mutable PR state for the whole `executeLoop`, so an in-memory flag is the minimal faithful implementation. Worker-restart-mid-loop resets the flag → engine won't convert to draft even if it had marked ready before the restart; this is a safe over-conservatism (best-effort, FR-008) documented in the plan and file.

**Alternative**: Redis via `phaseTracker` — rejected as over-engineered for a within-run flag; live-state query [Q3→C] and unconditional convert [Q3→A] both rejected by clarification (they'd disturb human-marked-ready PRs).

## Decision 7 — Where side effects hook in the phase loop

- **Post review + mark-ready**: immediately after `runStubPhase('review')` succeeds. Read the artifact (seam); if present: `ReviewPoster.postRound(artifact, round)`; if `artifact.verdict === 'clean'` call `prManager.markReadyForReview(context.linkedPRs)`; if `round >= 2` call `ReviewPoster.resolveResolvedThreads(artifact)`. Because `review` is linear and sits right before `validate`, "end of review phase" naturally precedes validate (FR-005/US2, SC-002).
- **Convert to draft**: inside the existing `remediateTrigger` block (`phase-loop.ts:1154`), on remediate entry, before `runStubPhase('remediate')`: `await prManager.convertToDraftIfEngineMarkedReady(context.linkedPRs)` (FR-006/US3, SC-003). Increment `reviewRound` on the `i--` backtrack so the re-entered review is round N+1.

**Rationale**: reuses the seams #1121/#1123 already built; no new phase-loop control flow, only side-effect calls at established points. Keeps behaviour byte-identical when `readFindingsArtifact` is `undefined` (production-inert).

## Verdict source (FR-005, [Q5→A])

Mark-ready/stay-draft reads the artifact's single explicit `verdict: clean|changes-required` field only; #1125 never re-derives it from per-finding severity. #1124 already folds advisory-only rounds into `verdict=clean`.

## Sibling PRs

Ready/draft transitions fan out to `linkedPRs` with the same semantics (`markSiblingsReadyForReview` for ready; `convertToDraftIfEngineMarkedReady` iterates siblings for draft), per Assumptions.

## Key sources

- Spec + clarifications: `specs/1125-context-findings-need-human/{spec.md,clarifications.md}`.
- Epic + siblings referenced: #1120 (epic), #1124 (executor/artifact), #1126 (delta re-review), #1128 (remediate executor), #1130 (monitor exclusion), #1133 (merge-readiness), #1047 (own-PR 422 / review-body constraint, `listReviews`).
- Phase machinery: `specs/1121-context-worker-phase-machine/`, `specs/1123-context-phase-1-integration/contracts/remediate-review-seam.md`.

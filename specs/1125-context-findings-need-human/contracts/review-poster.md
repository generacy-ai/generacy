# Contract: ReviewPoster & phase-loop side effects (#1125)

Package: `@generacy-ai/orchestrator` (internal — no public exports).

## Marker formats (FR-003 — stable, greppable, documented for #1130)

- **Review body marker** (once per review body): `<!-- generacy-engine-review round=<N> -->`
  - Stable prefix `generacy-engine-review` → #1130 monitor exclusion; SC-004.
  - `round=<N>` → SC-006 + FR-010 dedupe key.
- **Per-finding marker** (once per inline comment body): `<!-- generacy-finding:<markerId> -->`
  - `markerId` = the artifact finding's `marker`; → FR-009 cross-round match.

## ReviewPoster.postRound(artifact, round) — FR-001–004, FR-010

1. **Dedupe (FR-010)**: `reviews = await github.listReviews(...)`. If any `review.body` contains `round=<N>` with the body-marker prefix → **skip** (already posted; survives retry/restart). Log debug, return.
2. **Diffability (FR-002a)**: `files = await github.listPullRequestFiles(...)`; `diffable = computeDiffableLines(files)`.
3. **Partition**: inline iff `finding.anchor` present AND `diffable.get(anchor.file)?.has(anchor.line)`; else body.
4. **Build** one `CreateReviewInput`:
   - `event: 'COMMENT'` (hardcoded — SC-001).
   - `body`: body marker + `Round <N>` header + each body finding rendered with a severity tag; **advisory** findings clearly marked non-blocking and visually distinct from **blocking** (FR-004). Body-fallback findings reference their intended `file:line` (FR-002a).
   - `comments[]`: one per inline finding — `path`, `line`, `side: 'RIGHT'`, body = per-finding marker + text + severity tag.
5. **Post**: `await github.createReview(...)` — exactly one review (US1 AC5). Best-effort at the call site (warn on failure, never fail the workflow — FR-008).

## ReviewPoster.resolveResolvedThreads(artifact) — FR-009 (round ≥ 2 only)

1. `threads = await github.getPRReviewThreads(...)`.
2. For each finding with `resolved === true`: find the thread whose any comment body contains `<!-- generacy-finding:<marker> -->`.
3. If matched and not already `isResolved`: `await github.resolveReviewThread(thread.id)`.
4. Findings NOT marked resolved → leave their threads untouched (US4 AC2). Each resolve is independent + best-effort — one failure logs a warning and does not block the others or the workflow (US4 AC3 / FR-008).

## Phase-loop wiring (`phase-loop.ts`)

**`reviewRound` counter**: local to `executeLoop`, starts `1`; increment on each remediate→review `i--` backtrack.

**After `runStubPhase('review')` succeeds** (only when `deps.readFindingsArtifact` is defined):
```
artifact = await deps.readFindingsArtifact(context, reviewRound)
if artifact:
    await reviewPoster.postRound(artifact, reviewRound)        // FR-001–004,010
    if reviewRound >= 2: await reviewPoster.resolveResolvedThreads(artifact)  // FR-009
    if artifact.verdict === 'clean':
        await prManager.markReadyForReview(context.linkedPRs)   // FR-005 — before validate (linear order)
```

**On remediate entry** (inside the existing `remediateTrigger` block, before `runStubPhase('remediate')`):
```
await prManager.convertToDraftIfEngineMarkedReady(context.linkedPRs)  // FR-006
```

**Inertness invariant**: when `deps.readFindingsArtifact` is `undefined` (production, pre-#1124), none of the above runs — loop behaviour is byte-identical to today.

## PrManager (`pr-manager.ts`) — FR-006/007/008

- `markReadyForReview` (existing): set `this.markedReadyByEngine = true` on the primary success path.
- `convertToDraftIfEngineMarkedReady(linkedPRs?)`: no-op if `!markedReadyByEngine`. Else best-effort `github.convertPullRequestToDraft` for primary + each parsed sibling; on primary success set `markedReadyByEngine = false`. All failures → warn, never throw.

## Test contract

- `review-poster.test.ts` (mock `GitHubClient`, fake artifact):
  - SC-001: submitted review `event === 'COMMENT'`, never `REQUEST_CHANGES`.
  - Exactly one `createReview` per `postRound` (US1 AC5).
  - Diffable anchor → inline comment; undiffable/absent anchor → body reference; no finding dropped (FR-002/002a).
  - Body carries `<!-- generacy-engine-review round=<N> -->` (SC-004) + round N (SC-006); advisory visually distinct (FR-004).
  - FR-010: second `postRound` for a round whose marker exists → no `createReview`.
  - FR-009: only `resolved` findings' threads resolved, matched by marker (SC-005); one resolve failure doesn't block others.
- `pr-manager.draft.test.ts`: convert no-ops when flag false; converts + clears flag when true; failure is best-effort; siblings covered.
- `phase-loop.review-side-effects.integration.test.ts`: SC-002 clean → ready before validate; SC-003 remediate-entry-after-ready → draft; inert when reader undefined.

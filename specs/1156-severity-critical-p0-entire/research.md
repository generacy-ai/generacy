# Research: Wire the PR review-posting + draft/ready lifecycle

All line refs at develop `155b3464`. Every decision below is grounded in the current code, not the spec's assumptions.

## Decision 1 — Where the reader lives (FR-001)

**Chosen**: A closure in `claude-cli-worker.ts`'s `PhaseLoopDeps` object, delegating to a pure `bridgeReviewArtifact()` in a new `review-findings-bridge.ts`.

**Why**: The dead guard is `phase === 'review' && result.success && deps.readFindingsArtifact && deps.reviewPoster` (`phase-loop.ts:1591-1596`). The poster is wired (`claude-cli-worker.ts:868`); the reader is not. The existing `remediateTrigger` closure (`claude-cli-worker.ts:860-864`) already reads the sidecar with `readReviewArtifactSync(ctx.checkoutPath, ` `${ctx.item.owner}/${ctx.item.repo}#${ctx.item.issueNumber}` `)` — the reader uses the async `readReviewArtifact` with the identical workflowId, then bridges. The worker has `orchSettings` + `effectiveConfig` in scope, so it resolves `blockingSeverity` once and closes over it.

**Alternatives rejected**:
- Bridge inline in the closure — the mapping (severity threshold, marker hash, anchor derivation) is the FR-002/003 logic worth unit-testing (SC-002); burying it in a closure makes it untestable without a full loop.
- A new `PhaseLoop` method — the loop must stay decoupled from the sidecar shape and the workflow-specific `blockingSeverity`; injection via the existing `readFindingsArtifact` seam is the established pattern (mirrors `remediateTrigger`).

## Decision 2 — Severity → blocking/advisory (FR-002, Q1=A)

**Chosen**: `SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[blockingSeverity] ? 'blocking' : 'advisory'`, reusing the exported `SEVERITY_RANK` from `review-artifact.ts:272` (`critical:3, major:2, minor:1`).

**Why**: `computeVerdict` (`review-artifact.ts:280-289`) already classifies "blocking" with this exact threshold. The spec Assumptions originally hardcoded `critical|major = blocking`, which disagrees with `computeVerdict` at the default `blockingSeverity=critical` (there `major` is *not* blocking). Q1=A resolves to the threshold so a `major` finding never renders "blocking" on a PR `computeVerdict` scored `clean`.

**Source of `blockingSeverity`**: `resolveWorkflowOverrides(effectiveConfig, orchSettings, item.workflowName).review.blockingSeverity`. This resolution already runs in the worker for the `ReviewExecutor`/`RemediateExecutor` (`claude-cli-worker.ts:821-846`); the reader closure reuses the same resolved value.

## Decision 3 — Per-finding marker (FR-003, Q2=A)

**Chosen**: `marker = createHash('sha256').update(`${file}\0${title}`).digest('hex').slice(0, 24)`.

**Why**: `ReviewArtifact` findings carry no id (`ReviewFindingSchema`, `review-artifact.ts:32-40`). The `FindingsArtifact.ReviewFinding.marker` is embedded in the inline comment via `findingMarker()` (`review-poster.ts:31-33`) and grepped back for cross-round thread resolution (`resolveResolvedThreads`, `review-poster.ts:288-291`). Keying on `file`+`title` is stable through `line`/`detail` drift between rounds (a fix that shifts lines / reworded detail keeps the same marker → the prior thread resolves). The `\0` separator prevents `("a", "bc")` colliding with `("ab", "c")`. 24 hex chars (96 bits) is ample collision resistance for per-PR finding counts and matches the id-length convention used elsewhere in the codebase (`gate-id` 24 hex).

**Alternatives rejected**: `file+line+title` (B) and `file+title+detail` (C) both mint a *new* marker on line shift / wording change, orphaning the prior round's thread — the exact re-review breakage FR-003 exists to prevent.

## Decision 4 — Live PR number (FR-004, Q3=A)

**Chosen**: Replace `ReviewPoster`'s `private readonly prNumber: number` with `private readonly getPrNumber: () => number | undefined`. At the top of `postRound` and `resolveResolvedThreads`, resolve `const prNumber = this.getPrNumber(); if (prNumber === undefined) { log.debug(...); return; }`.

**Why**: Today `ReviewPoster` is constructed with `prManager.getPrNumber() ?? 0` (`claude-cli-worker.ts:751`) — **before** the PR exists, so `getPrNumber()` returns `undefined` and the poster captures `0`. Early rounds would post to PR #0. `PrManager.getPrNumber()` already returns `number | undefined` (`pr-manager.ts:68-70`) and is populated once the PR is created/resolved. A getter closes over `prManager` and resolves live per call. No method signature changes (SC-003 / the poster's public surface is unchanged), and the poster is inert before a PR exists (returns early) rather than silently targeting #0.

**Wiring**: `new ReviewPoster({ github, owner, repo, getPrNumber: () => prManager.getPrNumber(), logger })`.

## Decision 5 — Round from the sidecar (FR-005, Q4=A)

**Chosen**: `readFindingsArtifact` returns `{ artifact: FindingsArtifact; round: number } | null`; the block destructures and passes `round`.

**Why**: The loop-local `reviewRound` starts at 1 and resets each run (`phase-loop.ts:330`, incremented only on the in-run remediate backtrack at `:1677`). After a pause/re-entry it is 1 again, so `isRoundAlreadyPosted` (`review-poster.ts:189-192`) dedupe-skips a genuine re-review round, and the `round >= 2` thread-resolution gate (`phase-loop.ts:1600`) never fires on re-entry. The sidecar's `round` (`ReviewArtifact.round`, monotonic, `review-artifact.ts:49`) is authoritative. Returning it alongside the bridged artifact keeps it with the single existing `readReviewArtifact` read — B (add `round` to `FindingsArtifact`) mutates an out-of-scope shared shape; C (a separate raw read in the block) does a redundant read.

**Signature change**: `readFindingsArtifact?: (context: WorkerContext) => Promise<{ artifact: FindingsArtifact; round: number } | null>`. The old `round` input parameter is dropped (the round is now an output, derived from the sidecar).

## Decision 6 — Cross-run `markedReadyByEngine` (FR-006/FR-007, Q5=A)

**Chosen**: Persist the flag in the sidecar. Three coordinated changes:
1. `ReviewArtifactSchema` gains `markedReadyByEngine: z.boolean().default(false)` (`review-artifact.ts`). `.default(false)` is load-bearing — pre-#1156 artifacts lack the field and must still parse (else `readReviewArtifact` returns `null` and the whole block silently dies).
2. New helper `setMarkedReadyByEngine(checkoutPath, workflowId, value)` (read → `{ ...artifact, markedReadyByEngine: value }` → atomic write; null-safe no-op if no artifact).
3. `PrManager` gains an optional `workflowId?` ctor arg. `markReadyForReview` success → also `setMarkedReadyByEngine(..., true)` (best-effort). `convertToDraftIfEngineMarkedReady` → if the in-memory flag is false but `checkoutPath`+`workflowId` are present, reconstruct from `readReviewArtifact(...)?.markedReadyByEngine`; on a successful convert, persist `false` too.

**Why**: `markedReadyByEngine` is in-memory per run today (`pr-manager.ts:41`), so a later `address-pr-feedback` re-entry in a *new* run can't tell whether the engine or a human marked the PR ready and never converts it back to draft on a remediate round. The sidecar is the named source of truth for cross-run lifecycle state (spec Assumptions). Because the flag is only ever set true by the engine's own `markReadyForReview`, reconstructing from it is safe for FR-007 (a human `gh pr ready` never writes the sidecar). B (derive from live PR state + marker presence) is fragile — a human could mark ready on a PR that also carries an engine round marker from an earlier round; the explicit flag is unambiguous.

**Executor carry-forward (D-7)**: The review executor rewrites the whole artifact each round with an explicit object (`review-executor.ts:244-250`), carrying only named fields. It must add `markedReadyByEngine: priorRound?.markedReadyByEngine ?? false`, else the flag resets on every re-review pass. `bumpRemediationCount`/`resetRemediationCount` (`review-artifact.ts:102-135`) already spread `...artifact`, so they preserve the field without change.

## Decision 7 — Inertness guarantees (FR-009)

Two independent off-switches, both already present: (a) `reviewPhaseEnabled=false` (default) keeps `review` out of `getPhaseSequence` (`claude-cli-worker.ts:802`) so the block's `phase === 'review'` never matches; (b) if review runs but produces no sidecar, `readReviewArtifact` returns `null` → the reader returns `null` → the block no-ops. No new flag introduced. FR-008's best-effort contract is inherited: `postRound`/`resolveResolvedThreads` already wrap everything in try/catch and swallow (`review-poster.ts:224-265`), and the new `setMarkedReadyByEngine` calls are best-effort in `PrManager` (log-and-continue).

## Test strategy

- **Pure bridge** (`review-findings-bridge.test.ts`, SC-002): every input finding lands in `inline ∪ body` — assert one output `ReviewFinding` per input; severity-threshold matrix (`critical/major/minor` × `blockingSeverity ∈ {critical, major, minor}`); anchor present iff `line` present; `status:'resolved'` → `resolved:true`; marker stability across `line`/`detail` drift + distinctness across different `title`.
- **Getter** (`review-poster.get-pr-number.test.ts`, SC-003): getter returning `undefined` → no `createReview` / `getPRReviewThreads` call; getter returning a real number mid-flow → post targets that number; never 0.
- **Sidecar flag** (`review-artifact.marked-ready.test.ts`): round-trip persist/read; malformed/old artifact (no field) parses with `false`; carry-forward across a simulated executor rewrite.
- **Cross-run draft** (`pr-manager.cross-run-draft.test.ts`, SC-005/SC-006): fresh `PrManager` (in-memory flag false) + sidecar `markedReadyByEngine:true` → convert fires; sidecar flag false (human ready) → convert no-ops.
- **End-to-end block** (`phase-loop.review-side-effects.test.ts`, SC-001/SC-004): reader returns `{ artifact, round }`; clean verdict → exactly one `createReview` with `event:'COMMENT'` + `markReadyForReview`; re-entry with sidecar `round≥2` → fresh post (no dedupe-skip) + `resolveResolvedThreads` invoked.

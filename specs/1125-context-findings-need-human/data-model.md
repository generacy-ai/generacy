# Data Model: PR review posting (COMMENT-event) + draft/ready lifecycle (#1125)

All new types are TypeScript. The findings-artifact types are the **consuming contract** for #1124 (defined locally in `packages/orchestrator/src/worker/review-findings-artifact.ts` until #1124 exports them); the GitHub-client types live in `@generacy-ai/workflow-engine`.

## 1. Findings artifact (consumed from #1124)

```ts
// packages/orchestrator/src/worker/review-findings-artifact.ts
// NOTE: consuming contract for #1124's review executor. Swap to an import from
// @generacy-ai/workflow-engine once #1124 lands the canonical type; delete this local copy.

export type FindingSeverity = 'blocking' | 'advisory';
export type ReviewVerdict = 'clean' | 'changes-required';

export interface FindingAnchor {
  file: string;   // repo-relative path
  line: number;   // 1-based line in the file's post-change (RIGHT) side
}

export interface ReviewFinding {
  /** Stable per-finding marker/ID; embedded in the inline comment body for
   *  cross-round thread matching (FR-003/FR-009). Non-empty. */
  marker: string;
  /** Human-readable finding text rendered in the comment/body. */
  text: string;
  severity: FindingSeverity;           // 'advisory' rendered visually distinct (FR-004)
  anchor?: FindingAnchor;              // absent → body-only
  /** Present on re-review rounds (≥ 2); true → resolve its thread (FR-009). */
  resolved?: boolean;
}

export interface FindingsArtifact {
  /** Sole driver of mark-ready/stay-draft (FR-005, [Q5→A]); never re-derived. */
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
}
```

**Zod schema** (validate the sidecar at the disk boundary):

```ts
export const FindingAnchorSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
});

export const ReviewFindingSchema = z.object({
  marker: z.string().min(1),
  text: z.string(),
  severity: z.enum(['blocking', 'advisory']),
  anchor: FindingAnchorSchema.optional(),
  resolved: z.boolean().optional(),
});

export const FindingsArtifactSchema = z.object({
  verdict: z.enum(['clean', 'changes-required']),
  findings: z.array(ReviewFindingSchema),
});
```

**Validation rules**
- `marker` non-empty (required to match threads across rounds).
- `anchor.line` positive integer; an anchor present but **not diffable** is not an error — it triggers body fallback (FR-002a).
- `resolved` meaningful only on rounds ≥ 2; ignored on round 1.
- `verdict` is authoritative; the poster/lifecycle never inspects per-finding severity to compute readiness.

## 2. GitHub client additions (`@generacy-ai/workflow-engine`)

### 2a. `CreateReviewInput` / `CreateReviewComment` (new, `types/github.ts`)

```ts
export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface CreateReviewComment {
  path: string;
  line: number;
  side?: 'RIGHT' | 'LEFT';  // default RIGHT
  body: string;
}

export interface CreateReviewInput {
  event: ReviewEvent;        // #1125 always passes 'COMMENT'
  body: string;              // carries the engine body marker + round number
  comments?: CreateReviewComment[];  // inline threads (diffable anchors only)
}
```

`Review` / `ReviewSubmissionState` / `ReviewThread` / `Comment` / `PullRequest.draft` already exist (`types/github.ts:60,126,157`) and are reused unchanged.

### 2b. `PullRequestFile` (new, for diffability)

```ts
export interface PullRequestFile {
  filename: string;
  status: string;            // added | modified | removed | renamed ...
  patch?: string;            // unified-diff hunks; absent for binary/too-large
}
```

### 2c. New `GitHubClient` methods (`interface.ts` + `gh-cli.ts`)

```ts
createReview(owner: string, repo: string, prNumber: number, input: CreateReviewInput): Promise<Review>;
convertPullRequestToDraft(owner: string, repo: string, prNumber: number): Promise<void>;
listPullRequestFiles(owner: string, repo: string, prNumber: number): Promise<PullRequestFile[]>;
```

## 3. `ReviewPoster` (new, orchestrator worker)

```ts
// packages/orchestrator/src/worker/review-poster.ts
export interface ReviewPosterDeps {
  github: GitHubClient;
  owner: string;
  repo: string;
  prNumber: number;
  logger: Logger;
}

export class ReviewPoster {
  /** Post exactly one COMMENT review for `round` (FR-001–004,010).
   *  Deduped: skips if a review body already carries this round's marker. */
  postRound(artifact: FindingsArtifact, round: number): Promise<void>;

  /** On re-review (round ≥ 2): resolve threads whose finding is marked resolved,
   *  matched by per-finding marker in getPRReviewThreads comment bodies (FR-009). */
  resolveResolvedThreads(artifact: FindingsArtifact): Promise<void>;
}
```

**Pure helpers (unit-tested in isolation):**
- `computeDiffableLines(files: PullRequestFile[]): Map<string, Set<number>>` — parse hunk headers → RIGHT-side commentable lines per file.
- `partitionFindings(findings, diffable): { inline: ReviewFinding[]; body: ReviewFinding[] }` — inline iff `anchor` present AND `diffable.get(file)?.has(line)`.
- `buildReviewBody(bodyFindings, round): string` — body marker `<!-- generacy-engine-review round=<N> -->` + round header + advisory/blocking-distinct rendering of body findings.
- `buildInlineComment(finding): CreateReviewComment` — comment body = per-finding marker `<!-- generacy-finding:<marker> -->` + text + severity tag.
- `isRoundAlreadyPosted(reviews, round): boolean` — grep review bodies for the round marker.

## 4. `PrManager` additions (orchestrator worker)

```ts
private markedReadyByEngine = false;   // "engine currently holds this PR ready"

// existing markReadyForReview() sets markedReadyByEngine = true on success

async convertToDraftIfEngineMarkedReady(linkedPRs?: LinkedPR[]): Promise<void>;
// no-op if !markedReadyByEngine; else best-effort github.convertPullRequestToDraft for
// primary + each sibling; clears the flag on primary success (FR-006/008).
```

## 5. `PhaseLoopDeps` addition (orchestrator worker)

```ts
// worker/types.ts (PhaseLoopDeps, phase-loop.ts:62)
readFindingsArtifact?: (context: WorkerContext, round: number) => Promise<FindingsArtifact | null>;
// default undefined → poster never invoked → production-inert until #1124.
```

`reviewRound` is a local loop counter in `executeLoop` (starts 1, ++ on each remediate→review backtrack) — not a persisted entity.

## Relationships

```
FindingsArtifact ──(readFindingsArtifact seam)──> phase-loop review block
   ├─ verdict ─────────────────────────────────> PrManager.markReadyForReview / stay-draft
   └─ findings[] ──> ReviewPoster.postRound ──> GitHubClient.createReview (1 COMMENT review/round)
                       │   (uses listPullRequestFiles → diffable line set → inline vs body split)
                       └─ resolveResolvedThreads ──> getPRReviewThreads (marker grep) ──> resolveReviewThread

remediateTrigger fires ──> PrManager.convertToDraftIfEngineMarkedReady ──> GitHubClient.convertPullRequestToDraft
```

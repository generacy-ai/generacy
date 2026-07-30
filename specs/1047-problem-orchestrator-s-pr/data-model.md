# Data Model: PR-feedback fixer consumes review bodies

**Feature**: #1047
**Branch**: `1047-problem-orchestrator-s-pr`

Types below are the load-bearing interfaces for the new parsers, gate, and client extension. All types are TypeScript, ESM, and follow existing conventions in their target packages.

## Wire types (workflow-engine, `packages/workflow-engine/src/types/github.ts`)

### `ReviewSubmissionState`

```typescript
export type ReviewSubmissionState =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'COMMENTED'
  | 'DISMISSED'
  | 'PENDING';
```

Mirrors GitHub REST's `state` field on `pulls/{n}/reviews` responses. Consumers filter to `{CHANGES_REQUESTED, COMMENTED}` per D2.

### `Review`

```typescript
/**
 * A GitHub PR review submission, as returned by
 * `GET /repos/{owner}/{repo}/pulls/{n}/reviews`. Represents the top-level
 * submission with its body — DISTINCT from inline review-thread comments
 * (see `ReviewThread` for those). Used by the PR-feedback body-consumption
 * path (#1047).
 *
 * Note: `submissionState === 'PENDING'` reviews are not returned by the
 * list endpoint and are omitted from this union in practice, but included
 * in the type for exhaustiveness.
 */
export interface Review {
  /** Stable GitHub identifier. Used as the acknowledgment key (#1047 FR-008). */
  id: number;
  /** Reviewer login. Used for per-author supersession (Q3 answer). */
  user: {
    login: string;
  };
  /**
   * Review body text. Empty string when the reviewer submitted with no
   * top-level body (e.g. inline-only review). Consumers skip empty bodies.
   */
  body: string;
  /** Submission state. Consumers filter to CHANGES_REQUESTED + COMMENTED. */
  state: ReviewSubmissionState;
  /** ISO-8601 timestamp. Used for per-author "newest" tie-breaking. */
  submittedAt: string;
}
```

**Validation rules**:
- `id` MUST be a positive integer (GitHub invariant).
- `user.login` MUST be a non-empty string.
- `body` MAY be empty (skipped by consumer).
- `state` MUST be one of the enum values.
- `submittedAt` MUST be a parseable ISO-8601 timestamp.

**Non-goals**:
- No `commitId`, `nodeId`, or `pullRequestUrl` — none load-bearing for this feature.
- No inline `comments` array — inline comments are separately fetched via `getPRReviewThreads`; conflating the two increases the payload and confuses semantics.

## Client extension (workflow-engine, `packages/workflow-engine/src/actions/github/client/interface.ts`)

### `GitHubClient.listReviews`

```typescript
/**
 * List all submitted reviews on a PR via
 * `GET /repos/{owner}/{repo}/pulls/{number}/reviews`.
 *
 * Returns review submissions — inline comment threads are NOT included;
 * use `getPRReviewThreads` for those. Paginated internally when the
 * response exceeds per-page limits.
 *
 * Consumers typically filter to `state ∈ {CHANGES_REQUESTED, COMMENTED}`
 * — see PR-feedback body-consumption path (#1047).
 *
 * @throws GhAuthError on HTTP 401 or 403.
 * @throws Error on any other non-zero exit.
 */
listReviews(owner: string, repo: string, prNumber: number): Promise<Review[]>;
```

## Handler-local types (orchestrator, `packages/orchestrator/src/worker/pr-feedback-body-parser.ts`)

### `ParsedFinding`

```typescript
/**
 * A single `### Finding <n>` sub-block extracted from a review body's
 * `<!-- generacy-cockpit:unanchored-findings -->` marker section.
 */
export interface ParsedFinding {
  /**
   * 1-based ordinal within the review body's finding list.
   * Load-bearing for the acknowledgment key (#1047 FR-008): the tuple
   * `(reviewer, reviewId, index)` uniquely identifies a finding across
   * cycles.
   */
  index: number;
  /**
   * Paths named on the `**Files:** path/one, path/two` line under this
   * finding. Empty when `hasFilesLine` is false.
   *
   * Paths are trimmed of surrounding whitespace; not otherwise
   * canonicalized (no `path.resolve`, no case-fold — GitHub file paths
   * are case-sensitive and workspace-relative).
   */
  files: string[];
  /**
   * True when the `**Files:**` line was present under this finding.
   * When false, this finding contributes zero constraints to FR-003
   * per FR-005 (fail-open).
   */
  hasFilesLine: boolean;
}
```

### `ParsedReview`

```typescript
/**
 * The parsed shape of a single review body. Findings are empty when the
 * `<!-- generacy-cockpit:unanchored-findings -->` marker is absent
 * (fail-open per FR-005). Findings may also be non-empty with all
 * entries having `hasFilesLine: false` (marker present, older producer).
 */
export interface ParsedReview {
  /** Stable GitHub identifier. Sourced from `Review.id`. */
  reviewId: number;
  /** Reviewer login. Sourced from `Review.user.login`. */
  reviewer: string;
  /** ISO-8601 timestamp. Sourced from `Review.submittedAt`. */
  submittedAt: string;
  /** Ordered list of findings extracted from the marker block. */
  findings: ParsedFinding[];
}
```

**Parser contract**:
- Input `Review` → output `ParsedReview`.
- Absent marker → `findings: []`.
- Marker present, zero `### Finding <n>` sub-headings → `findings: []`.
- Marker present, N sub-headings → `findings.length === N`, ordered by heading appearance, with `index` = 1..N.
- `**Files:**` line under a sub-heading → split on `,`, trim each, drop empties → `files: string[]`, `hasFilesLine: true`.
- No `**Files:**` line under a sub-heading → `files: []`, `hasFilesLine: false`.

## Acknowledgment set (orchestrator, `packages/orchestrator/src/worker/pr-feedback-ack-parser.ts`)

### `AcknowledgedFindings`

```typescript
/**
 * Set of finding identity keys, one per acknowledged finding. Key format:
 * `${reviewer}:${reviewId}:${index}` — must match the key
 * `pr-feedback-body-gate` uses to test membership.
 *
 * Sourced from the newest `<!-- generacy-cockpit:body-findings-unaddressed -->`
 * top-level PR comment. Empty when no such comment exists.
 */
export type AcknowledgedFindings = ReadonlySet<string>;
```

### `AcknowledgmentEntry` (internal, serialized in the marker comment body)

```typescript
/**
 * One row in the marker comment's machine-readable enumeration.
 * Serialized in the comment body as a fenced markdown list; parsed on
 * resume.
 */
export interface AcknowledgmentEntry {
  reviewer: string;
  reviewId: number;
  findingIndex: number;
}
```

**Ack-parser contract**:
- Input: `commentBodies: string[]` (as returned by `listPrCommentBodies`).
- Filter to bodies containing `<!-- generacy-cockpit:body-findings-unaddressed -->`.
- Take the last such body by array order (monitor pattern: `listPrCommentBodies` returns chronological).
- Parse the enumeration section into `AcknowledgmentEntry[]`.
- Emit as `AcknowledgedFindings` with keys built as `${reviewer}:${reviewId}:${findingIndex}`.
- Empty input, no matching bodies, or parse failure → return empty set (fail-open).

## Gate result (orchestrator, `packages/orchestrator/src/worker/pr-feedback-body-gate.ts`)

### `UnaddressedFinding`

```typescript
/**
 * A single finding that the FR-003 gate flagged as unaddressed. Included
 * verbatim in the Disposition C marker comment for operator triage and
 * for the acknowledgment set on resume.
 */
export interface UnaddressedFinding {
  reviewer: string;
  reviewId: number;
  findingIndex: number;
  /** Files named on the finding. Non-empty by construction (if this list
   * were empty, the finding would not have gated per FR-005). */
  namedFiles: string[];
}
```

### `GateResult`

```typescript
export type GateResult =
  | { satisfied: true }
  | { satisfied: false; unaddressed: UnaddressedFinding[] };
```

**Gate-evaluator contract**:

```typescript
function evaluateBodyGate(input: {
  parsedReviews: ParsedReview[];
  commitTouchedFiles: ReadonlySet<string>;
  acknowledged: AcknowledgedFindings;
}): GateResult;
```

Semantics (per FR-003 + Q3 + Q5 + Q6):

1. **Per-author newest.** Group `parsedReviews` by `reviewer`. For each group, keep only the review with the max `submittedAt`. Discard the rest.
2. **Filter gating findings.** For each retained review, filter its `findings` to those with `hasFilesLine === true`. Findings without a `**Files:**` line contribute zero constraints (FR-005).
3. **Filter acknowledged.** From the remaining findings, drop any whose key `${reviewer}:${reviewId}:${index}` is in `acknowledged`. Acknowledged findings do not gate (FR-008).
4. **Per-finding satisfaction.** A finding is *satisfied* iff at least one path in its `files` array is a member of `commitTouchedFiles`. Otherwise unsatisfied.
5. **Overall satisfaction.** All remaining findings must be satisfied for `{satisfied: true}`. If any is unsatisfied, return `{satisfied: false, unaddressed: [...]}` listing every unsatisfied finding.

Corollaries:
- Zero reviews, or all reviews filtered out by steps 2/3 → `{satisfied: true}` (trivially — nothing to gate).
- A review from one author does not affect a review from a different author (Q3).
- A finding in `acknowledged` still reaches the prompt via FR-002 — the gate is separate from the prompt, and the prompt inclusion is upstream of gate evaluation.

## Marker comment shape (Disposition C)

The comment posted on Disposition C carries the marker header + a human-readable summary + a machine-parseable enumeration. Example:

```markdown
<!-- generacy-cockpit:body-findings-unaddressed -->

⚠️ **Body findings not yet addressed by the fixer**

The fixer completed this cycle without touching any file named by the
following review-body findings. To unblock:

- Address the findings manually, OR
- Remove the `blocked:body-finding-unaddressed` label to acknowledge —
  a subsequent NEW review from the same author will re-gate its findings.

### Unaddressed findings

- `bot-login` review #123456789 finding 1 (files: `path/to/foo.md`)
- `bot-login` review #123456789 finding 3 (files: `packages/x/src/y.ts`)
- `human-reviewer` review #123456790 finding 2 (files: `README.md`, `docs/plan.md`)

_This is an automated notice from the PR-feedback body-consumption path (#1047)._
```

The list under `### Unaddressed findings` is the machine-readable enumeration. Each line matches:

```
- `<reviewer>` review #<reviewId> finding <findingIndex>(files: ...)
```

Ack-parser regex: `^- `([^`]+)` review #(\d+) finding (\d+)`. The `(files: ...)` trailing suffix is human decoration and NOT parsed (files are already carried by the ParsedReview's findings; the ack set only needs identity).

## Relationships

```
Review (wire, from GitHub REST)
  │
  ▼ parseReviewBody()
ParsedReview
  │
  │  ┌───────────────────────────┐
  │  │ AcknowledgedFindings      │
  │  │  (from marker comments)   │
  │  └────────────┬──────────────┘
  │               │
  ▼               ▼
evaluateBodyGate(parsedReviews, commitTouchedFiles, acknowledged)
  │
  ▼
GateResult
  ├─ satisfied: true  → happy path (reply/resolve loop)
  └─ satisfied: false → Disposition C
                          ├─ addLabels(['blocked:body-finding-unaddressed'])
                          └─ postPrComment(bodyFindingsUnaddressedMarker + unaddressed[])
                                (idempotent via listPrCommentBodies marker grep)
```

## Existing types reused unchanged

- `Comment` (from `@generacy-ai/workflow-engine`) — the prompt-item shape that `buildFeedbackPrompt` accepts. Review bodies are converted to `Comment`-shaped items with `path: undefined, line: undefined` and rendered as `'general comment'` per the existing renderer at `pr-feedback-handler.ts:442-444`.
- `ReviewThread` — unchanged; the existing thread fetch flow is untouched.
- `PrFeedbackMetadata` — unchanged; no new fields flow through the queue.
- `QueueItem` — unchanged.

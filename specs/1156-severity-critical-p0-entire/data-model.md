# Data Model: Wire the PR review-posting + draft/ready lifecycle

## Entities

### `ReviewArtifact` (engine-written sidecar — MODIFIED)

`packages/orchestrator/src/worker/review-artifact.ts`. Path: `<checkoutPath>/.generacy/review-findings-<sanitized-workflowId>.json`. WorkflowId = `${owner}/${repo}#${issueNumber}`.

| Field | Type | Change | Notes |
|-------|------|--------|-------|
| `findings` | `ReviewFinding[]` | unchanged | `{ severity: critical\|major\|minor, file, line?, title, detail, round, status: open\|resolved }` |
| `verdict` | `'clean' \| 'changes-required'` | unchanged | Engine-recomputed; source of truth for mark-ready/stay-draft. |
| `round` | positive int | unchanged | Monotonic. **Now the posting/gating round (FR-005).** |
| `lastReviewedCommitSha` | non-empty string | unchanged | |
| `remediationCount` | non-negative int, `.default(0)` | unchanged | #1128. |
| `markedReadyByEngine` | boolean, **`.default(false)`** | **NEW (FR-006)** | True iff the engine currently holds this PR ready. `.default(false)` lets pre-#1156 artifacts parse. Only ever set true by the engine's own `markReadyForReview` (FR-007). |

**Validation rules**: unchanged Zod contract, additive field only. `readReviewArtifact` / `readReviewArtifactSync` return `null` on missing / unreadable / invalid — never throw. The `.default(false)` guarantees back-compat: an artifact written before this deploy (no `markedReadyByEngine` key) still `safeParse`s and yields `false`.

### `FindingsArtifact` (ReviewPoster consuming contract — UNCHANGED shape)

`packages/orchestrator/src/worker/review-findings-artifact.ts`. The bridge target; **not modified** (Q4=A keeps `round` out of this shape).

```ts
type FindingsArtifact = { verdict: 'clean' | 'changes-required'; findings: ReviewFinding[] };
type ReviewFinding = {
  marker: string;                         // synthesized: hash(file + title)
  text: string;                           // title + detail
  severity: 'blocking' | 'advisory';      // threshold-derived
  anchor?: { file: string; line: number };// present iff source line present
  resolved?: boolean;                     // status === 'resolved'
};
```

## The bridge (FR-002/FR-003)

`bridgeReviewArtifact(artifact: ReviewArtifact, blockingSeverity: Severity): FindingsArtifact` — pure, in new `review-findings-bridge.ts`.

Per source `ReviewArtifact` finding → one `FindingsArtifact` `ReviewFinding` (no finding ever dropped — SC-002):

| Target field | Derivation |
|--------------|-----------|
| `marker` | `sha256(`${file}\0${title}`).hex.slice(0, 24)` — stable across `line`/`detail` drift (D-3). |
| `text` | `${title}\n\n${detail}`. |
| `severity` | `SEVERITY_RANK[severity] >= SEVERITY_RANK[blockingSeverity] ? 'blocking' : 'advisory'` (D-2). |
| `anchor` | `line !== undefined ? { file, line } : undefined` — no line → no anchor → poster routes to body. |
| `resolved` | `status === 'resolved' ? true : false`. |

Top-level `verdict` passes through unchanged.

## Reader return shape (FR-005)

```ts
type FindingsRead = { artifact: FindingsArtifact; round: number };
readFindingsArtifact?: (context: WorkerContext) => Promise<FindingsRead | null>;
```

`round` = the raw `ReviewArtifact.round`. `null` when no sidecar / invalid (FR-009 inertness).

## Lifecycle state (FR-006/FR-007)

`PrManager.markedReadyByEngine` stays the in-run in-memory flag (`pr-manager.ts:41`) but is now mirrored to the sidecar:

- **Set**: `markReadyForReview` success → in-memory `true` + `setMarkedReadyByEngine(checkoutPath, workflowId, true)` (best-effort; skipped if either path component absent).
- **Read (reconstruct)**: `convertToDraftIfEngineMarkedReady`, when the in-memory flag is `false`, reads `readReviewArtifact(...)?.markedReadyByEngine` to recover a prior run's state.
- **Clear**: successful convert → in-memory `false` + `setMarkedReadyByEngine(..., false)`.

**Invariant (FR-007)**: the sidecar flag is written `true` only by the engine's own `markReadyForReview`. A human `gh pr ready` never touches the sidecar, so reconstruction can never demote a human-marked-ready PR.

# Data Model: Merge-conflict re-arm targets a resolution-scoped review

**Feature**: `1131-context-worker-merge-conflict`
**Status**: Complete

The feature adds one small value object — the **resolution scope** — and threads
it through four existing types. No new persisted entity; no sidecar field. All
additions are optional and default-absent so flag-OFF and non-merge-conflict
paths are byte-identical.

---

## Core value object: `ReviewScope`

```ts
/** The base..head window a resolution-scoped review must inspect. */
interface ReviewScope {
  /** Pre-merge branch tip — first parent of the --no-ff merge commit (HEAD^1). */
  readonly baseSha: string;
  /** Merge commit that resolved the conflict (HEAD). */
  readonly headSha: string;
}
```

Not a class; a plain readonly record carried on the re-armed outcome and the
worker context. Both SHAs are the short form produced by `git rev-parse --short`
(consistent with the handler's existing `getBranchTipSha`).

### Validity / semantics

| State | Meaning | Downstream effect |
|-------|---------|-------------------|
| `{ baseSha, headSha }`, `baseSha !== headSha`, non-empty diff | Real resolution delta | Executor scopes the charter to `baseSha..headSha` (FR-002) |
| `{ baseSha: HEAD, headSha: HEAD }` (no-op path) or any defined window whose `git diff` is empty | Legitimate empty resolution | Executor **short-circuits** → skip spawn → success → `validate` (FR-011) |
| `undefined` | SHAs could not be determined at success time | Executor reviews the **whole** PR diff (FR-010 whole-branch fallback) |

The empty-window vs. undefined distinction is load-bearing: `undefined` = "review
everything", a *defined-but-empty* window = "review nothing, go to validate". See
research.md Decision 3.

---

## Type extensions

### 1. `ReArmedOutcome` (`worker/handler-outcome.ts`)

```ts
interface ReArmedOutcome {
  readonly outcome: 're-armed';
  readonly startPhase: WorkflowPhase;
  readonly reviewScope?: ReviewScope;   // NEW — present only on the flag-ON
                                        // merge-conflict success re-arm
}
```

`startPhase` is `'review'` on the flag-ON merge-conflict re-arm; `metadata.phase`
otherwise (flag-OFF, FR-009). `reviewScope` is present only when `startPhase ===
'review'` **and** the SHAs were determinable; absent for the whole-branch
fallback (FR-010).

### 2. `WorkerContext` (`worker/types.ts`)

```ts
interface WorkerContext {
  // ...existing fields...
  readonly startPhase: WorkflowPhase;
  readonly resumeReason?: 'base-advance' | 'merge-conflict-resolved';  // WIDENED
  readonly baseSha?: string;
  readonly reviewScope?: ReviewScope;   // NEW
}
```

`resumeReason` gains `'merge-conflict-resolved'`. `reviewScope` is set by the
context-build seam only when `resumeReason === 'merge-conflict-resolved'` and the
rearm metadata carried a scope.

### 3. `ReviewCharterInput` (`worker/review-charter.ts`)

```ts
interface ReviewCharterInput {
  readonly profile: ReviewProfile;
  readonly sidecarRelPath: string;
  readonly blockingSeverity: Severity;
  readonly round: number;
  readonly diffWindow?: ReviewScope;    // NEW — when present, charter names the
                                        // exact base..head range to review
}
```

When `diffWindow` is present, `buildReviewCharter` names `baseSha..headSha` as
the exact range the agent must review, replacing the whole-PR-diff language.
Absent → byte-identical to today.

### 4. Rearm-item metadata (`worker/claude-cli-worker.ts`, in-flight shape)

The `rearmItem.metadata` object gains two keys alongside the existing
`startPhase` / `resumeReason`:

```ts
metadata: {
  startPhase: outcome.startPhase,          // 'review' (flag ON) | metadata.phase (flag OFF)
  resumeReason: 'merge-conflict-resolved', // already set today
  reviewScope: outcome.reviewScope,        // NEW — { baseSha, headSha } | undefined
}
```

This is the transport channel (Q2→B): outcome → rearm metadata →
`WorkerContext.reviewScope`. Not persisted beyond the queue item.

---

## Unchanged (documentation-only)

### `ResolveMergeConflictsMetadata` (`types/monitor.ts:67-85`)

No new field. The base/head SHAs travel via the re-armed outcome, **not** the
sidecar, because the sidecar is cleared immediately after re-arm (Q2→B). Add a
doc note pointing implementers to the outcome-borne `reviewScope` so nobody adds
a redundant sidecar SHA field later. `phase?` stays required for the fail-loud
guard and the flag-OFF fallback (FR-010).

---

## Relationships

```
MergeConflictHandler.finishSuccess
  │  computes ReviewScope (HEAD^1 / HEAD) — or undefined
  ▼
ReArmedOutcome { startPhase: 'review', reviewScope }
  │  (claude-cli-worker builds rearmItem)
  ▼
rearmItem.metadata { startPhase, resumeReason:'merge-conflict-resolved', reviewScope }
  │  (dispatcher enqueue → new 'continue' item → context build)
  ▼
WorkerContext { startPhase:'review', resumeReason:'merge-conflict-resolved', reviewScope }
  │
  ├─ reviewScope empty  ──► ReviewExecutor short-circuits ──► validate  (FR-011)
  ├─ reviewScope set    ──► buildReviewCharter({ diffWindow }) ──► scoped review
  └─ reviewScope absent ──► whole-PR charter (FR-010 fallback)
                                   │
                                   ├─ verdict clean            ──► validate   (FR-003)
                                   └─ verdict changes-required ──► remediate  (FR-004)
```

*Generated by /plan*

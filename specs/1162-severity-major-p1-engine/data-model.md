# Data Model: Keep engine bookkeeping sidecars out of PR branches

This fix introduces no new persisted entity schemas. It adds one Redis key (a mirror of an
existing on-disk field) and two module-level constants. Below are the shapes the change
reads from or writes to.

## Entities

### ReviewArtifact (existing — `review-artifact.ts`)

The on-disk sidecar remains the **working store**. Unchanged by this fix; only its
`remediationCount` field gains a durable Redis mirror.

| Field                 | Type                              | Notes |
|-----------------------|-----------------------------------|-------|
| `findings`            | `ReviewFinding[]`                 | — |
| `verdict`             | `'clean' \| 'changes-required'`   | gate conjunct |
| `round`              | `number` (int, positive)          | monotonic; NOT reused for the counter |
| `lastReviewedCommitSha` | `string` (min 1)                | — |
| `remediationCount`    | `number` (int, ≥ 0, default `0`)  | **mirrored to Redis** by this fix |
| `markedReadyByEngine` | `boolean` (default `false`)       | unrelated (#1156) |

- Path: `<checkoutPath>/.generacy/review-findings-<sanitized-workflowId>.json`
- `workflowId` = `${owner}/${repo}#${issueNumber}` (no branch); sanitize `[^a-zA-Z0-9_-] → _`.
- Reads: `readReviewArtifact` (async), `readReviewArtifactSync` (sync — the gate).
- `.default(0)` on `remediationCount` is load-bearing for back-compat parsing.

### Remediation-count Redis mirror (new)

| Aspect     | Value |
|------------|-------|
| Key        | `remediation-count:${owner}:${repo}:${issueNumber}:${branch}` |
| Value      | decimal string of `remediationCount` (e.g. `"2"`) |
| TTL        | `PHASE_START_REF_TTL_SECONDS` (7 days) |
| Store      | `PhaseTracker` (`getValueRaw` / `setValueRaw` / `clearRaw`) |
| Degrades   | best-effort — no-op / null when Redis unavailable |
| `branch`   | `context.branch ?? 'no-branch'` (mirrors the `review-findings:` key) |

Key-shape mirrors the existing `review-findings:${owner}:${repo}:${issueNumber}:${branch}`
persistence at `phase-loop.ts:1985`.

### Engine sidecar patterns (new — `product-diff.ts`)

```
ENGINE_SIDECAR_PREFIXES = [
  '.generacy/review-findings-',
  '.generacy/review-candidate-',
  '.generacy/pause-context-',
] as const
```

Matched via `String.prototype.startsWith`. Consumed by `isEngineSidecar(path)`.

## Validation rules

- **Staging filter (FR-001)**: a path is staged iff `!isEngineSidecar(path)`. Applies to
  `status.unstaged ∪ status.untracked`. Empty result ⇒ no commit (no empty commits).
- **Product-diff exclusion (FR-004)**: `isProductFile(path)` returns `false` for any path
  under `ENGINE_SIDECAR_PREFIXES` (folded into `EXCLUDED_PATH_PREFIXES`). `.generacy/config.yaml`
  and `.generacy/epics/*` remain product files (no prefix match).
- **Counter reconcile (FR-003)**: on gate entry, effective count = `max(diskCount, redisCount)`.
  Reset (`completed:remediation-limit`) sets disk → 0 and `clearRaw`s the Redis key.

## State transitions — remediationCount durability

```
remediate exec returns
      │  bumpRemediationCount (disk +1)   [existing]
      ▼
phase-loop seam: setValueRaw(remediation-count key, diskCount, TTL)   [new mirror]

worker restart / re-clone
      │  disk sidecar absent → diskCount = 0
      ▼
gate entry: redisCount = getValueRaw(key); if redisCount > diskCount:
            seedRemediationCount(disk := redisCount)   [new reconcile]
      ▼
readReviewArtifactSync sees durable count → cap fires at correct attempt (SC-003)

operator adds completed:remediation-limit
      ▼
resetRemediationCount (disk := 0)  +  clearRaw(redis key)   [reset]
```

# Data Model: Canonical findings-artifact schema

**Feature**: `1161-severity-major-p1-review` | **Date**: 2026-08-21

One findings-artifact schema, one `computeVerdict`, one severity-rank table. Home:
`packages/orchestrator/src/worker/review-artifact.ts`. The two orphan schemas are
deleted; the convergence engine and the poster retarget to these canonical types.

---

## Entities

### `Severity` (unchanged)

```ts
const SeveritySchema = z.enum(['critical', 'major', 'minor']);
type Severity = z.infer<typeof SeveritySchema>;
```

The single severity vocabulary (Q3=A). `blocking | advisory` is **not** a stored value;
it is a render-time projection in the poster (see `computeVerdict` / Decision 8).

### `FindingStatus` (unchanged)

```ts
const FindingStatusSchema = z.enum(['open', 'resolved']);
type FindingStatus = z.infer<typeof FindingStatusSchema>;
```

Engine-owned and **monotonic**: a finding may transition `open → resolved` but never
`resolved → open` (enforced by `advanceArtifact`, "resolved-is-terminal").

### `ReviewFinding` (MODIFIED — gains `id`)

```ts
const ReviewFindingSchema = z.object({
  id: z.string().min(1),          // NEW — stable per-finding identity
  severity: SeveritySchema,
  file: z.string(),
  line: z.number().int().positive().optional(),
  title: z.string(),
  detail: z.string(),
  round: z.number().int().positive(),
  status: FindingStatusSchema,
});
type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
```

**`id` — stable identity**: derived deterministically from `file + '\0' + title` via
`sha256(...).slice(0, 24)` (hex, 96 bits). Stable across `line` / `detail` drift so a
round-1 finding re-emitted in round 2 matches the same delta entry. On parse of an
in-flight sidecar that predates this field, `id` is default-filled with the same
derivation (back-compat, Decision 6).

### `ReviewArtifact` (MODIFIED — `findings` gains `id` per element)

```ts
const ReviewArtifactSchema = z.object({
  findings: z.array(ReviewFindingSchema),
  verdict: z.enum(['clean', 'changes-required']),
  round: z.number().int().positive(),          // sidecar = single round source (FR-006)
  lastReviewedCommitSha: z.string().optional(), // read by delta-scoping (FR-007)
  remediationCount: z.number().int().nonnegative().default(0),   // #1128
  markedReadyByEngine: z.boolean().default(false),               // #1156
});
type ReviewArtifact = z.infer<typeof ReviewArtifactSchema>;
```

All non-`id` fields are unchanged from the shipped schema. `round` is **1-based**
(first review = round 1). `lastReviewedCommitSha` is now **read** by
`computeReviewDelta` (previously write-only). `remediationCount` and
`markedReadyByEngine` are preserved by the executor's convergence rewrite (carry-forward,
not reset).

---

## Constants & functions (single source of truth)

### `SEVERITY_RANK` (the ONE severity table — FR-003)

```ts
const SEVERITY_RANK: Record<Severity, number> = { critical: 3, major: 2, minor: 1 };
```

Higher = more severe. Imported by the review executor, remediate executor, poster
(render projection), gate, and the convergence merge. The deleted tables
(`review/findings-artifact.ts` `SEVERITY_ORDER`, `remediate-executor.ts` local
`SEVERITY_RANK`) all collapse into this one.

### `computeVerdict` (the ONE verdict function — FR-002)

```ts
function computeVerdict(
  findings: ReviewFinding[],
  blockingSeverity: Severity,
): 'clean' | 'changes-required' {
  const threshold = SEVERITY_RANK[blockingSeverity];
  const hasBlockingOpen = findings.some(
    (f) => f.status === 'open' && SEVERITY_RANK[f.severity] >= threshold,
  );
  return hasBlockingOpen ? 'changes-required' : 'clean';
}
```

`changes-required` iff at least one **open** finding meets or exceeds the effective
`blockingSeverity`. The second `computeVerdict` (`review/findings-advance.ts`) is
deleted; all callers import this one.

### `defaultBlockingSeverity` (per-workflow default — D3 / FR-008)

```ts
function defaultBlockingSeverity(workflowName: string): Severity {
  return workflowName === 'speckit-feature' ? 'major' : 'critical';
}
```

Mirrors the `defaultMaxRemediations` pattern. Consumed by `resolveWorkflowOverrides`
as the fallback when no explicit `review.blockingSeverity` override is set. Replaces the
flat `DEFAULT_REVIEW.blockingSeverity = 'critical'`.

---

## Validation rules

| Field | Rule | Enforcement |
|---|---|---|
| `id` | non-empty; deterministic derivation on missing | `z.string().min(1)`; parse-time default-fill |
| `severity` | one of `critical\|major\|minor` | `SeveritySchema` |
| `status` | `open\|resolved`; monotonic (no reopen) | `FindingStatusSchema`; `advanceArtifact` |
| `round` (finding & artifact) | positive int, 1-based | `z.number().int().positive()` |
| `verdict` | recomputed by engine, never trusted from agent | `computeVerdict` on write |
| `lastReviewedCommitSha` | optional; when present, read by delta scoping | `computeReviewDelta` |
| `remediationCount` | ≥ 0, default 0, carried forward | `.default(0)`; executor preserves |
| `markedReadyByEngine` | default false, carried forward | `.default(false)`; executor preserves |

**Parse contract**: `readReviewArtifact` / `readReviewArtifactSync` /
`readCandidateFindings` return the canonical shape or `null` on malformed input; they
never throw to the caller. The `id` back-compat fill runs inside these readers before
the artifact reaches any consumer.

---

## Relationships & convergence flow

```
prior ReviewArtifact (round N, lastReviewedCommitSha = S)
        │
        ├─ computeReviewDelta(prior, HEAD)   reads prior.lastReviewedCommitSha (= S)
        │     └─► ReviewDelta { changedFiles, base = S, round = N+1 }
        │
        ├─ buildReviewCharter({ profile:'verification', diffWindow: delta,
        │                       stillOpenFindings, round: N+1 })   ← feeds live CLI
        │
        ├─ CLI candidate findings ──┐
        │                           │
        └─ advanceArtifact(prior, delta, reviewerAddressed, reviewerNewFindings)
              │   match-by-id within delta; resolved-is-terminal;
              │   filterNewFindings drops sub-blocking new findings on round >= 2;
              │   carry forward unaddressed open findings (anti-vanish, SC-005)
              ▼
        merged ReviewFinding[]
              │
              ├─ computeVerdict(merged, blockingSeverity)   ← single engine verdict
              ▼
        next ReviewArtifact (round N+1, lastReviewedCommitSha = HEAD,
                             remediationCount + markedReadyByEngine carried forward)
              │
              └─ review-poster: render each finding
                    marker = id, text = title + '\n\n' + detail,
                    blocking iff SEVERITY_RANK[severity] >= SEVERITY_RANK[blockingSeverity]
```

**Round-1 special case**: `prior === null`. No delta scoping; whole-PR review; charter
uses the `standard` profile; `advanceArtifact` seeds the artifact from the candidate
findings with `round = 1`.

**Anti-vanish invariant (SC-005)**: an open finding raised in round 1 and absent from
the round-2 candidate is **carried forward** by `advanceArtifact` (it is not in
`reviewerAddressed`, so it stays `open`), keeping the verdict `changes-required`. This
is the load-bearing behavior change: the executor stops trusting the candidate as the
whole truth.

**Monotonic status (US1 AC3)**: a `resolved` finding is never reopened; `advanceArtifact`
enforces resolved-is-terminal when merging.

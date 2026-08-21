# Contract: Review poster input (canonical `ReviewFinding[]`)

**File**: `packages/orchestrator/src/worker/review-poster.ts`
`ReviewPoster` consumes the canonical `ReviewFinding[]` directly. The
`review-findings-bridge.ts` intermediary and the #1125 `FindingsArtifact` /
`blocking|advisory` `ReviewFinding` type are deleted.

## Input change

```ts
// BEFORE (#1125): consumed a bridged FindingsArtifact
postRound(artifact: FindingsArtifact /* blocking|advisory */, round: number): Promise<void>;

// AFTER (#1161): consumes canonical findings + blockingSeverity for render projection
postRound(findings: ReviewFinding[], verdict: Verdict, round: number, blockingSeverity: Severity): Promise<void>;
resolveResolvedThreads(findings: ReviewFinding[], round: number): Promise<void>;
```

(Exact parameter shape bound at implement time; the load-bearing change is the input
**type** — canonical `ReviewFinding` + `blockingSeverity` — not a behavior change.)

## Render projection (blocking/advisory derived, not stored)

```ts
const isBlocking = SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[blockingSeverity];
const marker = finding.id;                       // was finding.marker
const text = `${finding.title}\n\n${finding.detail}`;  // was finding.text
const anchor = finding.line !== undefined ? { file: finding.file, line: finding.line } : undefined;
const resolved = finding.status === 'resolved';
```

## Preserved behavior (FR-009 — #1156 byte-identical)

- **One COMMENT-event review per round** (never `REQUEST_CHANGES` — cluster 422s on its
  own PR).
- **Body marker**: `<!-- generacy-engine-review round=<N> -->` (prefix
  `generacy-engine-review`), unchanged.
- **Inline finding marker**: `<!-- generacy-finding:<id> -->` — `id` replaces the
  bridge-synthesized marker, but the derivation is identical
  (`sha256(file + '\0' + title).slice(0,24)`), so cross-round thread matching in
  `getPRReviewThreads` resolves the same threads.
- **Dedupe per round** (`isRoundAlreadyPosted`): grep existing reviews for the body
  marker + round number, unchanged.
- **Thread resolution on round >= 2**: match by `<!-- generacy-finding:<id> -->`,
  best-effort per thread, unchanged.
- **Draft/ready lifecycle** (`markReadyForReview` / `convertToDraftIfEngineMarkedReady`)
  and `markedReadyByEngine` cross-run persistence, unchanged.

## Invariants

- **INV-P1**: blocking vs advisory is computed at render via `SEVERITY_RANK`; it is not a
  stored field (keeps FR-003 single severity table).
- **INV-P2**: no `blocking|advisory` vocabulary survives anywhere (SC-001 — the #1125
  schema is deleted).
- **INV-P3**: #1156 poster tests change only for the input type; posting output (markers,
  bodies, dedupe, lifecycle) is byte-for-byte preserved.

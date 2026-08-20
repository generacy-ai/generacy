# Data Model: delta-scoped verification passes (#1126)

All types are TypeScript, ESM, in `packages/orchestrator/src/worker/review/`.
The findings-artifact types are the **#1124 seam** — introduced minimally here and
reconciled to #1124's canonical schema when it lands.

## FindingsArtifact (consumed — #1124 seam)

```ts
export type Severity = 'minor' | 'major' | 'critical';
export type FindingStatus = 'open' | 'resolved';
export type ReviewVerdict = 'clean' | 'changes-required';

export interface ReviewFinding {
  id: string;             // stable finding id (owned by #1124)
  severity: Severity;
  file: string;
  line?: number;
  title: string;
  detail: string;
  round: number;          // round the finding was first raised
  status: FindingStatus;  // 'open' | 'resolved' (resolved is terminal — Q1)
}

export interface FindingsArtifact {
  round: number;                 // rounds completed so far; 0/absent ⇒ never reviewed
  findings: ReviewFinding[];
  lastReviewedSha?: string;      // head SHA of the most recent review
  verdict?: ReviewVerdict;       // verdict of the most recent review
}
```

**Validation rules**
- `round >= 0`. Absent artifact is treated as `{ round: 0, findings: [] }`.
- `resolved` is terminal: no function may set a `resolved` finding back to `open`.
- Two findings never share an `id`; new findings get fresh ids (from #1124).

## ReviewMode (FR-001)

```ts
export type ReviewMode =
  | { kind: 'full-review'; round: 1 }                 // absent/round-0 artifact
  | { kind: 'verification'; round: number };          // round = artifact.round + 1
```

Rule: `artifact` absent OR `artifact.round === 0` OR no `lastReviewedSha`
⇒ `full-review` (round 1). Otherwise `verification` at `artifact.round + 1`.

## ReviewDelta (FR-002 / FR-007 / FR-009)

```ts
export type DeltaBase =
  | { source: 'resolution'; base: string; head: string }   // FR-007 (pause-context SHAs)
  | { source: 'last-reviewed'; base: string; head: string } // FR-002
  | { source: 'full-diff'; base: string; head: string };    // FR-009 fallback (widened)

export interface ReviewDelta {
  base: DeltaBase;
  files: string[];   // changed files between base.base..base.head; [] when base===head
  round: number;     // n+1 for verification; 1 for full-review
}
```

Rule: base selection order is `resolution` → `last-reviewed` (only if
`commitExistsInCheckout`) → `full-diff`. Files computed via
`GitHubClient.getFilesChangedBetween(base.base, base.head)`. Every verification-pass
delta carries `round = artifact.round + 1` regardless of which base was used (Q5 —
the fallback never resets to round 1).

## VerificationInput (FR-003)

```ts
export interface VerificationInput {
  round: number;
  deltaFiles: string[];               // (a) the computed delta
  openFindings: ReviewFinding[];      // (b) findings still `open` in the artifact
}
```

Rule: the input is the union of the delta and the open-findings set. An open
finding whose `file`/`line` is not among `deltaFiles` is still enumerated in the
prompt but is **not eligible** to transition to `resolved` (Q2).

## VerificationPrompt (FR-004)

```ts
export interface VerificationPromptParts {
  round: number;                      // stated explicitly (SC-006)
  openFindings: ReviewFinding[];      // enumerated verbatim (SC-006)
  charter: 'standard' | 'verification'; // selection originates in #1124
}
```

`buildVerificationPrompt(parts): string` must contain the literal round number and
each open finding's `title`/`detail` verbatim.

## AdvanceResult (FR-005 / FR-006 / FR-008)

```ts
export interface AdvanceInput {
  artifact: FindingsArtifact;
  delta: ReviewDelta;
  reviewerAddressed: string[];        // finding ids the reviewer reports addressed
  reviewerNewFindings: ReviewFinding[]; // raw new findings the reviewer returned
  blockingSeverity: Severity;
}

export interface AdvanceResult {
  artifact: FindingsArtifact;         // next artifact (immutable transition)
  verdict: ReviewVerdict;
  droppedSubBlocking: ReviewFinding[]; // filtered-out advisory findings (round >= 2)
}
```

**Transition rules (`advanceArtifact`)**
1. For each `open` finding whose location is in `delta.files` and whose id is in
   `reviewerAddressed` ⇒ `status = 'resolved'`.
2. `open` findings not in the delta ⇒ unchanged (Q2).
3. `resolved` findings ⇒ never touched (Q1).
4. New findings ⇒ `filterNewFindings` first: on `round >= 2`, drop any with
   `severity < blockingSeverity` (Q3); survivors appended with `round = delta.round`.
5. `lastReviewedSha = delta.base.head`; `round = delta.round`.
6. `verdict = computeVerdict(nextArtifact, blockingSeverity)` — `changes-required`
   iff any `severity >= blockingSeverity` finding is `open`; else `clean` (FR-008).

Severity order for comparisons: `minor(0) < major(1) < critical(2)`.

## PauseContext extension (read-side; #1131 writes)

`packages/orchestrator/src/worker/pause-context.ts` — extend `PauseContextSchema`:

```ts
export const PauseContextSchema = z.object({
  phase: WorkflowPhaseSchema,
  writtenAt: z.string(),
  issueRef: z.string(),
  resolutionBaseSha: z.string().optional(),   // #1131 populates on merge-conflict re-arm
  resolutionHeadSha: z.string().optional(),
});
```

Both optional (non-breaking). This feature only **reads** them for FR-007; #1131
owns writing them. Absent ⇒ FR-007 does not apply; delta falls to `last-reviewed`
then `full-diff`.

# Contract: Canonical findings-artifact schema

**File**: `packages/orchestrator/src/worker/review-artifact.ts`
**Status**: the ONE surviving schema (FR-001), ONE `computeVerdict` (FR-002), ONE
`SEVERITY_RANK` (FR-003).

## Exported surface (canonical)

```ts
// Vocabulary
type Severity = 'critical' | 'major' | 'minor';
type FindingStatus = 'open' | 'resolved';
type Verdict = 'clean' | 'changes-required';

// Finding — gains `id`
interface ReviewFinding {
  id: string;              // NEW, non-empty, deterministic
  severity: Severity;
  file: string;
  line?: number;
  title: string;
  detail: string;
  round: number;           // 1-based
  status: FindingStatus;   // monotonic open→resolved
}

// Artifact
interface ReviewArtifact {
  findings: ReviewFinding[];
  verdict: Verdict;
  round: number;                    // 1-based, single source of round truth
  lastReviewedCommitSha?: string;   // read by delta scoping
  remediationCount: number;         // default 0, carried forward
  markedReadyByEngine: boolean;     // default false, carried forward
}

const SEVERITY_RANK: Record<Severity, number>; // { critical:3, major:2, minor:1 }
function computeVerdict(findings: ReviewFinding[], blockingSeverity: Severity): Verdict;

// Persistence (path/read/write helpers — signatures unchanged except id fill)
function writeReviewArtifact(checkoutPath: string, workflowId: string, artifact: ReviewArtifact): Promise<void>;
function readReviewArtifact(checkoutPath: string, workflowId: string): Promise<ReviewArtifact | null>;
function readReviewArtifactSync(checkoutPath: string, workflowId: string): ReviewArtifact | null;
function bumpRemediationCount(checkoutPath: string, workflowId: string): Promise<number>;
function resetRemediationCount(checkoutPath: string, workflowId: string): Promise<void>;
function setMarkedReadyByEngine(checkoutPath: string, workflowId: string, value: boolean): Promise<void>;
```

## Invariants

- **INV-1 (single schema)**: exactly one findings-artifact type is exported from
  `worker/`; the two orphan files are deleted (SC-001).
- **INV-2 (single verdict)**: `computeVerdict` is the only verdict function; the copy in
  `review/findings-advance.ts` is deleted (SC-002).
- **INV-3 (single severity table)**: `SEVERITY_RANK` is the only severity-rank table;
  `SEVERITY_ORDER` and the `remediate-executor.ts` local copy are deleted (SC-003).
- **INV-4 (id determinism)**: for a given `(file, title)`, `id` is stable across parses
  and across rounds. Derivation: `sha256(file + '\0' + title).slice(0, 24)`.
- **INV-5 (back-compat)**: parsing a sidecar written before this change never throws and
  default-fills `id`; the reader returns the canonical shape or `null`.
- **INV-6 (verdict recompute)**: `verdict` on a written artifact always equals
  `computeVerdict(findings, effectiveBlockingSeverity)`; an agent-claimed verdict is
  ignored (FR-007).

## Consumers (all import from this file)

`review-executor.ts`, `remediate-executor.ts`, `review-poster.ts`, `phase-loop.ts`,
`review/findings-advance.ts`, `review/review-delta.ts`, `review/verification-input.ts`.

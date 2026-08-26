# Data Model: Review executor phantom-clean fix (#1155)

No schema *shape* changes (Out of Scope). The only data-model change is a new filesystem entity (the candidate sidecar path) and a return-type refinement on one reader.

## Entities

### Review candidate sidecar (NEW path — same shape as today's candidate read)

- **Path (relative, charter write target)**: `.generacy/review-candidate-<sanitized-workflowId>.json`
- **Path (absolute)**: `<checkoutPath>/.generacy/review-candidate-<sanitized-workflowId>.json`
- **Sanitization**: `workflowId.replace(/[^a-zA-Z0-9_-]/g, '_')` (mirrors the engine artifact).
- **Writer**: the review agent (target supplied via the charter `sidecarRelPath` value — a caller-supplied path change, NOT a charter prompt-text edit).
- **Reader**: `readCandidateFindings` (engine).
- **Lifecycle**: cleared before spawn (pre-spawn `clearReviewCandidate`); read after exit; cleared again after a successful engine write. Never read across rounds.
- **Schema (unchanged)**: lenient `CandidateArtifactSchema` — `{ findings: CandidateFinding[] }`. Per-finding `round`/`status` optional (engine stamps authoritative `round`, defaults `status: 'open'`). Any agent-claimed top-level `verdict`/`round` ignored (FR-007).

### Review engine artifact (UNCHANGED)

- **Path**: `<checkoutPath>/.generacy/review-findings-<sanitized-workflowId>.json`
- **Schema**: strict `ReviewArtifactSchema` — `{ findings: ReviewFinding[], verdict, round (positive), lastReviewedCommitSha, remediationCount (default 0) }`.
- **Writer**: engine only, atomic temp+rename, only on a successful review round.
- **Invariant**: never written on a failed / no-verdict round (Q3-A). `round` monotonic (#1126); `remediationCount` carried forward (#1128).

## Type definitions

### `readCandidateFindings` — return type change

```ts
// BEFORE
export async function readCandidateFindings(
  checkoutPath: string, workflowId: string, round: number,
): Promise<ReviewFinding[]>            // [] on missing / invalid  (root-cause conflation)

// AFTER
export async function readCandidateFindings(
  checkoutPath: string, workflowId: string, round: number,
): Promise<ReviewFinding[] | null>     // null = no proof of review; [] = genuine clean
```

Semantics after change:

| Candidate file state | Return | Meaning |
|----------------------|--------|---------|
| missing | `null` | nothing written this round → no verdict |
| unreadable / invalid JSON | `null` | no proof of review |
| schema-invalid | `null` | no proof of review |
| valid, `findings: []` | `[]` | reviewed, zero findings → legitimate `clean` |
| valid, `findings: [...]` | `ReviewFinding[]` | reviewed, findings present |

### New helpers (internal, not re-exported)

```ts
export function getReviewCandidateRelPath(workflowId: string): string;
export function getReviewCandidatePath(checkoutPath: string, workflowId: string): string;
export function clearReviewCandidate(checkoutPath: string, workflowId: string): Promise<void>; // idempotent (swallows ENOENT)
```

## Verdict / persistence decision table (engine, post-exit)

`blockingSeverity` from resolved workflow review config; `computeVerdict` unchanged.

| exitCode | candidate (`findings`) | Action | PhaseResult | Artifact write | `round` |
|----------|------------------------|--------|-------------|----------------|---------|
| `0` | `null` (missing/invalid) | persist nothing | `success: false, exitCode: 0`? → **no**: FR-002 no-verdict ⇒ `success: false`* | none | unchanged |
| `0` | `[]` | write artifact, verdict `clean` | `success: true, exitCode: 0` | yes | +1 |
| `0` | `[...]` | write artifact, `computeVerdict(...)` | `success: true, exitCode: 0` | yes | +1 |
| `≠ 0` / `null` (timeout kill) | any | persist nothing | `success: false, exitCode: exitCode ?? -1` | none | unchanged |

\* **Clarification on the exit-0-but-no-candidate row**: FR-001 sets `success` from the exit code; FR-002 governs the *verdict/persistence*. An exit-0 run with no fresh candidate produces **no verdict** and **persists nothing** — the loop must not advance to `validate` or mark ready. Because the review side-effects and off-sequence advance are gated on both `result.success` *and* a persisted `clean` verdict, the safest and simplest realization is to treat "exit 0 but no fresh candidate" as a failed round: return `success: false`. This closes the exit-0-no-sidecar gap (FR-002) without a phase-loop change. The single post-exit gate is therefore `exitCode !== 0 || findings === null` ⇒ `success: false`, persist nothing.

## Validation rules

- Candidate read never throws — `null` on any error (missing/JSON/schema).
- Engine artifact read never throws — `null` on any error.
- Atomic writes only (temp + rename); no partial artifact ever visible.
- A failed / no-verdict round writes zero bytes to the engine artifact path.

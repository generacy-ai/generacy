# Contract: Executor-side convergence merge

Replaces `PhaseLoop.runReviewConvergence` (deleted). The merge runs **inside**
`review-executor.ts` with real inputs, retargeted to the canonical types.

## Retargeted convergence functions

```ts
// review/review-delta.ts — reads canonical lastReviewedCommitSha (was lastReviewedSha)
function computeReviewDelta(
  prior: ReviewArtifact | null,
  headSha: string,
  ctx: { commitExistsInCheckout: (sha: string) => Promise<boolean>; /* base resolution */ },
): Promise<ReviewDelta>;
// ReviewDelta { changedFiles, base, round }  round = (prior?.round ?? 0) + 1  (1-based)

// review/verification-input.ts — operates on canonical ReviewFinding
function composeVerificationInput(delta: ReviewDelta, prior: ReviewArtifact): VerificationInput;
// enumerates all prior findings with status === 'open'

// review/verification-prompt.ts — now feeds the live charter (not discarded)
function buildVerificationPrompt(parts: VerificationInput): string;

// review/findings-advance.ts — canonical ReviewFinding; second computeVerdict DELETED
function advanceArtifact(
  prior: ReviewArtifact | null,
  delta: ReviewDelta,
  reviewerAddressed: ReviewFinding[],
  reviewerNewFindings: ReviewFinding[],
): ReviewFinding[];

function filterNewFindings(
  candidates: ReviewFinding[],
  round: number,
  blockingSeverity: Severity,
): ReviewFinding[];
// round >= 2 → drops candidates below blockingSeverity; imports canonical SEVERITY_RANK
```

## `advanceArtifact` behavioral contract

Input: prior artifact, the delta window, findings the agent marked addressed, and
new findings the agent raised. Output: the merged `ReviewFinding[]`.

- **Match by id within delta** (`findings-advance.ts:89-99`): a candidate is matched to
  a prior finding by `id`; only findings inside the delta window are eligible for status
  change.
- **Resolved-is-terminal**: a `resolved` prior finding is never reopened.
- **Carry-forward (anti-vanish, SC-005)**: a prior `open` finding not in
  `reviewerAddressed` stays `open` even if the agent's candidate omits it.
- **New-findings gate**: `filterNewFindings` admits new findings only at or above
  `blockingSeverity` on round >= 2 (whole-PR round 1 admits all).

## Executor sequence (round N → N+1)

1. `prior = await readReviewArtifact(checkoutPath, workflowId)` (null on round 1).
2. `delta = await computeReviewDelta(prior, HEAD, ctx)` — reads
   `prior.lastReviewedCommitSha`.
3. `charter = buildReviewCharter({ profile: prior ? 'verification' : 'standard',
   diffWindow: delta, stillOpenFindings: composeVerificationInput(delta, prior),
   blockingSeverity, round: delta.round })` — `buildVerificationPrompt` output feeds
   this charter (no longer discarded).
4. Spawn CLI with the charter; read candidate findings.
5. `merged = advanceArtifact(prior, delta, reviewerAddressed, reviewerNewFindings)`.
6. `verdict = computeVerdict(merged, blockingSeverity)`.
7. `writeReviewArtifact(checkoutPath, workflowId, { findings: merged, verdict,
   round: delta.round, lastReviewedCommitSha: HEAD,
   remediationCount: prior?.remediationCount ?? 0,
   markedReadyByEngine: prior?.markedReadyByEngine ?? false })`.

## Invariants

- **INV-C1 (single round source, FR-006)**: `round` lives only in the sidecar. The
  `review-findings:<owner>:<repo>:<issue>:<branch>` PhaseTracker key is deleted; nothing
  writes a separate round counter. Round advances only on a successful review.
- **INV-C2 (lastReviewedCommitSha read, FR-007)**: `computeReviewDelta` reads
  `prior.lastReviewedCommitSha`; the field is no longer write-only.
- **INV-C3 (no discarded work, FR-005)**: `buildVerificationPrompt` output is passed to
  the charter; `advanceArtifact` is called with real (non-empty) inputs. No half-wired
  middle state remains.
- **INV-C4 (blockingSeverity parity, FR-004)**: `blockingSeverity` is resolved via
  `resolveWorkflowOverrides(this.config, this.settings, workflowName)`. No `settings =
  null` resolution exists anywhere (SC-004).
- **INV-C5 (carry-forward, SC-005)**: a round-1 open finding omitted by the round-2
  candidate remains `open`; the verdict stays `changes-required`.

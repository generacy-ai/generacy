# Contract: verification-pass convergence functions (#1126)

Module: `packages/orchestrator/src/worker/review/`. All functions are pure
(no I/O except the injected `GitHubClient` slice inside `computeReviewDelta`).

## `determineReviewMode(artifact?: FindingsArtifact): ReviewMode` — FR-001

| Input | Output |
|-------|--------|
| `undefined` | `{ kind: 'full-review', round: 1 }` |
| `{ round: 0, findings: [] }` | `{ kind: 'full-review', round: 1 }` |
| `{ round: 0, lastReviewedSha: undefined }` | `{ kind: 'full-review', round: 1 }` |
| `{ round: 1, lastReviewedSha: 'abc' }` | `{ kind: 'verification', round: 2 }` |
| `{ round: 3, lastReviewedSha: 'def' }` | `{ kind: 'verification', round: 4 }` |

## `computeReviewDelta(input): Promise<ReviewDelta>` — FR-002 / FR-007 / FR-009

```ts
computeReviewDelta({
  github: Pick<GitHubClient, 'getFilesChangedBetween' | 'getCurrentCommitSha' | 'commitExistsInCheckout'>,
  artifact: FindingsArtifact,
  pauseContext?: { resolutionBaseSha?: string; resolutionHeadSha?: string },
  prBaseRef: string,        // default-branch base for the full-diff fallback
}): Promise<ReviewDelta>
```

Base-selection order (first that applies wins):
1. `pauseContext.resolutionBaseSha && pauseContext.resolutionHeadSha`
   ⇒ `source: 'resolution'` (FR-007).
2. `artifact.lastReviewedSha` **and** `await commitExistsInCheckout(lastReviewedSha)`
   ⇒ `source: 'last-reviewed'`, head = `getCurrentCommitSha()` (FR-002).
3. Otherwise ⇒ `source: 'full-diff'`, base = `prBaseRef`, head =
   `getCurrentCommitSha()` (FR-009).

Invariants:
- `round === artifact.round + 1` on every branch (Q5 — no round-1 reset).
- `base === head` ⇒ `files: []` (SC-001).
- A genuine git failure from `getFilesChangedBetween` propagates (not swallowed);
  only a *missing* `lastReviewedSha` (via `commitExistsInCheckout === false`)
  triggers the FR-009 fallback.

## `composeVerificationInput(delta, artifact): VerificationInput` — FR-003

- `deltaFiles = delta.files`.
- `openFindings = artifact.findings.filter(f => f.status === 'open')`.
- All open findings are enumerated even if outside the delta (Q2), but only
  delta-located ones are `resolved`-eligible downstream.

## `buildVerificationPrompt(parts): string` — FR-004 / SC-006

Output must contain:
- the literal `parts.round` (e.g. `Round 2`);
- each `parts.openFindings[i]` `title` and `detail` verbatim;
- the verification charter framing (`parts.charter === 'verification'`).

## `filterNewFindings(newFindings, round, blockingSeverity): { kept, dropped }` — FR-005 / Q3

- `round === 1` ⇒ `kept = newFindings`, `dropped = []` (advisory allowed round 1).
- `round >= 2` ⇒ `kept = newFindings.filter(f => sev(f) >= sev(blockingSeverity))`,
  `dropped = newFindings.filter(f => sev(f) < sev(blockingSeverity))`.

## `advanceArtifact(input): AdvanceResult` — FR-006 / FR-008

- Transition per data-model rules 1–6. Immutable (returns a new artifact object).
- `resolved` never re-opened (Q1); open findings outside delta unchanged (Q2).
- New findings appended after `filterNewFindings`, `round = delta.round`.
- `verdict = changes-required` iff any `severity >= blockingSeverity` is `open`.

## `computeVerdict(artifact, blockingSeverity): ReviewVerdict` — FR-008

`changes-required` iff `artifact.findings.some(f => f.status === 'open' && sev(f) >= sev(blockingSeverity))`; else `clean`.

## Severity helper

`sev('minor') = 0`, `sev('major') = 1`, `sev('critical') = 2`. "Sub-blocking" =
`sev(finding) < sev(blockingSeverity)`.

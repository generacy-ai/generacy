# Implementation Plan: Re-review convergence — delta-scoped verification passes

**Feature**: Make engine-native `review` re-runs verification passes scoped to the delta since the last review plus still-open findings, so review⇄remediate loops converge.
**Branch**: `1126-context-review-rounds-must`
**Status**: Complete

## Summary

The engine-native `review` phase (added as an inert stub in #1121) must re-run
every time control backtracks from `remediate` or from a resolved merge conflict.
If each re-review re-reads the full PR diff it invents fresh nitpicks every round
and never converges — the 3–6 round churn `/cockpit:auto` shows today.

This feature adds the **convergence logic** that turns a re-review into a
*verification pass*:

1. **Mode determination** — absent artifact / round 0 ⇒ full review (round 1);
   present with a last-reviewed SHA ⇒ verification pass (round n+1).
2. **Delta scoping** — the re-review sees only the change set between the
   last-reviewed SHA and current head (or, for a merge-conflict re-arm, the
   resolution base/head SHAs from the pause-context sidecar).
3. **Input composition** — union of (a) the delta and (b) findings still `open`.
4. **Charter + engine filter** — the prompt is told the round number and the
   verbatim open findings; new sub-blocking (advisory) findings after round 1 are
   dropped by the engine, not just discouraged by the prompt.
5. **Monotonic status machine** — delta-located open findings that are addressed
   go `open → resolved`; `resolved` is terminal; new blocking findings append with
   the current round; the last-reviewed SHA advances to the head just reviewed.
6. **Verdict** — `changes-required` iff any finding at/above `blockingSeverity`
   remains `open` (or a new blocking finding was raised); else `clean`.
7. **Safe degradation** — an unresolvable scoping SHA (e.g. post-rebase) widens the
   delta to the whole diff but stays a verification pass (round n+1, no advisory
   findings) — never "reviewed nothing", never a reset to round-1 semantics.

Round 1 (first full-diff review) behavior is unchanged beyond recording the
reviewed SHA. This feature is **pure convergence logic over a findings artifact**;
it does not implement the review executor, the artifact schema, PR posting, or the
merge-conflict SHA producer (those are #1124/#1125/#1131 seams).

## Technical Context

- **Language / runtime**: TypeScript, ESM, Node >= 22.
- **Primary package**: `@generacy-ai/orchestrator` (`packages/orchestrator`).
- **Consumed helpers** (already present):
  - `GitHubClient.getFilesChangedBetween(base, head)` — `packages/workflow-engine/src/actions/github/client/gh-cli.ts:1382`.
  - `GitHubClient.getFilesChangedByOwnCommits(startRef)` — `gh-cli.ts:1410`.
  - `GitHubClient.getCurrentCommitSha()` — `gh-cli.ts:1396`.
  - `GitHubClient.commitExistsInCheckout(sha)` — used by the `phase-start-ref` guard in `phase-loop.ts`.
  - `PhaseTracker.getValueRaw/setValueRaw/clearRaw` — Redis-backed sidecar persistence, `packages/orchestrator/src/types/monitor.ts:541`.
  - `ResolvedWorkflowConfig.review.{profile, blockingSeverity, failThenPass}` — `packages/orchestrator/src/worker/config.ts:33`.
- **Phase wiring** (from #1121, already merged):
  - `review`/`remediate` stub executor branch — `phase-loop.ts:473-477`.
  - `runStubPhase(phase)` — `phase-loop.ts:1183`.
  - off-sequence `remediateTrigger` seam — `phase-loop.ts:1154-1166`, `PhaseLoopDeps.remediateTrigger` — `types.ts:100-107`.
  - `reviewPhaseEnabled` sequence filter — `phase-loop.ts:226-228`, `getPhaseSequence` — `types.ts:84-90`.
- **Test conventions**: Vitest under `packages/orchestrator/src/worker/__tests__/`; `createMockDeps()` / `github` mocks in `phase-loop.test.ts:42-96`.

## Seam contract (dependencies not built here)

This feature is **parameterized over** a findings artifact it does not own. To stay
buildable and unit-testable ahead of / independent of #1124, the plan introduces a
minimal structural interface (`FindingsArtifact`, `ReviewFinding`) under
`packages/orchestrator/src/worker/review/findings-artifact.ts` and marks it as the
#1124 seam. When #1124 lands its canonical schema, this interface is re-exported
from / narrowed to #1124's type; the pure convergence functions never change.

| Seam | Owner | This feature does |
|------|-------|-------------------|
| Findings artifact schema (`findings[]`, `round`, `verdict`, last-reviewed SHA) | #1124 | Reads + advances via injected artifact; defines a minimal consumed interface as a placeholder. |
| Review executor / charter prompt selection | #1124 | Composes the verification prompt string (round + open findings); does not spawn the reviewer. |
| PR review posting + inline-thread resolution + draft/ready | #1125 | Drives artifact `status` only; posts nothing. |
| Merge-conflict resolution base/head SHAs in pause-context | #1131 | Reads them from the sidecar; falls back per FR-009 until present. |
| Remediation counter / remediation-limit gate | #1128 | Increments round each cycle; does not gate the cycle count. |

## Project Structure

New module (this feature):

```
packages/orchestrator/src/worker/review/
  findings-artifact.ts        # #1124 seam: FindingsArtifact + ReviewFinding interfaces (placeholder)
  review-mode.ts              # FR-001: determineReviewMode(artifact) -> full-round-1 | verification(n+1)
  review-delta.ts             # FR-002/FR-007/FR-009: computeReviewDelta(...) over github + pause-context
  verification-input.ts       # FR-003: composeVerificationInput(delta, openFindings)
  verification-prompt.ts      # FR-004: buildVerificationPrompt(round, openFindings, charter)
  findings-advance.ts         # FR-005/FR-006/FR-008: advanceArtifact(...) + filterNewFindings(...) + computeVerdict(...)
  index.ts                    # barrel exports
```

Extended (this feature):

```
packages/orchestrator/src/worker/pause-context.ts   # add optional resolutionBaseSha/resolutionHeadSha (read-side; #1131 writes)
packages/orchestrator/src/worker/phase-loop.ts       # wire review branch (473-477) through the convergence module
```

Tests (this feature):

```
packages/orchestrator/src/worker/review/__tests__/
  review-mode.test.ts             # SC-001 mode selection
  review-delta.test.ts            # SC-001 delta correctness (identical SHAs -> empty; missing SHA -> full)
  findings-advance.test.ts        # SC-002/SC-003/SC-004 transitions, filter, resolved-terminal, verdict
  verification-prompt.test.ts     # SC-006 round number + verbatim open findings
packages/orchestrator/src/worker/__tests__/
  phase-loop.verification-pass.test.ts   # SC-005 remediate re-review + merge-conflict scoped path via phase-loop
```

## Key design decisions

- **Pure functions, artifact-injected.** All FR logic (mode, delta, compose,
  advance, filter, verdict) are pure functions taking the artifact + a small
  `GitHubClient` slice as arguments. This isolates them from #1124's executor and
  makes SC-001…SC-006 unit-testable without a real reviewer.
- **Delta source is a single decision point.** `computeReviewDelta` picks its base
  in priority order: (1) pause-context resolution base/head SHAs if present
  (FR-007); (2) artifact last-reviewed SHA (FR-002); (3) full diff when a SHA is
  absent/unresolvable (FR-009). Every branch returns a verification-pass delta —
  only the base changes.
- **Resolution is evidence-based (Q2).** Only findings whose file/line is inside
  the computed delta may transition to `resolved`; an open finding outside the
  delta stays `open` unconditionally.
- **`resolved` is terminal (Q1).** A re-broken resolved location becomes a *new*
  finding subject to the blocking-only-after-round-1 rule — never `resolved → open`.
- **Engine-side filter is authoritative (Q3).** `filterNewFindings` drops any new
  finding below `blockingSeverity` on rounds ≥ 2 before it is written; the charter
  in the prompt is only the first line of defense.
- **Persistence reuses the phase-start-ref pattern.** The artifact + last-reviewed
  SHA persist via `PhaseTracker.getValueRaw/setValueRaw` under a
  `review-findings:<owner>:<repo>:<issue>:<branch>` key (mirrors the existing
  `phase-start-ref:` key shape and 7-day TTL). When #1124 lands its own persistence
  this key becomes the read-through source of truth or is superseded — the
  convergence functions are storage-agnostic.

## Constitution Check

No `.specify/memory/constitution.md` exists in the repository — constitution gate
skipped (consistent with sibling speckit features in this repo).

## Open reconciliation (flagged, not resolved here)

- `blockingSeverity` **default mismatch**: spec Assumptions state a feature default
  of `major`, but `DEFAULT_REVIEW.blockingSeverity` in `config.ts:11` is currently
  `critical`. This feature *consumes* `blockingSeverity` and does not set the
  default; the default is owned by #1122/#1124. Flagged in `research.md` so the
  default is reconciled where it is set, not here.

## Changeset

`.changeset/1126-verification-pass-convergence.md` — `@generacy-ai/orchestrator`
**patch** (internal worker convergence logic + pause-context read-side field; no new
public package exports). Confirm at implement time via `pnpm why
@generacy-ai/orchestrator`; upgrade to **minor** only if a new public export is
added at the package boundary. Single changeset file per the CLAUDE.md gate.

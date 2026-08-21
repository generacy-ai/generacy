# Clarifications

## Batch 2026-08-21

### Q1: Convergence engine — activate or delete (D1)
**Context**: This is the load-bearing choice for the whole feature. The #1126
convergence engine (`runReviewConvergence`, `advanceArtifact`, `findings-advance.ts`,
`verification-input.ts`, `review-delta.ts`) is fully built but disconnected — it
computes a verification prompt and throws it away, and calls `advanceArtifact` with
empty inputs. Whether we wire it in or rip it out determines the canonical schema
shape (D2), the round-counter source (FR-006), and whether `lastReviewedCommitSha`
is read or removed (FR-007). It decides if the churn-reduction goal (3–6 rounds →
convergence) is met.
**Question**: Should the review path activate the delta/verification convergence
engine end-to-end, or delete the scaffolding and keep a deliberate stateless
whole-PR review each round?
**Options**:
- A: Activate — wire delta-scoping (round ≥ 2 scoped to `lastReviewedCommitSha`), still-open-finding enumeration, blocking-severity-only new findings, and engine-side monotonic status transitions into the live charter + executor.
- B: Delete — remove the convergence scaffolding; the live path stays a stateless whole-PR review each round, and the acceptance criteria that assume convergence are re-scoped to documented whole-PR semantics.

**Answer**: *Pending*

### Q2: speckit-feature default blockingSeverity (D3)
**Context**: `DEFAULT_REVIEW.blockingSeverity` is `critical` for all workflows in
`worker/config.ts`, and the reference docs (`docs/docs/reference/review-artifacts.md`)
say `critical`. The epic design intended `speckit-feature = major`. FR-008/SC-007
require the constant and the docs to agree; this decides which one moves.
**Question**: What should `speckit-feature`'s default `blockingSeverity` be?
**Options**:
- A: `major` — restore the epic's intended default; update the code constant and the docs to `major` (bugfix/other workflows unchanged unless specified).
- B: `critical` — keep the shipped default; the epic-design note was superseded, and only the rationale record needs updating.

**Answer**: *Pending*

### Q3: Canonical severity vocabulary (D2)
**Context**: The three schemas disagree on severity naming: the live
`review-artifact.ts` uses `critical|major|minor`; #1125's `review-findings-artifact.ts`
uses `blocking|advisory`. FR-001/SC-001 require exactly one surviving schema, and
D3/Q2 presumes a graded scale (`major` is only meaningful under `critical|major|minor`).
**Question**: Which severity vocabulary is canonical for the surviving schema?
**Options**:
- A: `critical|major|minor` (the live `review-artifact.ts` vocabulary; consistent with a `major` default).
- B: `blocking|advisory` (the #1125 vocabulary; would require re-expressing the `blockingSeverity` default as a boolean split).

**Answer**: *Pending*

### Q4: Canonical status model & per-finding identity (D2)
**Context**: If Q1 = activate, cross-round matching and monotonic status transitions
need a stable per-finding identity plus `lastReviewedCommitSha` and `round` on the
canonical schema. If Q1 = delete, the live schema (`open|resolved`, no per-finding
id) survives as-is. This determines the exact field set of the one surviving schema
and whether back-compat parsing must default-fill new fields on in-flight sidecars.
**Question**: What field set should the single canonical schema carry?
**Options**:
- A: Convergence-capable — stable per-finding id, engine-owned monotonic `open|resolved` status, `lastReviewedCommitSha`, and `round` (choose only if Q1 = activate).
- B: Minimal — keep the live `review-artifact.ts` shape (`open|resolved`, no per-finding id); drop or reserve `lastReviewedCommitSha` (choose only if Q1 = delete).

**Answer**: *Pending*

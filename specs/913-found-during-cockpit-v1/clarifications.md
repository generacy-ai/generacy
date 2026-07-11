# Clarifications

## Batch 1 — 2026-07-11

### Q1: `--pr <number>` and `<ref>` linkage semantics
**Context**: US2 shows the escape hatch invoked as `cockpit merge <ref> --pr <number>` — both are supplied. FR-007 says `--pr` MUST enforce "the same `completed:validate` issue-label precondition", which requires an *issue* to check the label on. But the spec is silent on whether the resolver must verify that `<number>` actually closes `<ref>`. A permissive design (trust the operator) is simplest but lets a mistyped `--pr 100` merge PR 100 while the operator thought they were merging PR 200 — labeling an unrelated issue "validated". A strict design (verify linkage) protects against that mistake but re-introduces a dependency on the exact resolver machinery that #913 exists to bypass. A third option drops `<ref>` entirely when `--pr` is present and derives the closing issue from the PR itself — but that fails if the PR doesn't declare a closing issue.
**Question**: When `--pr <number>` is provided, what's the source of the `completed:validate` issue-label check, and does the resolver verify PR-to-issue linkage?
**Options**:
- A: `<ref>` remains required; `completed:validate` is checked on `<ref>` as supplied; the resolver does NOT verify that `<number>` closes `<ref>` (trust the operator; linkage errors are on them).
- B: `<ref>` remains required; `completed:validate` is checked on `<ref>` as supplied; the resolver additionally verifies that `<number>` declares `<ref>` as a closing issue (via PR body / `closesIssues` query) and refuses on mismatch (exit 3).
- C: `<ref>` becomes optional when `--pr` is provided; the closing issue is inferred from the PR's own closing-issue references; the label is checked on the inferred issue; refuse if the PR declares no closing issue.
- D: `<ref>` remains required; the resolver verifies linkage but treats mismatch as a warning (log + prompt-style confirmation), not an outright refusal.

**Answer**: *Pending*

### Q2: Payload excerpt char cap in parse-failure diagnostics (FR-009)
**Context**: FR-009 says the parse-failure error message MUST include "up to N chars of the offending payload". N is undefined. The choice trades diagnostic fidelity for log-line noise and terminal readability. Sibling call sites already use 200 (`wrapper.ts:507, 529, 768`), so parity is a defensible default. But `closedByPullRequestsReferences` payloads are richer than the sibling shapes (each ref carries `id`, `repository`, `url`) and can plausibly exceed 200 chars for issues closed by multiple PRs — truncating too early hides the shape drift the diagnostic exists to reveal.
**Question**: What character cap should the FR-009 payload excerpt use?
**Options**:
- A: 200 chars (parity with existing `slice(0, 200)` sites in `wrapper.ts:507, 529, 768`; consistent codebase idiom).
- B: 512 chars (roomier — accommodates 2-3 refs in the minimal-shape output; still one-line-ish in modern terminals).
- C: 1024 chars (fits realistic worst-case: an issue closed by 5+ PRs each with `id`+`repository`+`url`; may wrap on narrow terminals).
- D: 2048 chars (near-full-fidelity; effectively "the whole thing" for this endpoint).

**Answer**: *Pending*

### Q3: `--pr <number>` on an already-merged or closed PR
**Context**: FR-006 says `--pr` fetches the PR detail before merging; FR-008 says `--pr` refuses when preconditions fail. But the spec doesn't classify "PR is already MERGED" or "PR is CLOSED (unmerged)" — do those count as failed preconditions? Auto-mode is likely to retry `cockpit merge` after transient failures; if a prior invocation already succeeded but the operator (or auto-mode) re-runs, an "already merged" refusal produces a confusing error, while an idempotent success is safer for re-run scenarios. But blindly succeeding on a MERGED PR hides genuine mistakes (operator meant a different PR). CLOSED-unmerged is unambiguously an operator error and should refuse.
**Question**: What happens when `--pr <number>` targets a PR whose state is not OPEN?
**Options**:
- A: MERGED → refuse (exit 3, "PR is already merged"); CLOSED-unmerged → refuse (exit 3, "PR is closed without merge"). Symmetric; no idempotency; every merge is a distinct action.
- B: MERGED → idempotent success (exit 0, log "PR already merged, no-op"); CLOSED-unmerged → refuse (exit 3). Friendly for retry / auto-mode; hides no-op distinction from operator via log.
- C: MERGED → refuse (exit 3) unless a `--allow-already-merged` flag is set; CLOSED-unmerged → refuse (exit 3). Explicit opt-in for the idempotent case.
- D: MERGED and CLOSED-unmerged both idempotent success (exit 0) — treat "not open" as "nothing to merge, nothing to fail on". Most permissive.

**Answer**: *Pending*

### Q4: Tier-1 follow-up-call failure semantics
**Context**: FR-002 requires a follow-up call (either a single `gh api graphql` selection or one `gh pr view` per resolved PR number) to obtain each PR's `state`, `headRefName`, and `isDraft`. The follow-up call can fail two ways: (i) *total* failure — the GraphQL call errors out, or every `gh pr view` errors; (ii) *partial* failure — for the per-PR strategy, one of N calls errors while others succeed. Today's tier-1 behavior is "throw zod parse error → merge command aborts"; the fix must decide whether to preserve that abort-on-failure or fall through to tier-2 (branch search) as if tier-1 simply returned no candidates. Partial failure adds a third axis: filter out the failed PRs and proceed with the survivors, or treat any partial failure as total?
**Question**: When the tier-1 follow-up call to fetch `state`/`headRefName`/`isDraft` fails (total or partial), what's the resolver's behavior?
**Options**:
- A: Hard-fail on any follow-up call failure (total or partial) — bubble the error up; `cockpit merge` aborts (exit 1). Preserves today's abort-on-shape-mismatch failure mode but with a clearer diagnostic. Simplest; safest against silent-drop bugs.
- B: Fall through to tier-2 (branch search) on total failure; hard-fail on partial failure — treat "we know a PR exists but couldn't fetch its state" as an inconsistency worth aborting on, but "we couldn't reach GraphQL at all" as a resolver-down signal that tier-2 can handle.
- C: Fall through to tier-2 on total failure; filter out failed PRs on partial failure — proceed with the successful subset. Most resilient; but if the "successful subset" happens to filter out the *actual* target PR, the tier-1 result becomes silently wrong.
- D: Retry each failing call once with 1s backoff before applying option A (hard-fail). Cheapest defense against transient network flakes without changing the semantic shape of the failure.

**Answer**: *Pending*

### Q5: FR-002 fetch strategy preference
**Context**: FR-002 lists two acceptable strategies for obtaining the PR detail fields (`gh api graphql` with an explicit selection set, or per-PR `gh pr view`) and defers the choice to plan phase. But the two strategies have materially different trade-offs that a plan-phase reviewer would want the operator's signal on: `gh api graphql` is a single call regardless of PR count (better latency, one auth/network cost) but couples the fix to graphql query stability; per-PR `gh pr view` is N calls (higher latency for multi-PR issues) but reuses the well-worn `--json state,headRefName,isDraft` idiom that appears elsewhere in `wrapper.ts` and is the least likely to drift. Q4's answer also interacts (per-PR calls have a partial-failure story; the single graphql call doesn't).
**Question**: Does the operator have a preferred fetch strategy for FR-002, or is the choice genuinely deferred to plan-phase judgment?
**Options**:
- A: Genuinely deferred — plan phase picks. The spec doesn't need to constrain this further; either strategy satisfies FR-002 and the Q4 answer applies to whichever is chosen.
- B: Prefer `gh api graphql` — single call, better latency, more explicit contract. The `--json` shape drift is exactly the coupling we're removing; going deeper into gh's implicit contracts is a step backward.
- C: Prefer per-PR `gh pr view` — reuses established `--json` idiom that already ships in `wrapper.ts`; per-PR failures are surgically recoverable per Q4-B/C; no new query surface to test.
- D: Prefer `gh api graphql` for the *primary* path with per-PR `gh pr view` as a documented fallback if the graphql call errors — belt-and-suspenders, at the cost of two code paths to maintain.

**Answer**: *Pending*

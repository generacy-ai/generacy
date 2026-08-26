# Contract: Scoped-review round-gating state machine

**FRs**: FR-001, FR-002
**Site**: `packages/orchestrator/src/worker/review-executor.ts:80-199`

---

## Problem

`context.reviewScope` (a fixed `{baseSha, headSha[, conflictedPaths]}` supplied by the
merge-conflict handler) is applied to **every** review round because nothing clears it. A
scoped review → `changes-required` → remediate pushes fix commits → the re-entered review
is still pinned to the original pre-remediation window whose charter says "Ignore files and
changes outside this range", so the fix commits are invisible and the same findings
re-report every round until the remediation cap.

## Fix — honor `reviewScope` on round 1 only

The engine review artifact (`readReviewArtifact`) already distinguishes round 1 from
later rounds. Read it **before** the reviewScope branch and gate scope usage on
`!priorRound`.

### Required read order
```
1. priorRound = await readReviewArtifact(...)        // MOVED before the scope branch
2. round      = (priorRound?.round ?? 0) + 1
3. useScope   = context.reviewScope != null && !priorRound
4. if (useScope) { empty-window short-circuit; delta pauseContext from reviewScope }
   else          { standard #1126 delta: lastReviewedCommitSha..HEAD }
5. charter diffWindow = useScope ? context.reviewScope : undefined
```

### State machine
```
        ┌────────── round 1 ──────────┐         ┌──── round 2+ ────┐
        │ priorRound == null          │         │ priorRound != null│
        │ reviewScope present?        │         │ reviewScope IGNORED│
        │   yes → scoped (allowlist)  │  ──▶     │ delta:             │
        │   no  → whole-PR            │         │  lastReviewedCommit │
        └─────────────────────────────┘         │  Sha .. HEAD        │
                                                └─────────────────────┘
```

- **Round 1, reviewScope present**: scoped review over the conflicted-path allowlist
  (`review-scope.md`).
- **Round 1, no reviewScope**: whole-PR review (unchanged; non-merge-conflict path).
- **Round 2+**: `reviewScope` is not consulted. The re-review uses the standard delta
  `lastReviewedCommitSha`..HEAD, which spans the remediation commits pushed since the
  prior scoped round. A genuinely-fixed defect reports `clean` and the loop advances.

## Invariants
- `reviewScope` is never mutated or persisted; it is simply not read on round 2+.
- The empty-window short-circuit (`:98-113`), delta pauseContext (`:137-144`), and charter
  `diffWindow` (`:170`) are all gated on the same `useScope` predicate — no path can apply
  the scope on round 2+.
- Non-scoped reviews and the flag-ON whole-PR path are byte-identical to pre-#1164
  (FR-009): they never set `reviewScope`, so the new `!priorRound` gate is inert for them.

## Test assertions
- SC-001: scoped review round 1 → `changes-required` → remediation commit fixes the defect
  → round 2 window includes the remediation commits → verdict `clean` → loop advances past
  `review` and does not hit the remediation cap.
- FR-002: the round-2 delta demonstrably contains the remediation commit SHAs.
- FR-009: a round-2 review with no `reviewScope` (ordinary PR) behaves identically to
  today.

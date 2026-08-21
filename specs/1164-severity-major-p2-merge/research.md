# Research: Merge-conflict scoped-review lifecycle fixes

**Feature**: Fix four related defects in the merge-conflict → scoped-review lifecycle
**Branch**: `1164-severity-major-p2-merge`

All four decisions were pre-resolved to option **A** during `/clarify`; this document
records the rationale and the rejected alternatives, grounded in the current-tree call
sites resolved during `/plan`.

---

## Decision 1 (FR-001 / FR-002): Clear the scope after round 1 (Defect 1)

**Decision**: After the first scoped review round, do not reuse `context.reviewScope`.
Read the prior engine artifact (`readReviewArtifact`) **before** the reviewScope branch
and honor `reviewScope` only when there is no prior round (`!priorRound`). Round 2+ falls
back to the standard #1126 delta (`lastReviewedCommitSha`..HEAD), which naturally spans
the remediation commits.

**Why**: The review executor already runs the delta machinery keyed on the prior
artifact's `lastReviewedCommitSha`. Clearing the scope lets the delta span
`lastReviewedCommitSha`..HEAD for free — no new plumbing, and the remediation commits
become visible.

**Alternatives considered**:
- **Extend `headSha` to current HEAD (keep `baseSha`)** — grows the window to include
  the remediation commits but keeps the full parent-1 base delta pinned every round,
  re-introducing Defect 2 that FR-003 exists to eliminate. Rejected.
- **Persist a per-round scope stack** — net-new state for a problem the existing delta
  machinery already solves. Rejected as over-engineering.

**Call-site note**: `review-executor.ts:97` destructures `reviewScope` and the empty-window
short-circuit (`:98-113`) runs *before* `priorRound` is read (`:116`). The fix reorders
these so `priorRound` gates the empty-window check, the delta pauseContext (`:137-144`),
and the charter `diffWindow` (`:170`).

---

## Decision 2 (FR-003): Conflicted-path allowlist (Defect 2)

**Decision**: Capture the set of conflicted file paths at resolution time
(`git diff --name-only --diff-filter=U`, already enumerated at
`merge-conflict-handler.ts:275-291` and carried through evidence as
`mergeConflict.conflictedPaths`) and pass them as an explicit path allowlist that the
scoped review is restricted to. Extend `ReviewScope` with `conflictedPaths?: string[]`;
the charter names the allowlist instead of the raw `baseSha..headSha` parent-1 diff.

**Why**: The conflicted paths are already computed at resolution time and already flow
through evidence, so the allowlist reuses captured data and confines the review precisely
to the resolution surface. Crucially, the enumeration is a **live local variable** at the
`pushAndSucceed`/`finishSuccess` re-arm call site (`:389`) — the re-arm happens
synchronously within the same `MergeConflictHandler.handle()` invocation — so **no
cross-pause persistence is required**. Thread the local through
`pushAndSucceed → finishSuccess → getResolutionScope`.

**Alternatives considered**:
- **Merge-base three-dot semantics** (`git diff --merge-base <base> HEAD`) — excludes
  changes already on the base branch, but still pulls in the branch's entire own PR diff.
  That is the whole-PR review Defect 2 exists to avoid. Rejected.
- **Persist conflictedPaths across the pause** (StageContext / `conflictedPathsAtPause`)
  — unnecessary once we recognize the re-arm is in-invocation; adds durable state for a
  value that is live in scope. Rejected.

---

## Decision 3 (FR-004 / FR-005): Suppress the trivial-diff rule for scoped reviews (Defect 3)

**Decision**: Emit the charter's "Empty or trivial diff → blocking finding" paragraph
only when the review is **neither** a verification pass **nor** a windowed (scoped)
review — i.e. whole-PR round-1 only.

**Why**: The trivial-diff rule exists to catch a round-1 whole-PR review whose diff is
implausibly small relative to what the issue asks for (an implementation that did not
happen). A conflict resolution is legitimately small; applying the rule to a scoped
window produces a spurious `changes-required` loop over a valid resolution.

**Call-site note**: `review-charter.ts:143-154` currently emits the paragraph in the
`else` branch (not verification), which still fires for a round-1 scoped review because
`diffWindow` and the trivial-diff paragraph are in the same `else`. The fix guards the
paragraph on `!verification && !diffWindow`.

**Alternatives considered**:
- **Lower the severity for scoped reviews** — still injects noise and a judgment call the
  agent should not be making on a resolution window. Rejected.

---

## Decision 4 (FR-006 / FR-007): Label invalidation on re-arm (Defect 4 bypass)

**Decision**: Add `completed:validate` and `completed:implementation-review` to the
`applySuccessDisposition` remove-labels batch so the #1133 terminal short-circuit
(`phase-loop.ts:353-374`) no longer fires on labels granted before the post-merge tree
existed. `validate` then runs normally on the merged tree.

**Why**: The #1133 short-circuit keys purely on label presence, and no
validate-tree-SHA state exists today. Making the short-circuit tree-aware would require
net-new persisted state, against the spec's "existing machinery / no new label
vocabulary" assumption. The re-arm already edits labels via `applySuccessDisposition`, so
label invalidation is the minimal in-machinery fix.

**Alternatives considered**:
- **Tree-aware short-circuit** — record the SHA `validate` last ran against; re-run when
  HEAD differs. Correct in principle but introduces new persisted per-issue state and a
  new comparison path. Rejected for this P2 fix.

---

## Decision 5 (FR-008): Reorder — enqueue before clearing ownership labels (Defect 4 crash window)

**Decision**: Move the `agent:in-progress` / `agent:paused` clear out of
`applySuccessDisposition` into an `afterEnqueue` closure that the dispatcher invokes
**after** `enqueueIfAbsent` returns. Implement it as an optional
`afterEnqueue?: () => Promise<void>` on the `PostCompleteAction` rearm variant.

**Why**: The dispatcher has **no** `GitHubClient` in worker mode (`labelCleanup` is
`undefined`, `server.ts:462-470`), and the re-arm `postComplete` object is passed
in-process (never serialized to Redis). So the closure is built by the worker (which holds
`github` at `claude-cli-worker.ts:322`) and invoked by the dispatcher after
`enqueueIfAbsent` (`worker-dispatcher.ts:474`). Enqueue-first makes the crash-safe
direction "queued work + a stale ownership label" (benign — overwritten by
`onResumeStart`) rather than "no label + no work" (silent stall). The in-flight SET, not
the labels, is the double-claim guard, so a lingering `agent:*` label is harmless.

**Alternatives considered**:
- **Durable marker + recovery monitor** — a re-arm intent that a monitor detects and
  re-enqueues after a crash. Adds a new component far heavier than this P2 note warrants,
  against the spec's minimalism. Rejected.

**Invocation semantics**: `afterEnqueue` runs inside the dispatcher's `try` after
`enqueueIfAbsent` resolves — on both `enqueued === true` and the dropped
(`enqueued === false`) case, but **not** if the enqueue itself threw (the catch path
leaves pause labels intact for the next poll, so ownership labels must also survive).
Best-effort inner try/catch: a failed label clear must not fail the dispatch.

---

## Regression guard (FR-009)

Every change is gated on `reviewScope` presence, a round check, or a merge-conflict-only
code path:
- FR-001/002: gated on `!priorRound` — round 2+ of any review is unchanged; whole-PR
  reviews never carry a `reviewScope` so are untouched.
- FR-003: `conflictedPaths` is only populated on the post-conflict-resolution success
  path; the no-op and clean-merge paths leave it empty/undefined.
- FR-004: charter change is gated on `diffWindow` presence (scoped reviews only).
- FR-006/007/008: gated behind the two epic flags; a cluster with both OFF never
  re-arms through this path.

---

## Sources / references

- develop `155b3464` (original issue line refs); current-tree call sites resolved this
  session.
- #1120 engine-native review/remediate epic; #1153 follow-up epic.
- #1126 / #1161 delta-scoped re-review (`lastReviewedCommitSha`..HEAD).
- #1131 resolution-scoped reviews (`ReviewScope`, charter `diffWindow`).
- #1133 CI-aware merge gate + terminal short-circuit.
- #902 re-arm queue mechanics (`enqueueIfAbsent`, `PostCompleteAction`).

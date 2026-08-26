# Contract: `blocked:stuck-feedback-loop` behavior/doc reconcile (Corner 2)

**Behavior file**: `packages/orchestrator/src/worker/pr-feedback-handler.ts`
(read-only — **no production change**, D2=A).
**Doc file**: `docs/docs/guides/generacy/review-remediate-migration.md:140`
(the only edit).

## Behavior (unchanged — the invariant, FR-004)

- `BLOCKED_STUCK_FEEDBACK_LOOP_LABEL = 'blocked:stuck-feedback-loop'`
  (`pr-feedback-handler.ts:45`), applied at `:632` on
  `(!cliSelfCommitted && (!success || !hasChanges))`.
- The PR-feedback monitor skips **all** `blocked:*` labels, so this label is the
  only bounded stop for the #883 runaway on the flag-OFF PR-feedback legacy path.
  It must keep bounding that runaway — no reintroduction of an unbounded
  re-enqueue cycle.

## Doc change (FR-003)

The current line reads:

> This replaces the retired `blocked:stuck-feedback-loop` dead-end — that label
> stranded a run permanently with no resume path. `waiting-for:remediation-limit`
> is a resumable pause, not a terminal block.

**Correction**: scope the "retired/replaced" claim to the **epic
review/remediate path**, and affirm that `blocked:stuck-feedback-loop` retains its
bounded-stop role on the **flag-OFF PR-feedback legacy path**. Suggested wording
(implementer may refine, preserving the two facts below):

> On the review/remediate path, `waiting-for:remediation-limit` (a resumable pause)
> supersedes the old `blocked:stuck-feedback-loop` dead-end. Note that
> `blocked:stuck-feedback-loop` is **not** retired globally: on the default
> (flags-OFF) PR-feedback path it remains the only bounded stop for the #883
> runaway, since the PR-feedback monitor skips all `blocked:*` labels.

Two load-bearing facts the corrected prose must carry:
1. `waiting-for:remediation-limit` supersedes the label **only on the epic path**.
2. The label is still active and load-bearing on the flag-OFF PR-feedback path.

## Test assertion (FR-003 acceptance)

A test asserts the chosen behavior for the flag-OFF stuck-loop path — i.e. that
the label is still applied and bounds the loop on the legacy path (the behavior the
corrected docs now describe). No new behavior is introduced; the test pins the
existing bounded-stop so it cannot silently change (SC-003).

## Changeset

None for this corner — the doc file is outside `packages/*/src/`, and the
behavior test is test-only (exempt from the changeset gate).

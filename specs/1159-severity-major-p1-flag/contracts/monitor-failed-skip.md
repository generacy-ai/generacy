# Contract: Monitor `failed:*` re-enqueue skip

**Feature**: `1159-severity-major-p1-flag` · **FR-003 (Q3→A)** · **SC-002**
**Site**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` (near `:557`)

## Rule

When evaluating whether to re-enqueue an issue, the monitor MUST skip
re-enqueue for any issue carrying a label whose name starts with `failed:`.

- Match: **blanket prefix** `label.name.startsWith('failed:')`. No allow-list.
- Placement: adjacent to the existing `blocked:*` short-circuit, **after** the
  `waiting-for:remediation-limit` (`:473`) and `blocked:fixer-timeout` (`:505`)
  branches, so retry-eligible carve-outs are unaffected.
- Log: mirror the shape of the `blocked:*` skip log line.
- Clear convention: operator removes the `failed:*` label (already the resume
  convention for `failed:review` / `failed:validate-repeated`).

## Preconditions

- The issue is otherwise re-enqueue-eligible (Case A "trust-live thread present"
  would be true).
- The issue carries ≥1 `failed:*` label.

## Postconditions

- The issue is NOT re-enqueued on this poll.
- No mutation to the issue, PR, or review artifact by the monitor.
- The `clearReviewArtifact` reset (`claude-cli-worker.ts:593`) is NOT reached for
  this issue on this path → `remediationCount` is preserved.

## Non-goals

- Does not resolve human threads (deliberately — a failed run should surface, not
  silently resolve).
- Does not add parked-state machinery (that was Q3 option C, rejected).
- Does not enumerate specific `failed:*` labels (that was Q3 option B, rejected).

## Test (SC-002)

`pr-feedback-monitor-service.*.test.ts`: an issue labeled `failed:review` with an
unresolved human thread present asserts **0 re-enqueues** across subsequent polls
while the label persists; removing the label restores eligibility.

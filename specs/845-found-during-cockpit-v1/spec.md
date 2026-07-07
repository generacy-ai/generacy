# Feature Specification: `cockpit advance` must not remove `waiting-for:<gate>` — preserve the resume signal for poll-only clusters

**Branch**: `845-found-during-cockpit-v1` | **Date**: 2026-07-07 | **Status**: Draft | **Issue**: [generacy-ai/generacy#845](https://github.com/generacy-ai/generacy/issues/845)

## Summary

Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #11 — and the highest-impact one yet: `cockpit advance` strands every issue it advances.

**Observed**: `/cockpit:clarify` ran on christrudelpw/sniplink#2/#3/#4 — answers posted, `cockpit advance --gate clarification` reported success (`waiting-for:clarification → completed:clarification`). The issues never resumed: labels sat at `{completed:clarification, agent:in-progress, agent:paused}` indefinitely.

**Root cause**: `advance` adds `completed:<gate>` and then REMOVES `waiting-for:<gate>` (see `packages/generacy/src/cli/commands/cockpit/advance.ts:169-176`). But the orchestrator's poll-path resume detection (`label-monitor-service.ts` ~lines 175–180) requires the PAIR: a `completed:*` label whose matching `waiting-for:*` is absent is logged as `"completed:* label seen without matching waiting-for:* label"` and returns `null` — no resume event fires. The webhook path can catch the brief add-then-remove window, but poll-only clusters (fresh local deploys without webhook delivery) miss it deterministically.

**Control case**: the tetrad-development dogfooding round added ONLY `completed:clarification` by hand (generacy#805, tetrad#87), left `waiting-for` in place, and resumed cleanly — the worker itself removes `waiting-for` + `completed` + `agent:paused` on resume.

**Contract mismatch**: `docs/label-protocol.md` in tetrad-development (*"When a `waiting-for:*` label is present, the worker stops. The monitor watches for a matching `completed:*` label to resume"*) implies add-only. The rev 3 catalog's advance row (`"add completed → remove waiting-for"`) specified the removal incorrectly and the implementation followed it. The catalog is being corrected.

**Fix**: `advance` posts the marked comment and adds `completed:<gate>` — and does NOT remove `waiting-for:<gate>`. Label cleanup on resume belongs to the worker (which already does it). Keep the idempotence/gate-mismatch refusal checks unchanged.

**Manual repair applied on the test epic**: re-added `waiting-for:clarification` to sniplink#2/#3/#4 to restore the pair.

## User Stories

### US1: Advanced issues resume on poll-only clusters

**As a** cockpit operator running `cockpit advance --gate <name>` against issues on a poll-only cluster,
**I want** the advanced issue to actually resume its workflow phase,
**So that** manually flipping a gate reliably unblocks work regardless of whether the cluster has GitHub webhook delivery.

**Acceptance Criteria**:
- [ ] After `cockpit advance` succeeds, both `waiting-for:<gate>` and `completed:<gate>` are present on the issue.
- [ ] The orchestrator's poll-path resume detector observes the pair and fires a resume event on its next poll cycle.
- [ ] The worker on resume removes `waiting-for:<gate>`, `completed:<gate>`, and `agent:paused` (existing behavior — unchanged).
- [ ] On a poll-only cluster (no webhook), an issue advanced via `cockpit advance` reaches `agent:in-progress` (post-resume state) within one poll interval.

### US2: Existing `advance` guarantees are preserved

**As a** cockpit operator,
**I want** the fix to not regress the existing safety checks,
**So that** `advance` still refuses to flip a mismatched gate and still no-ops on an already-advanced issue.

**Acceptance Criteria**:
- [ ] Idempotency (AD-6): if `completed:<gate>` is already on the issue, `advance` exits 0 with `already advanced …` and posts no comment / makes no label changes.
- [ ] Gate refusal (AD-4): if the active `waiting-for:*` label is not the requested gate, `advance` exits 3 with no side effects.
- [ ] The manual-advance marker comment is still posted before the label add.
- [ ] The stdout summary line still reports the transition (`waiting-for:<gate> → completed:<gate>`) even though the waiting label is no longer removed — messaging describes the *state transition*, not the label diff.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `runAdvance` MUST NOT call `gh.removeLabel(..., waitingLabel)` on the happy path. | P1 | Delete `advance.ts:169–176`. |
| FR-002 | `runAdvance` MUST continue to call `gh.postIssueComment` (marker) and `gh.addLabel(..., completedLabel)` in that order. | P1 | Preserve steps 1 and 2 of today's ordering. |
| FR-003 | Idempotency check (`completed:<gate>` already present → no-op) remains unchanged. | P1 | AD-6 in current implementation. |
| FR-004 | Gate refusal check (`active waiting != requested gate` → exit 3, no side effects) remains unchanged. | P1 | AD-4 in current implementation. |
| FR-005 | The stdout summary MAY continue to say `<waiting-label> → <completed-label>` (describes state transition, not label diff). | P2 | Keep line 178–181 wording. |
| FR-006 | A regression test MUST assert that after a successful advance, `gh.removeLabel` was never called with `waiting-for:<gate>` for that gate. | P1 | Add to `__tests__/advance.test.ts`. |
| FR-007 | A regression test MUST assert that after a successful advance, both labels appear in the mocked issue's label set. | P1 | Add to `__tests__/advance.test.ts`. |
| FR-008 | Existing idempotency and gate-refusal tests MUST continue to pass unchanged. | P1 | No test regressions. |
| FR-009 | Docs/comments in `advance.ts` describing the "Happy-path side-effect order" MUST be updated to remove step 3 (the removeLabel step). | P2 | Lines 4–8 in file header comment. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Advanced issues resume on poll-only clusters | 100% | On a poll-only cluster: manually reproduce sniplink#2/#3/#4 scenario — advance an issue, wait ≤ one poll interval, observe `agent:in-progress` with waiting-for/completed/paused all cleared. |
| SC-002 | `advance` never calls `removeLabel` on `waiting-for:*` | 0 calls | Regression test asserts `mockGh.removeLabel` was not called with any `waiting-for:*` argument across all happy-path test cases. |
| SC-003 | Both labels present after advance | 100% | Regression test asserts final label set contains both `waiting-for:<gate>` and `completed:<gate>`. |
| SC-004 | Existing behavior preserved | 100% | All pre-existing tests in `advance.test.ts` pass without modification (except for any that asserted `removeLabel` WAS called on `waiting-for` — those must be inverted). |

## Assumptions

- The worker's resume-path label cleanup (removes `waiting-for:<gate>`, `completed:<gate>`, `agent:paused`) is stable and correct — this feature relies on it and does not change it.
- The label-monitor poll detector's PAIR requirement is intentional and correct; the fix is to `advance`, not to the monitor.
- The rev 3 gate catalog documentation is being corrected out-of-band (in tetrad-development); this feature only changes the code implementation.
- No other cockpit command (queue, review, clarify, merge) currently removes `waiting-for:*` labels; scope is limited to `advance`.

## Out of Scope

- Changing the orchestrator's label-monitor poll detector (`label-monitor-service.ts`).
- Changing worker-side resume label cleanup.
- Adding a `--force` flag to `advance` to skip the refusal check.
- Backfilling / auto-repairing already-stranded issues (a manual re-add of `waiting-for:<gate>` restores them, and the sniplink test epic has already been repaired).
- Updating docs/`label-protocol.md` in the tetrad-development repo (tracked separately).
- Correcting the rev 3 gate catalog in tetrad-development (tracked separately).
- Webhook-path detection changes — the webhook path already tolerates the racy add-then-remove; the fix makes it moot but does not alter webhook code.

---

*Generated by speckit*

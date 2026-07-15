# Feature Specification: Address-pr-feedback flow must not advance implementation-review gate

**Branch**: `941-summary-during-snappoll` | **Date**: 2026-07-15 | **Status**: Draft
**Issue**: [#941](https://github.com/generacy-ai/generacy/issues/941) | **Workflow**: `speckit-bugfix`

## Summary

During the snappoll cockpit-auto run (`christrudelpw/snappoll`, 2026-07-14, first Sonnet-worker run), the `implementation-review` gate on issue #3 was advanced **twice without any operator approval**, each time shortly after the cockpit posted a *request-changes* review. The operator session transcript contains **no** `cockpit_advance(#3, implementation-review)` call, and neither advance left a `<!-- generacy-cockpit:manual-advance -->` audit comment.

The strong suspect is the server-side address-pr-feedback flow marking the gate complete when its fix session exits — regardless of whether the findings were actually resolved or a re-review approved.

**Net effect**: request-changes verdicts became *advisory*. A PR with three known-blocking findings (committed `node_modules/` ~4,400 files + committed `.env`, missing `postinstall: prisma generate`) sailed through validate and had to be fixed by hand on the branch before merge.

## Evidence (christrudelpw/snappoll#3 / PR #14)

| Time (UTC, 2026-07-14) | Event |
|---|---|
| 21:54:57 | `waiting-for:implementation-review` + `agent:paused` |
| 22:07:46 | Cockpit review 1 (COMMENT): **3 blocking findings** (committed `.env`, committed `node_modules/`, no `postinstall: prisma generate`) |
| 22:38:52 | `completed:implementation-review` added — **no operator advance call, no audit comment** |
| 22:39:33 | `phase:validate` → immediately `waiting-for:merge-conflicts` |
| 22:43:41 | Operator manually advances `merge-conflicts` gate (audit comment present) |
| 22:44–22:46 | Recovery re-implement; `.gitignore` entries added but tracked files never removed |
| 22:46:48 | `waiting-for:implementation-review` again |
| 22:49:54 | Cockpit review 2 (COMMENT): "previous findings **not actually resolved**" with exact `git rm -r --cached` instructions |
| 23:03:44 | `completed:implementation-review` added **again — no operator call, no audit comment, no new commits since review 2** |
| 23:05:49 | `completed:validate` |
| 23:15:43 | Operator's manual commit "Untrack node_modules and .env; add postinstall prisma generate" — the only thing that executed the review's instructions |

Operator-session advance calls for #3 (from `~/.claude/projects/-workspaces-snappoll/1d0df76b….jsonl` on snappoll-orchestrator-1): `clarification` @ 21:38:15 and `merge-conflicts` @ 22:43:38 only.

Environment: cluster `snappoll-local-1`, stable channel, orchestrator 0.8.0, Sonnet workers.

## User Stories

### US1: Operator trusts request-changes reviews as blocking

**As an** operator running a cockpit-auto session,
**I want** a `request-changes` implementation-review to hold the gate until either a follow-up review approves or I explicitly advance,
**So that** blocking findings actually block — instead of being silently discarded when the fix session exits.

**Acceptance Criteria**:
- [ ] After a request-changes review, the issue remains `waiting-for:implementation-review` regardless of whether the address-pr-feedback fix session succeeds, fails, or exits cleanly.
- [ ] `completed:implementation-review` never appears on the issue unless (a) `cockpit advance` was invoked (audit comment present), or (b) a subsequent review carrying `APPROVED` was posted.
- [ ] The snappoll #3 evidence timeline cannot recur under the fixed code: given identical inputs, the two "anonymous" `completed:implementation-review` transitions do not happen.

### US2: Every gate advance is attributable

**As an** operator auditing a run after the fact,
**I want** every `completed:<human-gate>` transition to carry an actor and audit trail,
**So that** anomalous state changes surface immediately rather than requiring cross-referencing transcripts against label timestamps.

**Acceptance Criteria**:
- [ ] For every `completed:<human-gate>` label written, either (a) a `<!-- generacy-cockpit:manual-advance -->` audit comment exists on the issue, or (b) an approving review exists on the associated PR.
- [ ] Structured logging on the orchestrator records the caller identity for any code path that mutates a human-gate label.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The address-pr-feedback (feedback-fix) worker flow MUST NOT write `completed:implementation-review` on any exit path (success, failure, timeout, crash). | P1 | Root-cause fix. |
| FR-002 | When the address-pr-feedback flow terminates, the issue's terminal label state MUST be `waiting-for:implementation-review` + `agent:paused` (return to the same human gate for re-review). | P1 | Not `phase:validate`, not `completed:*`. |
| FR-003 | The system MUST enforce an invariant: `completed:<human-gate>` labels are only written by (a) `cockpit advance` (which posts the `<!-- generacy-cockpit:manual-advance -->` audit comment), or (b) an approve-review-triggered auto-complete path. | P1 | Defensive check anywhere else that touches these labels. |
| FR-004 | Any code path that writes a `completed:<human-gate>` label MUST log a structured line with `{ actor, source, issue, gate, reason }` at info level. | P2 | Enables post-hoc auditability (US2). |
| FR-005 | A regression test MUST cover: request-changes review posted → address-pr-feedback session completes without resolving → the gate label state remains `waiting-for:implementation-review`. | P1 | Locks the bug fix. |
| FR-006 | The fix MUST NOT break the happy path where a follow-up approve review legitimately unblocks the gate. | P1 | Verify existing approve-triggered path still writes `completed:implementation-review`. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Zero anonymous `completed:implementation-review` transitions in a cockpit-auto run with request-changes reviews. | 0 in a 20-issue dogfood run | Cross-reference issue label history against operator session `cockpit_advance` calls + PR approve-review events. Every `completed:implementation-review` must map to one. |
| SC-002 | Request-changes findings are actionable, not advisory. | 100% of request-changes reviews either result in a resolving commit + approval, or block until operator advance. | For each request-changes review in a run, follow the issue forward: it must not reach `completed:validate` without a paired approval or operator-advance audit. |
| SC-003 | The bug's exact scenario is regression-tested. | 1 automated test | Test exists that asserts label state after simulated feedback-fix session exit with an outstanding request-changes review. |

## Assumptions

- The offending code path lives in the orchestrator worker's phase-loop or an address-pr-feedback-specific handler, not in the cockpit CLI or label-monitor service. Evidence: no operator call, transitions correlate temporally with fix-session exits.
- The existing `cockpit advance` path (which writes the `<!-- generacy-cockpit:manual-advance -->` audit comment) is correct and does not need to change.
- The existing approve-review auto-advance path (if one exists) is correct and out of scope for this fix.
- The companion issue about request-changes reviews being posted as a single COMMENT body (rather than inline threads) is tracked separately in the generacy#861/#869/#878/#883 lineage and is not fixed here.

## Out of Scope

- Cockpit CLI changes (`packages/generacy/src/cli/commands/cockpit/**`) — the bug is server-side.
- Changes to the inline-thread vs. single-COMMENT format of cockpit reviews.
- Broader retroactive audit tooling for existing runs with anonymous transitions.
- Fixing the underlying implementation quality that produced the committed `node_modules/`/`.env` in the first place (a snappoll workflow question, not a generacy bug).

---

*Generated by speckit*

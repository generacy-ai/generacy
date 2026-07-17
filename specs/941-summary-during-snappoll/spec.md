# Feature Specification: ## Summary

During the snappoll cockpit-auto run (christrudelpw/snappoll, 2026-07-14, first Sonnet-worker run), the `implementation-review` gate on issue #3 was advanced **twice without any operator approval**, each time shortly after the cockpit posted a *request-changes* review

**Branch**: `941-summary-during-snappoll` | **Date**: 2026-07-15 | **Status**: Draft

## Summary

## Summary

During the snappoll cockpit-auto run (christrudelpw/snappoll, 2026-07-14, first Sonnet-worker run), the `implementation-review` gate on issue #3 was advanced **twice without any operator approval**, each time shortly after the cockpit posted a *request-changes* review. The operator session's transcript contains **no** `cockpit_advance(#3, implementation-review)` call, and neither advance left a `<!-- generacy-cockpit:manual-advance -->` audit comment. The strong suspect is the server-side address-pr-feedback flow marking the gate complete when its fix session exits — regardless of whether the findings were actually resolved or a re-review approved.

The net effect: request-changes verdicts are advisory. A PR with three known-blocking findings (committed `node_modules/` + `.env`, missing `prisma generate` step) sailed through validate and had to be fixed by hand on the branch before merge.

## Evidence (christrudelpw/snappoll#3 / PR #14)

| Time (UTC, 2026-07-14) | Event |
|---|---|
| 21:54:57 | `waiting-for:implementation-review` + `agent:paused` |
| 22:07:46 | Cockpit review 1 (COMMENT): **3 blocking findings** (committed `.env`, committed `node_modules/` ~4,400 files, no `postinstall: prisma generate`) |
| 22:38:52 | `completed:implementation-review` added — **no operator advance call in the session transcript, no audit comment** |
| 22:39:33 | `phase:validate` → immediately `waiting-for:merge-conflicts` |
| 22:43:41 | operator manually advances `merge-conflicts` gate (audit comment present) |
| 22:44–22:46 | recovery re-implement; `.gitignore` entries added but tracked files never removed |
| 22:46:48 | `waiting-for:implementation-review` again |
| 22:49:54 | Cockpit review 2 (COMMENT): "previous findings **not actually resolved**" with exact `git rm -r --cached` instructions |
| 23:03:44 | `completed:implementation-review` added **again — no operator call, no audit comment, no new commits since review 2** |
| 23:05:49 | `completed:validate` |
| 23:15:43 | **operator's manual commit** "Untrack node_modules and .env; add postinstall prisma generate" — the only thing that ever executed the review's instructions |

Operator-session advance calls for #3 (from `~/.claude/projects/-workspaces-snappoll/1d0df76b….jsonl` on snappoll-orchestrator-1): `clarification` @ 21:38:15 and `merge-conflicts` @ 22:43:38 only.

## Expected

- A request-changes review must hold the gate until either (a) a re-review approves, or (b) a human advances it (leaving the standard audit comment).
- No server-side path should add `completed:implementation-review`. If the address-pr-feedback flow finishes its fix attempt, the correct terminal state is back to `waiting-for:implementation-review` for a re-review.
- Every gate transition should be attributable (actor + audit trail). Both advances here are anonymous.

## Suggested fix

1. Locate the code path that sets `completed:implementation-review` after an address-pr-feedback session exits (orchestrator worker flow) and remove/replace it with a return to `waiting-for:implementation-review`.
2. Add an invariant: `completed:<gate>` for human gates is only ever written by `cockpit advance` (marked comment) or an explicit approve flow.
3. Regression test: request-changes review posted → feedback session completes without resolving → gate must still be `waiting-for:implementation-review`.

Related: the companion agency issue about request-changes reviews being posted as a single COMMENT body with zero inline threads (the thread signal is what the feedback monitor spec keys on — generacy#861/#869/#878/#883 lineage).

Found during the snappoll T-dogfood run (cluster `snappoll-local-1`, stable channel, orchestrator 0.8.0, Sonnet workers).


## User Stories

### US1: Request-changes review holds the gate

**As a** cockpit operator running an auto-mode session,
**I want** a request-changes review on `implementation-review` to keep the gate paused until either a human `cockpit advance` or a re-review approval unblocks it,
**So that** blocking findings cannot silently sail through `validate` while I am away from the terminal.

**Acceptance Criteria**:
- [ ] When the address-pr-feedback fix session exits (whether or not findings were resolved), the issue's terminal label state is `waiting-for:implementation-review + agent:paused` — never `completed:implementation-review`.
- [ ] Any code path attempting to add `completed:<human-gate>` without an authorization token from `LabelManager` is rejected at the seam and never reaches GitHub.
- [ ] Every `completed:<human-gate>` transition that does occur is traceable to `cockpit advance` (bearing the `<!-- generacy-cockpit:manual-advance -->` audit comment).

### US2: Loud diagnostic when the gate label is stripped

**As a** platform maintainer,
**I want** a structured error log whenever the address-pr-feedback flow finds `waiting-for:implementation-review` missing at fix-session exit,
**So that** any unwanted label-stripping path (e.g. an errant `onResumeStart` invocation) becomes visible as its own defect rather than being masked by a silent re-add.

**Acceptance Criteria**:
- [ ] If `waiting-for:implementation-review` is absent at fix-session exit, the handler emits `{ event: 'gate-label-missing-at-fix-exit', owner, repo, issueNumber, pr }` at `error` level.
- [ ] The same handler idempotently re-adds `waiting-for:implementation-review` so FR-002 is still satisfied for the operator.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Locate the code path that adds `completed:implementation-review` after an address-pr-feedback fix-session exits and remove/gate that write. (Recon has ruled out `PrFeedbackHandler.handle()` itself as the direct writer — Q1 clarification confirms both a culprit-fix AND an invariant guard land in the same PR.) | P0 | Q1 → C. Diagnosis expected to fall out of FR-003. |
| FR-002 | After an address-pr-feedback fix-session exits, the terminal label state on the issue MUST be `waiting-for:implementation-review + agent:paused`. If `waiting-for:implementation-review` is missing at exit, the handler MUST log `gate-label-missing-at-fix-exit` at `error` level and idempotently re-add the label. | P0 | Q3 → C. Log-loud + re-add. |
| FR-003 | Install a runtime guard in the `LabelManager` label-writing seam that rejects any call adding `completed:<human-gate>` unless the caller passes an authorization token (e.g. `AllowGateComplete.CockpitAdvance`). The token type is a closed union of at most the currently legitimate writers. | P0 | Q4 → A. Guard is what surfaces the unknown writer during FR-001 diagnosis. |
| FR-004 | Thread the `AllowGateComplete.CockpitAdvance` token through the `cockpit advance` write site so the legitimate human-advance path continues to succeed after FR-003 lands. | P0 | Only currently-known legitimate writer per Q2. |
| FR-005 | Add an integration-layer regression test that drives a simulated `address-pr-feedback` queue item through the worker / phase-loop route with a mock GitHub client, injects a request-changes review whose findings are not resolved by the fix session, and asserts the terminal label set on the mock is exactly `{ 'waiting-for:implementation-review', 'agent:paused' }` and never contains `completed:implementation-review`. | P1 | Q5 → B. Locks the interaction chain, not just the handler. |
| FR-006 | *(Null constraint per Q2 → B.)* No approve-review auto-advance path exists today; no attempt is made to protect one. The FR-003 authorization-token union deliberately contains only `CockpitAdvance` and is closed. Introducing an `ApproveReview` writer is out of scope. | P2 | Retained as an ID so downstream artifacts referencing FR-006 keep their number. |
| FR-007 | Unit tests for the FR-003 guard: (a) `completed:<human-gate>` without token → rejected; (b) `completed:<human-gate>` with `AllowGateComplete.CockpitAdvance` → allowed; (c) `completed:<non-human-gate>` (e.g. worker-owned progress gates) → allowed without token; (d) non-`completed:*` label writes → unaffected. | P1 | Cheap layer that Q5 → B leaves uncovered. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Anonymous `completed:implementation-review` transitions after a request-changes review | 0 per cockpit-auto run | Grep the operator-session `.jsonl` transcript and issue timeline for `completed:implementation-review` add events; every one must be accompanied by a `<!-- generacy-cockpit:manual-advance -->` audit comment authored within ±5s. |
| SC-002 | Writers of `completed:<human-gate>` in the codebase | Exactly 1 (`cockpit advance`) | Static: search for the guard-token constructor call sites (`AllowGateComplete.CockpitAdvance`) — should return exactly one non-test hit. |
| SC-003 | FR-005 integration test | Passes on every PR and fails deterministically if `completed:implementation-review` is written during the fix-session path | CI run; deliberate regression: temporarily add `github.addLabels(…, ['completed:implementation-review'])` inside the fix-session exit path — the test must go red. |
| SC-004 | `gate-label-missing-at-fix-exit` error events in production | ≤ 1 open incident at any time | Log aggregator alert: if the count in the last 24h is > 0, an issue is opened describing the label-stripping path. |
| SC-005 | Reproduction of the snappoll scenario | Cannot reproduce | Replay: create a PR at `implementation-review`, post a `REQUEST_CHANGES` review with unresolved findings, let the fix session exit without resolving them → terminal label state must be `waiting-for:implementation-review + agent:paused` with no `completed:*` on the gate. |

## Assumptions

- The offending writer of `completed:implementation-review` is reachable from the address-pr-feedback flow (spec Suggested-fix §1), but recon has ruled out `PrFeedbackHandler.handle()` as the direct call site. Diagnosis of the exact writer is expected as a byproduct of the FR-003 guard tripping during test runs.
- `cockpit advance` is currently the ONLY legitimate writer of `completed:<human-gate>` labels (Q2 answer). All other paths that today write these labels are, by definition, defects to be fixed as part of FR-001.
- `LabelManager` already sits in the call graph between every legitimate label-add site and the GitHub API, so a single seam guard is sufficient (no bypass paths that call `GitHubClient.addLabels` directly for `completed:*` writes).
- Human gates are those whose `condition` in `WorkerConfigSchema.gates` is human-facing (`on-review-verdict`, `on-request`, manual). The guard token union does not need to gate `completed:<worker-owned-gate>` writes; the guard only fires on `completed:<human-gate>`.
- The Q5 → B integration test can use the existing worker / phase-loop test scaffolding with a mock `GitHubClient`; no new test-harness infrastructure is required.

## Out of Scope

- Creating an approve-review auto-advance path (Q2 → B). Any future `AllowGateComplete.ApproveReview` writer ships as its own feature with its own audit-marker design.
- Fixing the root cause of any unwanted `LabelManager.onResumeStart`-style stripping of `waiting-for:implementation-review` between the pause and fix-session-exit points. FR-002 mandates the loud log — the resulting incident becomes its own follow-up issue.
- The related `agency` companion issue about request-changes reviews being posted as a single COMMENT body with zero inline threads (generacy#861/#869/#878/#883 lineage). Referenced only for context.
- Retrofitting the audit-comment invariant to non-human gates (e.g. `completed:validate`) — those are worker-written and outside the FR-003 guard's scope.

---

*Generated by speckit*

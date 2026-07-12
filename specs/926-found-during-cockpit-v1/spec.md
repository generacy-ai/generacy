# Feature Specification: Found during the cockpit v1

**Branch**: `926-found-during-cockpit-v1` | **Date**: 2026-07-12 | **Status**: Draft

## Summary

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92), finding #60 — snappoll-1 run 9.

## Observed

The PR-feedback loop is **invisible on the event plane**. On snappoll-1#2: the auto session posted a request-changes review (03:06Z); the server-side loop engaged (`waiting-for:address-pr-feedback` added), the worker fixed the finding (commit `e3ce6ef`), resolved the thread, and removed the label (~03:23Z) — a complete, successful feedback cycle. The auto session received **zero events for any of it** and sat at an idle gate describing #2 as "awaiting its cluster agent" *after* the fix had already landed; the operator had to intervene manually ("looks like it has already been addressed").

## Root cause (verified in source)

1. **State precedence hides the loop.** `packages/cockpit/src/state/precedence.ts`: `WAITING_PIPELINE_ORDER` lists `waiting-for:implementation-review` explicitly; `waiting-for:address-pr-feedback` is unlisted and "sorts after all listed gates". `waiting-for:implementation-review` stays set for the whole feedback cycle (the handler never touches it), so with both labels present the curated state is `waiting-for:implementation-review` before, during, and after the loop — the add edge and the remove edge both produce **no state transition**, hence no watch/`cockpit_await_events` event. The auto playbook's D.3 re-review trigger can structurally never fire.
2. **Handler label hygiene.** `pr-feedback-handler.ts:719` removes only `waiting-for:address-pr-feedback` on completion; `agent:in-progress` is left set (observed coexisting with `agent:paused` on #2) — an under-cleaned terminal state in the #902 family: the issue *looks* gated, but the gate is a stale artifact no observer will ever be told to act on.

Historical note: this gap predates the MCP migration but was masked — the pre-#403 loop re-checked live state on *every* event, so any unrelated event on the issue caught the completed fix incidentally (run 7's #3 re-review worked this way). The efficiency contract removed that incidental redundancy, exposing the missing signal. The signal was always missing; now it matters.

## Fix (recommended)

1. **Rank `waiting-for:address-pr-feedback` ahead of `waiting-for:implementation-review`** in `WAITING_PIPELINE_ORDER` — the exact precedent #883 set for `blocked:stuck-feedback-loop` ("surface the more-specific active state first when both coexist"). Both edges then emit transitions, and the existing auto.md dispatch table handles them with **zero playbook changes**: engage edge → `waiting-for:address-pr-feedback` → D.4 (ledger-only, server-side owns it); completion edge → back to `waiting-for:implementation-review` → D.3 fires a fresh review-verdict gate. The curated state also becomes honest during the loop (the issue is being worked, not waiting for review).
2. **Handler completion hygiene**: clear `agent:in-progress` alongside the `waiting-for:address-pr-feedback` removal (single combined label edit per the add-before-remove/atomicity conventions).

Alternative considered: re-cycling the review pair (remove `waiting-for:implementation-review` at engage, re-add at completion). Also correct and makes the raw label set non-overlapping, but it's more label writes, more intermediate states to keep detector-matched, and the precedence fix achieves the same event flow with a one-line ordering change following an established precedent.

## Regression tests

- Classifier: labels {implementation-review, address-pr-feedback} → curated state `waiting-for:address-pr-feedback`; removing it → state `waiting-for:implementation-review`.
- Event stream: add edge and remove edge each emit exactly one `issue-transition` event with the correct from/to.
- Handler completion: `agent:in-progress` absent after the feedback cycle completes; `waiting-for:implementation-review` + `agent:paused` remain (fresh D.3-ready gate state).
- End-to-end fixture: request-changes → feedback loop → completion → a watch/`cockpit_await_events` consumer receives the completion transition (the auto re-review trigger).


## User Stories

### US1: Auto-session sees the PR-feedback engage edge

**As a** cockpit auto-mode session driving an epic that has just received a request-changes review,
**I want** the moment the server-side PR-feedback loop engages (`waiting-for:address-pr-feedback` added) to surface as an `issue-transition` event on my `cockpit_await_events` stream,
**So that** playbook rule D.4 (ledger-only, server owns the fix) can dispatch on the transition instead of the session sitting at a stale `waiting-for:implementation-review` state and misreading the issue as "awaiting its cluster agent."

**Acceptance Criteria**:
- [ ] With labels `{waiting-for:implementation-review, waiting-for:address-pr-feedback}` present, the curated state is `waiting-for:address-pr-feedback`.
- [ ] Adding `waiting-for:address-pr-feedback` on top of `waiting-for:implementation-review` emits exactly one `issue-transition` event with `to = waiting-for:address-pr-feedback`.

### US2: Auto-session sees the PR-feedback completion edge

**As a** cockpit auto-mode session waiting for the server-side feedback loop to finish,
**I want** the completion edge (`waiting-for:address-pr-feedback` removed, `waiting-for:implementation-review` still set) to emit an `issue-transition` back to `waiting-for:implementation-review`,
**So that** playbook rule D.3 (fresh re-review verdict gate) fires without operator intervention and the "the fix has already landed but the session is idle" mismatch observed in snappoll-1 run 9 cannot recur.

**Acceptance Criteria**:
- [ ] Removing `waiting-for:address-pr-feedback` (with `waiting-for:implementation-review` still present) emits exactly one `issue-transition` event with `to = waiting-for:implementation-review`.
- [ ] End-to-end: request-changes → server-side feedback loop → completion → a `watch` / `cockpit_await_events` consumer receives the completion transition (the auto re-review trigger).

### US3: Terminal label state is clean after any handler return

**As a** downstream observer (auto playbook, cockpit state classifier, human on the cockpit UI) reading labels after the PR-feedback handler has returned,
**I want** `agent:in-progress` cleared on **every** terminal return from `pr-feedback-handler.ts` (happy path, no-unresolved-threads, all-comments-untrusted, and `blocked:stuck-feedback-loop` disposition),
**So that** the resulting label set is never a lying pair of "`agent:in-progress` + `agent:paused`" or "`agent:in-progress` + `blocked:stuck-feedback-loop`" — the #902 under-cleaned-terminal-state family is closed for this handler regardless of which exit path fired.

**Acceptance Criteria**:
- [ ] After the PR-feedback handler completes via the happy path, `agent:in-progress` is absent and `waiting-for:implementation-review` + `agent:paused` remain (fresh D.3-ready gate).
- [ ] After the PR-feedback handler completes via the Case A path (no unresolved threads), `agent:in-progress` is absent.
- [ ] After the PR-feedback handler completes via the Case B path (all comments untrusted, `waiting-for:address-pr-feedback` retained), `agent:in-progress` is absent.
- [ ] After the PR-feedback handler exits via a `blocked:stuck-feedback-loop` disposition, `agent:in-progress` is absent (and `blocked:stuck-feedback-loop` + `waiting-for:address-pr-feedback` are present, as designed).
- [ ] The `agent:in-progress` clear is implemented **once** as a shared exit path / `finally`, not per-site — a future fifth terminal return cannot reintroduce the leak.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `WAITING_PIPELINE_ORDER` in `packages/cockpit/src/state/precedence.ts` MUST rank `waiting-for:address-pr-feedback` at **index 1**, immediately after `blocked:stuck-feedback-loop` and ahead of every other `waiting-for:*` gate. Follows #883's precedent ("surface the more-specific active state first when both coexist") applied verbatim: an actively-rewriting-code state outranks any passive review gate, not just its documented co-occurrent. | P1 | Root cause fix — one-line ordering change. Resolves Q1 (Answer: A). |
| FR-002 | With both `waiting-for:implementation-review` and `waiting-for:address-pr-feedback` labels present on an issue, the curated state MUST be `waiting-for:address-pr-feedback`. | P1 | Direct consequence of FR-001; testable at the classifier boundary. |
| FR-003 | The add edge (`waiting-for:address-pr-feedback` applied while `waiting-for:implementation-review` is set) MUST produce exactly one `issue-transition` event on the event plane, with `to = waiting-for:address-pr-feedback`. | P1 | Restores the D.4 engage trigger. |
| FR-004 | The remove edge (`waiting-for:address-pr-feedback` removed while `waiting-for:implementation-review` is set) MUST produce exactly one `issue-transition` event, with `to = waiting-for:implementation-review`. | P1 | Restores the D.3 re-review trigger — the specific signal the auto playbook needs. |
| FR-005 | `pr-feedback-handler.ts` MUST clear `agent:in-progress` on **every** terminal return — happy path (line 357), Case A (line 222, no unresolved threads), Case B (line 232, all comments untrusted), and both `blocked:stuck-feedback-loop` dispositions (lines 302 and 337). The clear MUST be implemented **structurally** as a single shared exit path (e.g., `try/finally` or a single exit point), not as per-site edits at each of the four returns. | P1 | Resolves Q2 (Answer: C). Hoisting the clear guarantees a future fifth return cannot reintroduce the leak. |
| FR-006 | The `agent:in-progress` clear on the happy-path exit (which also removes `waiting-for:address-pr-feedback`) MUST be a **single `removeLabels(['waiting-for:address-pr-feedback', 'agent:in-progress'])` call** — one client invocation expressing one intent. The contract is "one client invocation, fewest intermediate states" — GitHub's label API has no true atomic multi-label edit, so a partial-failure window is unavoidable at this layer and no worse than two sequential calls with a crash between them. | P1 | Resolves Q3 (Answer: A). Note: this relaxes the earlier "atomicity" wording — see Q3 clarification. |
| FR-007 | Fix MUST NOT require any change to the auto playbook's dispatch table (auto.md D.3 / D.4). The precedence change alone MUST make the existing dispatch rules fire correctly. | P1 | Non-negotiable — the fix's whole point is zero-playbook-change. |
| FR-008 | Fix MUST NOT re-cycle the review pair (i.e. MUST NOT remove `waiting-for:implementation-review` at engage and re-add at completion) — the alternative considered and rejected in the issue. | P2 | Preserve minimum-writes, minimum-intermediate-states property. |
| FR-009 | Fix MUST NOT promote any of the other unlisted `waiting-for:*` gates (`pr-feedback`, `clarification-review`, `sibling-review`, `children-complete`, `epic-approval`, `dependencies`) into `WAITING_PIPELINE_ORDER` in this PR. Only `address-pr-feedback` is promoted here. | P1 | Resolves Q4 (Answer: A). Prevents assigning arbitrary precedence positions to gates whose co-occurrence semantics have not been established. |
| FR-010 | The **plan phase** MUST produce an audit deliverable: for each of the six other unlisted `waiting-for:*` gates named in `packages/cockpit/src/state/precedence.ts:22-24`, grep the writers of that gate and record whether it *can* co-occur with any gate listed in `WAITING_PIPELINE_ORDER`. Any gate for which co-occurrence is demonstrated MUST get its own follow-up issue with its own co-occurrence analysis; gates with no demonstrated co-occurrence stay as-is with the finding recorded. | P1 | Resolves Q4 amendment. Applies the finding-#52 lesson (fix one surface, verifiably-identical siblings must not stay broken) with the right evidence bar. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Curated-state correctness during a live PR-feedback cycle | Curated state is `waiting-for:address-pr-feedback` for the entire duration of the cycle | Classifier unit test: labels `{implementation-review, address-pr-feedback}` → `waiting-for:address-pr-feedback`; removing `address-pr-feedback` → `waiting-for:implementation-review`. |
| SC-002 | Event emission on engage and complete edges | Exactly one `issue-transition` event per edge, with correct from/to | Event-stream test drives both label writes and asserts event count + payload. |
| SC-003 | End-to-end auto re-review trigger | The auto session's `cockpit_await_events` consumer receives the completion transition and dispatches D.3 without operator intervention | End-to-end fixture: request-changes → server-side feedback loop → completion → assert consumer sees the completion event within one polling cadence. |
| SC-004 | Terminal label-set hygiene across all exit paths | 0 occurrences of `agent:in-progress` remaining on the issue after any of the four terminal returns from `pr-feedback-handler.ts` | Handler-completion tests, one per exit path (happy, Case A, Case B, blocked-stuck): assert `agent:in-progress` absent after handler exits; assert the surviving label set matches the path's designed post-state. |
| SC-005 | Structural single-point clear | Exactly one code site clears `agent:in-progress` in `pr-feedback-handler.ts` | Static check / code review: the `removeLabels(..., 'agent:in-progress', ...)` call appears at a single shared exit point (e.g. `finally`), not at N return sites. Grep for the label name inside the handler shows one write occurrence. |
| SC-006 | Plan-phase audit deliverable exists | `plan.md` (or a sibling artifact under `specs/926-found-during-cockpit-v1/`) contains a table of the six other unlisted `waiting-for:*` gates with each row recording writer location, demonstrated co-occurrence (yes/no), evidence, and follow-up issue link (or "no follow-up needed") | Documentation check: reviewer inspects the plan artifact and confirms all six gates are addressed. |

## Assumptions

- `packages/cockpit/src/state/precedence.ts` `WAITING_PIPELINE_ORDER` is the sole precedence source used by the classifier for `waiting-for:*` label ranking; no shadow list needs to be kept in sync.
- The auto playbook's D.3 / D.4 dispatch rules are already keyed on the curated `waiting-for:address-pr-feedback` and `waiting-for:implementation-review` states — no rule additions are required.
- The #883 `blocked:stuck-feedback-loop` precedent — "surface the more-specific active state first when both coexist" — is the correct pattern to follow. Under Q1's answer, that principle generalises: an actively-rewriting-code state outranks **any** coexisting passive gate, and the only ordering that must still win (`blocked:stuck-feedback-loop` outranking `address-pr-feedback` — pause trumps activity) is preserved by placing `address-pr-feedback` at index 1.
- `pr-feedback-handler.ts` has four terminal returns (line 222 Case A, line 232 Case B, lines 302/337 blocked-stuck, line 357 happy). #879's single-in-flight rule guarantees no other process legitimately holds `agent:in-progress` on the issue when this handler returns — so clearing `agent:in-progress` at every return is safe (it cannot race a concurrent legitimate writer).
- The GitHub REST label API does not expose an atomic multi-label edit; "single combined edit" throughout this spec means "one client-side invocation, fewest intermediate states," not "atomic on the server." Partial failure is possible but no worse than the two-sequential-call alternative.

## Out of Scope

- Retroactively fixing snappoll-1 run 9 or any other completed run. This spec restores the signal for future runs only.
- Any change to the pre-#403 "re-check live state on every event" behavior. That masking mechanism is gone by design (efficiency contract); this fix restores the *actual* signal instead of reintroducing incidental redundancy.
- Cleanup of `agent:in-progress` under-cleaned-terminal-state sites in the #902 family in handlers **other than** `pr-feedback-handler.ts`. Those are handled per-handler in their own issues.
- Promoting any of the six other unlisted `waiting-for:*` gates (`pr-feedback`, `clarification-review`, `sibling-review`, `children-complete`, `epic-approval`, `dependencies`) into `WAITING_PIPELINE_ORDER` in this PR (see FR-009). Follow-up issues are opened per-gate only when the plan-phase audit (FR-010) demonstrates real co-occurrence.
- Any change to the wire shape of `cockpit_await_events` or the `issue-transition` event payload.

---

*Generated by speckit*

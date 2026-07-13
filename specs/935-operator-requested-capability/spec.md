# Feature Specification: Operator-requested capability from the cockpit auto-mode workstream (context: generacy-ai/tetrad-development#92; auto mode now shipped to production)

**Branch**: `935-operator-requested-capability` | **Date**: 2026-07-13 | **Status**: Draft

## Summary

Operator-requested capability from the cockpit auto-mode workstream (context: generacy-ai/tetrad-development#92; auto mode now shipped to production). Companion agency spec (filed separately) covers the playbook; this issue is the engine contract and lands first.

## Motivation (two operator scenarios, one primitive)

1. **Ad-hoc issues mid-epic**: for work that can only be tested out-of-band (telephony voice agents, deployed/cloud-only behavior), testing happens *between* phases and surfaces new bugs that must be resolved before the next phase queues. The auto session needs to add, monitor, and process new issues mid-run.
2. **Epic-less auto (stabilization runs)**: drive the same file→process→merge loop over ad-hoc issues with no pre-planned epic — a stabilization effort filing bugs as it finds them. Hard requirements: the monitored set is exactly the issues explicitly added in that conversation, and multiple concurrent auto conversations (different Claude Code tabs, same orchestrator) must not observe each other's issues.

**Design reframe that unifies them**: scope = a task-list-bearing issue. Epic mode already derives its monitored set from the epic body's task list, and `event-bus-registry.ts` already re-runs `resolveEpic` during polling (line ~370) — so a ref appended to the task list joins the monitored set live. An epic-less run is then just auto driving a **tracking issue** (created at run start or supplied) whose task list grows as issues are filed. Isolation falls out structurally: distinct tracking refs → distinct event buses (registry is keyed by ref), and each Claude Code session spawns its own stdio MCP server process besides.

## Changes

1. **Pin the live-membership contract.** The per-poll re-resolution exists; make it a tested contract: an issue ref appended to the scope issue's task list mid-subscription joins the monitored set within one poll cycle **and emits an observable event on first sight** as an `issue-transition` with `initial: true` (reusing the flag S8 already stamps on connect-time snapshot events, so the auto loop's existing snapshot handling covers this case with zero playbook change) so the auto loop gets a dispatchable signal rather than a silent snapshot join. Same for removal (unchecking/removing a ref): stops monitoring, emits nothing retroactive.
2. **`cockpit scope add <scope-ref> <issue-ref>` and `cockpit scope remove <scope-ref> <issue-ref>`** (CLI verbs + `cockpit_scope_add` / `cockpit_scope_remove` MCP tools): typed append/removal of an issue ref on the scope issue's task list — concurrency-safe body edit (re-read + insert/remove + verify) with bounded retry (up to 5 attempts, exponential backoff ~100 ms/250 ms/500 ms/1 s/2 s), returning error code `SCOPE_ADD_CONTENDED` on terminal verify-mismatch. **Shape-aware section placement for `add`**: on epic bodies (those with `## Phase N:` headings) the writer appends under a dedicated `## Ad-hoc` heading (created if missing) so ad-hoc refs never inherit positional phase attribution; on flat-list bodies (no phase headings) the writer appends at the body tail with no section wrapping. Both verbs write plain `- [ ] owner/repo#N` entries. `list` is intentionally omitted from v1 (served by existing `cockpit_status`). Wrapping mutations in typed verbs keeps body-format knowledge engine-side, gives the playbook a typed result, and avoids the #899-class format-corruption risk of raw `gh issue edit --body` string surgery when recovering from typo'd refs.
3. **Single-issue queue**: `cockpit queue` today takes `<epic> <phase>`. Add an issue-level form (`cockpit queue --issue <issue-ref>` / MCP param) applying the same mechanics — assign to the cluster account + apply the `process:<workflow>` label — for exactly one issue, no phase membership required.
4. **Non-epic scope issues**: `resolveEpic`/`cockpit_status`/`cockpit_await_events` accept a plain task-list-bearing tracking issue as the scope ref. Resolver detection is **auto-detect on read paths**: `parseEpicBody` looks for at least one `## Phase N:` heading — if present, phase-shaped parsing; if absent, flat "any body with `- [ ] owner/repo#N` lines" parsing. `cockpit_status`'s output shape follows the body's actual structure. Ad-hoc mode additionally applies an explicit `type:cockpit-tracking` label to the issues *it creates*, so downstream tooling (dashboards, cleanup) has a query key; existing issues can be retargeted into scope with zero ceremony (no label required). The contract is: the scope ref does not have to be a planned epic.
5. **Isolation assertion**: two concurrent subscriptions on different scope refs (same repo) never deliver each other's events — pin with a registry-level test (largely true by construction today; make it load-bearing).

## Out of scope

- Playbook changes (auto.md ad-hoc mode, mid-run add-issue flow, phase-boundary interplay) — companion agency issue, sequenced after this ships.
- Any change to phase-queue semantics for planned epics.

## Success criteria

- Append a ref to a watched epic's task list mid-subscription → an `issue-transition` event with `initial: true` arrives within one poll cycle; the issue's subsequent transitions stream normally without `initial`.
- `cockpit_queue` (issue form) drives a bare issue into the workflow identically to a phase-queued one.
- An auto loop pointed at a tracking issue (non-epic) behaves identically to epic mode minus phase semantics; auto-detect selects flat-list parsing when no `## Phase N:` heading is present.
- Two tabs, two tracking issues, same repo: zero cross-delivery (test-pinned).
- 10 concurrent `cockpit_scope_add` calls against the same scope issue produce 10 distinct entries with no lost writes, within the bounded retry budget; contention beyond the budget fails with `SCOPE_ADD_CONTENDED`.
- `cockpit_scope_remove` inverts an `add` on the same scope+ref, restoring the pre-add body content-equivalently.


## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*

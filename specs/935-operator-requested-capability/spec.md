# Feature Specification: Cockpit dynamic scope — live task-list membership, scope-add verb, single-issue queue, non-epic tracking issues

**Branch**: `935-operator-requested-capability` | **Date**: 2026-07-13 | **Status**: Draft
**Upstream**: [generacy-ai/generacy#935](https://github.com/generacy-ai/generacy/issues/935)
**Context**: [generacy-ai/tetrad-development#92](https://github.com/generacy-ai/tetrad-development/issues/92) (auto-mode workstream, now in production)

## Summary

The cockpit engine already treats the epic body's task list as the source of monitored refs, and `event-bus-registry.ts` re-runs `resolveEpic` every poll cycle. This feature turns that latent capability into a **pinned engine contract** and unifies two operator scenarios — *ad-hoc issues mid-epic* and *epic-less stabilization runs* — under one primitive: **scope = a task-list-bearing issue** whose membership changes live.

Four surface changes ship the primitive:
1. Contract: appending a ref to a watched issue's task list mid-subscription joins the monitored set within one poll cycle **and emits a first-sight event** the auto loop can dispatch on.
2. New verb `cockpit scope add <scope-ref> <issue-ref>` (CLI + `cockpit_scope_add` MCP tool) for typed, concurrency-safe task-list append.
3. Single-issue form for `cockpit queue` (`--issue <issue-ref>` / MCP param) — same assign+label mechanics as phase-queue, no phase membership required.
4. Non-epic scope acceptance: `resolveEpic` / `cockpit_status` / `cockpit_await_events` accept a plain task-list-bearing tracking issue.

Companion agency playbook changes (auto.md ad-hoc mode, mid-run add-issue flow) are filed separately and sequence after this ships.

## Motivation

**Scenario A — ad-hoc issues mid-epic.** For work that can only be tested out-of-band (telephony voice agents, deployed cloud-only behavior), testing happens *between* phases and surfaces new bugs that must be fixed before the next phase queues. Today the auto session has no engine-typed way to add a fresh bug to its own monitored set mid-run without dropping out and re-invoking.

**Scenario B — epic-less auto (stabilization runs).** Drive the same file→process→merge loop over ad-hoc bugs with no pre-planned epic. Hard requirements: the monitored set is *exactly* the issues explicitly added in that conversation, and multiple concurrent auto conversations (different Claude Code tabs, same orchestrator) must not observe each other's issues.

**Design reframe that unifies them.** Scope = any task-list-bearing issue. Epic mode already derives its monitored set from `parseEpicBody` (`packages/cockpit/src/resolver/parse-epic-body.ts`), and `event-bus-registry.ts:370` already re-runs `resolveEpic` each poll — so a ref appended to the task list joins the monitored set live. An epic-less run is auto driving a **tracking issue** (created at run start or supplied) whose task list grows as issues are filed. Isolation falls out structurally: distinct scope refs → distinct event buses (registry keyed by ref at `event-bus-registry.ts:253`), and each Claude Code session spawns its own stdio MCP server process besides.

## User Stories

### US1: Add a bug mid-epic and watch it flow through

**As an** operator running `cockpit auto` against a planned epic,
**I want** to file a fresh bug mid-phase and attach it to my running auto session with one typed engine call,
**So that** the auto loop picks it up within one poll cycle and drives it through the workflow without me restarting the session.

**Acceptance criteria**:
- [ ] `cockpit_scope_add(scope_ref, issue_ref)` appends `- [ ] owner/repo#N` to the scope issue's body in a concurrency-safe way (re-read + append + verify).
- [ ] Within one poll cycle after append, the auto session's event stream emits a first-sight event for the new ref (distinguishable from ordinary state transitions).
- [ ] Subsequent state transitions for that ref stream normally (no gap, no double-delivery).
- [ ] Unchecking or removing the ref stops monitoring; no retroactive event is emitted.

### US2: Epic-less stabilization run over a tracking issue

**As an** operator kicking off a stabilization effort with no pre-planned epic,
**I want** to point `cockpit auto` at a bare tracking issue whose task list starts empty and grows as I file bugs,
**So that** the session watches exactly the issues I add in that conversation and never sees issues from another operator's parallel session.

**Acceptance criteria**:
- [ ] `cockpit_status`, `cockpit_await_events`, `cockpit_scope_add`, and `cockpit_queue` all accept a tracking issue that lacks any epic marker (`type:epic` label / title convention / phase headings).
- [ ] Behavior is identical to epic mode minus phase semantics — no assumption that the body contains `## Phase N:` sections.
- [ ] Two tabs, two distinct tracking issues, same repo, same orchestrator: neither session ever receives an event scoped to the other's tracking issue.

### US3: Queue a single bare issue

**As an** operator (or auto playbook),
**I want** `cockpit queue --issue owner/repo#N` to assign the issue to the cluster account and apply the `process:<workflow>` label,
**So that** a bare issue enters the workflow identically to one phase-queued out of an epic, without needing to fabricate a phase.

**Acceptance criteria**:
- [ ] `cockpit_queue` accepts an `issue`-form input (CLI flag + MCP param) mutually exclusive with the existing `(epic, phase)` form.
- [ ] Applies the same mutations as the phase form: `addAssignees()` to the cluster account, `addLabel('process:<workflow>')` (default `process:speckit-feature`).
- [ ] Exit codes, confirmation prompts, and dry-run behavior mirror the phase form.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | An issue ref appended to a subscribed scope issue's task list MUST be included in the monitored set on the next poll cycle. | P1 | Existing per-poll re-resolution at `event-bus-registry.ts:370` — pin as tested contract. |
| FR-002 | On first-sight of a newly joined ref, the event bus MUST emit an observable event the auto loop can dispatch on (distinct from mid-stream transitions). | P1 | Exact payload shape → [NEEDS CLARIFICATION: `issue-transition { from: null }`, `initial: true` flag, or new event `type`?]. Constrained by `emit.ts:11` schema. |
| FR-003 | An issue ref removed (unchecked or line-deleted) from the scope issue's task list MUST stop generating events within one poll cycle. No retroactive/synthetic event is emitted for the departure. | P1 | |
| FR-004 | `cockpit scope add <scope-ref> <issue-ref>` CLI verb and `cockpit_scope_add` MCP tool MUST perform a concurrency-safe append (re-read body, insert entry, write, verify). | P1 | New namespace `cockpit scope` — none exists today. |
| FR-005 | Scope-add MUST write a plain `- [ ] owner/repo#N` entry in a determined section. | P1 | Section placement policy → [NEEDS CLARIFICATION: dedicated `## Ad-hoc` section vs. append to last phase section vs. no-section tail for non-epic bodies]. |
| FR-006 | `cockpit queue` MUST accept `--issue <issue-ref>` (CLI) / `{ issue }` (MCP) as an alternative to `{ epic, phase }`, applying the same assign + `process:<workflow>` label mechanics. | P1 | `queue.ts:512-523`. |
| FR-007 | `resolveEpic`, `cockpit_status`, and `cockpit_await_events` MUST accept a scope ref that does not follow the epic body convention. | P1 | Resolver behavior on non-epic bodies → [NEEDS CLARIFICATION: relax to "any issue with task-list refs" vs. define a tracking-issue convention (`type:cockpit-tracking` label / title prefix) created by ad-hoc mode]. `resolveEpic` already has no `type:epic` gate; the constraint lives in `parseEpicBody` phase-heading walk. |
| FR-008 | Two concurrent subscriptions on distinct scope refs in the same repo MUST NOT deliver each other's events. | P1 | Registry key at `event-bus-registry.ts:253` is `owner/repo#N` — largely true by construction; make load-bearing via a pinned test. |
| FR-009 | Scope-add MUST be idempotent: re-adding an already-listed ref succeeds without duplicating the line. | P2 | |
| FR-010 | The single-issue `cockpit queue` form MUST fail with a clear error if `<issue-ref>` does not exist, is closed, or is already assigned/labeled such that a second run would be a no-op. | P2 | Match existing queue behavior. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Live-membership latency | ≤ 1 poll cycle from scope-add call to first-sight event delivery | Integration test: append via `cockpit_scope_add`, assert event on the subscription within N × poll interval. |
| SC-002 | Cross-scope isolation | Zero events delivered across two subscriptions on distinct scope refs in same repo | Registry-level test with two subscriptions and disjoint mock refs; assert per-bus event ledgers. |
| SC-003 | Queue-form parity | Bare-issue queue produces identical GitHub side effects to phase-queue | Snapshot test asserting same assignees + label additions for both forms. |
| SC-004 | Non-epic acceptance | `cockpit_status` and `cockpit_await_events` on a tracking-issue scope ref return without error and stream events for its task list | End-to-end test with a tracking-issue fixture (no phase headings). |
| SC-005 | Scope-add concurrency safety | 10 concurrent `cockpit_scope_add` calls on the same scope ref produce 10 distinct entries with no lost writes | Concurrency stress test against a mock GitHub API. |

## Assumptions

- The existing `event-bus-registry.ts` polling architecture (per-scope Map keyed by ref, refcounted subscribers, per-poll `resolveEpic` re-run) is the correct substrate; no re-architecture required.
- `resolveEpic` in `packages/cockpit/src/resolver/resolve.ts:37-68` has no `type:epic` label gate today; the epic-shape constraint lives in `parseEpicBody`'s phase-heading walk. Relaxing that walk (or forking a "flat task-list" path) is the primary code change for FR-007.
- The `issue-transition` event schema in `emit.ts:5-18` (`from: z.union([z.enum(COCKPIT_STATES), z.null()])`) can carry a first-sight signal without a breaking wire change (`from: null` is already representable).
- MCP stdio process isolation per Claude Code tab is already load-bearing for cross-conversation isolation; scope-ref isolation is the *within-process* case.
- Playbook changes (auto.md updates for ad-hoc mode, when to file a tracking issue vs. reuse one, phase-boundary interplay) are out of scope and will land in a companion agency spec after this engine spec ships.

## Out of Scope

- **Playbook changes** — auto.md ad-hoc mode, mid-run add-issue prose, phase-boundary interplay. Companion agency issue, sequenced after this.
- **Any change to phase-queue semantics** for planned epics — the existing `(epic, phase)` `cockpit queue` form is unchanged.
- **Cross-repo scope** — the scope ref and appended issue refs may live in different repos (`owner/repo#N` is already a full ref), but no new cross-repo aggregation semantics are introduced.
- **Cursor / catch-up semantics** for the first-sight event — reuses whatever the existing bus already provides for late-attach subscribers; no new catch-up guarantees.
- **Removal event** — unchecking a ref stops monitoring but emits no signal; if the playbook needs a removal notification, it's a follow-up.
- **Auto-close of scope issues** — the engine does not touch the scope issue's own state (open/closed/labels beyond the task-list body).

## Open Clarifications

Track these for `/speckit:clarify`:

1. **First-sight event shape** (FR-002): `issue-transition { from: null }` vs. `initial: true` flag vs. new `event: 'issue-joined'` type — trade-off is dispatch simplicity in the playbook vs. schema stability for existing consumers.
2. **Section placement policy** (FR-005): where in an epic body does `cockpit scope add` insert the new entry? Options: dedicated `## Ad-hoc` section (created if missing), append to current phase section, append at body tail.
3. **Non-epic body convention** (FR-007): does the resolver auto-detect "flat task-list body" and skip phase parsing, or does the ad-hoc mode create tracking issues with an explicit marker (`type:cockpit-tracking` label / title prefix) that the resolver keys off?
4. **`cockpit scope` CLI namespace** shape: only `add` for v1, or also `remove` / `list` — even if `remove` emits no engine event, it may be worth a typed verb rather than raw `gh issue edit`.

---

*Generated by speckit; enhanced from [#935](https://github.com/generacy-ai/generacy/issues/935) body and code touch-point research.*

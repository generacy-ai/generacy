# Feature Specification: ## Summary

Nothing prevents two `/cockpit:auto` conversations from driving the **same** scope (epic or tracking issue) at the same time

**Branch**: `1015-summary-nothing-prevents-two` | **Date**: 2026-07-21 | **Status**: Draft

## Summary

## Summary

Nothing prevents two `/cockpit:auto` conversations from driving the **same** scope (epic or tracking issue) at the same time. Both sessions independently dispatch `cockpit_advance` / `cockpit_queue` / `cockpit_merge` against the same issues, both fire human gates, and both mutate the scope body — GitHub-level races with no coordination layer. As multi-conversation usage becomes normal (different issue sets per conversation), an accidental same-scope double-drive needs to be detected and refused, with an explicit takeover path.

Concurrent sessions on **different** scopes are already fine (per-scope refcounted event buses, timestamped ledger files) and must stay unaffected.

## Current behavior

- The MCP event-bus registry (`packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts`) is keyed by epic-ref string and **refcount-shares** a bus between concurrent subscribers (`acquireEpicBus`, ~lines 122–159) — sharing is by design for observers, but it means a second *driver* attaches silently.
- Cursors are per-process (`INSTANCE_NONCE`, `event-bus.ts:72`): if each conversation spawns its own MCP server process, the sessions don't even share the registry, so no in-process guard can see the other session.
- No lock file, no run registry, no claim marker anywhere: the only per-run artifact is the append-only ledger (`.generacy/cockpit/auto-runs/<slug>-<timestamp>.ledger`), which is written per-session and consulted by nothing.

## Proposed change

Add an **active-driver claim** per scope ref, checked when an auto run arms and released when it finishes.

Recommended mechanism: a claim marker **on the scope issue itself** (comment with a structured marker, or a label + comment), carrying a session id and a heartbeat timestamp. Rationale:

- Scope state already lives on GitHub (the task-list body); a GitHub-based claim works regardless of process topology (multiple MCP server instances, orchestrator vs. operator containers) and survives restarts/crashes via heartbeat staleness.
- In-process registry claims cannot span conversations if each conversation has its own stdio MCP server process; a disk lock file has the same reach problem across containers.

Behavior:

- **Arm**: before entering the main loop, attempt to claim the scope. If a live claim by another session exists (heartbeat fresher than a staleness threshold), refuse with a clear message identifying the other session and its ledger, and offer explicit takeover.
- **Takeover**: an explicit operator choice (e.g. `--takeover` or a gate confirmation) replaces the claim; the superseded session's next dispatch detects the lost claim and downgrades to observer/exits cleanly.
- **Heartbeat**: refresh the claim on a coarse interval (piggyback on the existing heartbeat cadence); a crashed session's claim goes stale and can be claimed without takeover ceremony.
- **Release**: on terminal (`epic-complete` / scope-drained finish) or clean exit, remove the claim.
- Observers (`cockpit_status`, `/cockpit:watch`, additional `cockpit_await_events` subscribers) are unaffected — the claim gates *driving* (advance/queue/merge dispatch), not watching.

Exact placement (skill-side check in auto.md vs. an MCP tool like `cockpit_claim` / arm-time check inside `cockpit_await_events`) to be decided in spec phase; an MCP-tool-backed claim keeps the invariant enforceable outside the playbook prose and is recommended.

## Out of scope

- Parallelizing execution across sessions (per-user worker lease cap is a separate orchestrator concern).
- Cross-session dedup of overlapping issue *sets* under different scopes (label collisions are pre-existing and unchanged).

## Acceptance criteria

- [ ] Arming auto on a scope with a live claim from another session refuses (or gates) with an actionable message; explicit takeover succeeds and the superseded session stops dispatching.
- [ ] A crashed session's stale claim does not block a new session beyond the staleness threshold.
- [ ] Claims are released on clean finish; observer tools never require or consume a claim.
- [ ] Concurrent sessions on different scopes behave exactly as today.
- [ ] Changeset included.


## User Stories

### US1: Second driver on the same scope is refused

**As an** operator who already has one `/cockpit:auto` conversation driving an epic,
**I want** a second `/cockpit:auto` invocation against the same scope to refuse at arm time with an actionable message,
**So that** two sessions cannot silently race on `cockpit_advance` / `cockpit_queue` / `cockpit_merge` against the same issues.

**Acceptance Criteria**:
- [ ] Arming auto on a scope with a live claim from another session refuses (or surfaces a takeover gate) with a message naming the other session id and its ledger path.
- [ ] Concurrent auto sessions on **different** scopes are unaffected — no shared refusal, no shared claim.
- [ ] Observer tools (`cockpit_status`, `/cockpit:watch`, additional `cockpit_await_events` subscribers) are never gated by the claim.

### US2: Explicit takeover replaces the incumbent

**As an** operator whose original session is stuck / abandoned / owned by a different terminal,
**I want** an explicit way to take over the scope's claim from a fresh conversation,
**So that** I can resume driving without waiting out the staleness threshold.

**Acceptance Criteria**:
- [ ] Passing `--takeover` on `/cockpit:auto`, confirming the gate presented on a refused arm, or calling the MCP claim tool with `takeover: true` all succeed against a live claim and replace it with the new session's id.
- [ ] The superseded session's next `cockpit_claim` refresh reports a lost claim and the session downgrades to observer / exits cleanly without further dispatch.
- [ ] The refusal message from an arm-without-takeover surfaces the takeover options (CLI flag, MCP arg, gate confirmation).

### US3: A crashed session's claim self-clears

**As an** operator whose previous auto session crashed / lost its terminal without releasing the claim,
**I want** the stale claim to be treated as absent after the staleness threshold,
**So that** I can arm a new session without manual cleanup.

**Acceptance Criteria**:
- [ ] A claim whose comment `heartbeatAt` is older than 10 minutes is treated as absent by arm-time logic — a new session acquires without a takeover ceremony.
- [ ] An orphaned `cockpit:claimed` label with no matching comment (or with a stale comment) is tolerated at arm time: the label is removed and the arm proceeds.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | An MCP tool primitive (`cockpit_claim`) implements acquire, heartbeat-refresh (same call, idempotent when already-held), and takeover (via `takeover: true` flag). A separate `cockpit_release` MCP tool ends the claim. | P1 | Q2 → C. Single acquire-or-refresh entry point + explicit release. |
| FR-002 | The claim marker is a structured HTML-comment-fenced JSON payload posted as a dedicated comment on the scope issue, carrying `sessionId`, `heartbeatAt` (ISO-8601), and a ledger pointer (relative path to the session's `.generacy/cockpit/auto-runs/<slug>-<timestamp>.ledger`). | P1 | Q1 → C. Source of truth for state. |
| FR-003 | A `cockpit:claimed` label is applied to the scope issue as a pure enumeration/status index; the label carries no per-session state. If the label is present without a matching non-stale comment (orphaned label), arm-time logic MUST tolerate it by removing the label and proceeding. | P1 | Q1 → C. Comment always wins over label. |
| FR-004 | On arm against a live claim held by another session, `cockpit_claim` returns the incumbent's payload; the caller MUST surface a refusal identifying the other session id and ledger path, and MUST list the three takeover surfaces (Q4). | P1 | Q4 → D. |
| FR-005 | Takeover is invocable via three surfaces, all funneling through `cockpit_claim` with `takeover: true`: (a) `--takeover` CLI flag on `/cockpit:auto`, (b) an interactive gate-style confirmation offered by the auto skill after a refusal, (c) direct `takeover: true` MCP argument for scripted callers. | P1 | Q4 → D. |
| FR-006 | The claim holder MUST verify it still holds the claim on every `cockpit_claim` refresh (which the auto loop calls on each wake — this is the primary detection path) and MAY opportunistically re-verify on any dispatch that already reads the scope issue. Every driving dispatch MUST NOT add a dedicated GitHub read solely for claim verification. | P1 | Q5 → C. |
| FR-007 | The auto loop refreshes the claim by calling `cockpit_claim` (idempotent when already-held) on every dispatch tick / heartbeat wake — no dedicated timer. The refresh updates the comment's `heartbeatAt`; the label is not touched. | P1 | Q3 → D + Q2 → C. |
| FR-008 | A claim whose comment `heartbeatAt` is older than **10 minutes** MUST be treated as absent by arm-time logic; a new arm can acquire without a takeover ceremony. | P1 | Q3 → D. |
| FR-009 | On terminal outcomes (`epic-complete`, scope-drained, clean exit), `cockpit_release` MUST remove both the comment (or mark it released) and the `cockpit:claimed` label. | P1 | |
| FR-010 | A session that detects a lost claim (Q5 path — `cockpit_claim` refresh returns another session as holder) MUST stop dispatching, log the takeover in its ledger, and exit cleanly. It MUST NOT attempt to reclaim. | P1 | |
| FR-011 | Observer surfaces (`cockpit_status`, `/cockpit:watch`, standalone `cockpit_await_events` subscribers) MUST NOT acquire, refresh, verify, or release claims. Attaching an observer to a claimed scope MUST succeed regardless of the claim's holder. | P1 | |
| FR-012 | A changeset entry MUST accompany the implementation PR, bumping `@generacy-ai/generacy` at least `minor` (new MCP tools + user-visible CLI flag). | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Same-scope double-drive rate | 0 concurrent live claims per scope | Integration test: arm session B against session A's live claim without `--takeover` — session B refuses, session A continues; no dispatch from B is observable in the ledger. |
| SC-002 | Different-scope concurrency preserved | No regression vs. current behavior | Integration test: two auto sessions on different scopes run to completion in parallel; each holds its own claim; no cross-refusal. |
| SC-003 | Stale-claim recovery latency | ≤ 10 minutes after the last heartbeat | Timed test: kill session A, then poll `cockpit_claim` from session B until it acquires. Time-to-acquire ≤ 10 min from A's last heartbeat. |
| SC-004 | Takeover semantics | Superseded session stops within one wake cycle | Timed test: acquire claim in A, then invoke takeover from B. A's next `cockpit_claim` call returns "lost", A logs the takeover to its ledger, A stops dispatching. |
| SC-005 | Observer independence | 100% of observer operations succeed against a claimed scope | Test: while session A holds a claim, run `cockpit_status`, `/cockpit:watch`, and a standalone `cockpit_await_events` subscription against the same scope — all succeed with no claim interaction. |
| SC-006 | GitHub write budget | Claim traffic ≤ 1 write per auto-loop wake | Static review: the only claim writes on the hot path are `cockpit_claim` (one comment edit) on wake; no per-dispatch write, no dedicated timer write. |

## Assumptions

- The auto loop's wake cadence (event-driven with heartbeat fallback via `cockpit_await_events`) reliably produces at least one wake per 10-minute window in live sessions — otherwise a healthy session's claim would go stale and be reaped. This is treated as a load-bearing property of the auto loop, not something this feature must enforce.
- The scope issue is writable by the caller (comment create/edit, label apply/remove). Repos where the auto operator lacks `issues:write` are out of scope; the refusal path would surface the underlying gh error unchanged.
- Session ids are opaque to the claim mechanism; any value that is stable within a session and probabilistically unique across sessions works. The concrete derivation (UUID, INSTANCE_NONCE, ledger-slug hash, …) is a plan-phase decision, called out as deferred in this file.
- The comment/label combination on the scope issue is not consumed by any existing tool with a semantic dependency on absent claim comments — the `cockpit:` label namespace is new and no existing skill parses `<!-- cockpit:claim v1 -->` markers.
- The 10-minute staleness threshold is a fixed default; making it configurable is out of scope for this feature.

## Out of Scope

- Parallelizing execution *across* sessions (per-user worker lease cap is a separate orchestrator concern).
- Cross-session dedup of overlapping issue *sets* under different scopes (label collisions on shared issues are pre-existing and unchanged).
- Making the staleness threshold, heartbeat cadence, or claim comment shape user-configurable.
- Claims on non-scope artifacts (individual child issues, PRs) — the claim is per-scope only (epic or tracking issue).
- Retrofitting the claim onto in-flight auto sessions started before this feature ships — the change takes effect on the next `/cockpit:auto` arm.

## Clarifications

The following clarifications from batch 1 (2026-07-21) are resolved and incorporated into FR-001..FR-012 and the assumptions above:

- **Q1 → C**: Comment + label; comment is source of truth, label is enumeration index.
- **Q2 → C**: `cockpit_claim` (idempotent acquire-or-refresh, with `takeover: true` flag) + explicit `cockpit_release`.
- **Q3 → D**: Piggyback on auto-loop wake cadence; 10-minute staleness threshold.
- **Q4 → D**: All three takeover surfaces (CLI flag, gate confirmation, MCP argument).
- **Q5 → C**: Verify on heartbeat + opportunistically on dispatches that already read the scope issue; no dedicated per-dispatch read.

Deferred to `/speckit:plan` (implementer-selectable, non-blocking):

- Session id derivation (UUID / INSTANCE_NONCE / ledger-slug hash).
- Workflow labeling / changeset bump level for the `.changeset/` file (minor per FR-012, but the label vocabulary bump policy is a plan-phase call).

---

*Generated by speckit*

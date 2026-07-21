# Feature Specification: Active-driver claim per cockpit scope

Nothing prevents two `/cockpit:auto` conversations from driving the **same** scope (epic or tracking issue) at the same time. Add an active-driver claim per scope, enforced by an MCP tool, so a same-scope double-drive is refused with an explicit takeover path — while concurrent sessions on different scopes stay unaffected.

**Branch**: `1015-summary-nothing-prevents-two` | **Date**: 2026-07-21 | **Status**: Draft | **Issue**: [#1015](https://github.com/generacy-ai/generacy/issues/1015)

## Summary

`/cockpit:auto` has no coordination layer for concurrent drivers of the same scope. Both sessions independently dispatch `cockpit_advance` / `cockpit_queue` / `cockpit_merge` against the same issues, both fire human gates, and both mutate the scope body — GitHub-level races with no coordination layer. As multi-conversation usage becomes normal, an accidental same-scope double-drive needs to be detected and refused, with an explicit takeover path.

Concurrent sessions on **different** scopes are already fine (per-scope refcounted event buses keyed by scope-ref, per-session ledger files) and must stay unaffected.

## Current behavior

- The MCP event-bus registry (`packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts`) is keyed by epic-ref string and **refcount-shares** a bus between concurrent subscribers (`acquireEpicBus`, ~lines 122–159) — sharing is by design for observers, but it means a second *driver* attaches silently.
- Cursors are per-process (`INSTANCE_NONCE`, `event-bus.ts:72`): if each conversation spawns its own MCP server process, the sessions don't even share the registry, so no in-process guard can see the other session.
- No lock file, no run registry, no claim marker anywhere: the only per-run artifact is the append-only ledger (`.generacy/cockpit/auto-runs/<slug>-<timestamp>.ledger`), which is written per-session and consulted by nothing.

## Proposed change

Add an **active-driver claim** per scope-ref, checked when an auto run arms and released when it finishes.

**Mechanism**: a claim marker **on the scope issue itself** (structured marker in a comment, and/or a label). Carries a session id and a heartbeat timestamp. Rationale:

- Scope state already lives on GitHub (the task-list body); a GitHub-based claim works regardless of process topology (multiple MCP server instances, orchestrator vs. operator containers) and survives restarts/crashes via heartbeat staleness.
- In-process registry claims cannot span conversations if each conversation has its own stdio MCP server process; a disk lock file has the same reach problem across containers.

**Placement**: an MCP-tool-backed claim (recommended: `cockpit_claim` / `cockpit_release` and heartbeat piggy-backing on an existing periodic tool) keeps the invariant enforceable outside the auto skill's playbook prose. A skill-side check in `auto.md` alone would be bypassable and unenforced in future non-playbook drivers.

Behavior:

- **Arm**: before entering the main loop, attempt to claim the scope. If a live claim by another session exists (heartbeat fresher than the staleness threshold), refuse with a clear message identifying the other session (session id, ledger path, last heartbeat) and offer explicit takeover.
- **Takeover**: an explicit operator choice (e.g. `--takeover` / a gate confirmation) replaces the claim; the superseded session's next dispatch detects the lost claim and downgrades to observer / exits cleanly.
- **Heartbeat**: refresh the claim on a coarse interval (piggyback on the existing heartbeat cadence); a crashed session's claim goes stale after the threshold and can be claimed without takeover ceremony.
- **Release**: on terminal (`epic-complete` / scope-drained finish) or clean exit, remove the claim.
- **Observers unaffected**: `cockpit_status`, `/cockpit:watch`, and additional `cockpit_await_events` subscribers do not require or consume a claim — the claim gates *driving* (advance/queue/merge dispatch), not watching.

## User Stories

### US1: Refuse a same-scope double-drive

**As an** operator who accidentally arms `/cockpit:auto` in a second conversation against a scope another session is already driving,
**I want** the second session to be refused with an actionable message identifying the incumbent,
**So that** I do not create GitHub-level races (double advance / double queue / double merge / duplicate human gates / conflicting scope-body edits).

**Acceptance Criteria**:
- [ ] Arming an auto run on a scope with a live incumbent claim from another session is refused before any driving dispatch (`cockpit_advance` / `cockpit_queue` / `cockpit_merge`) fires.
- [ ] The refusal message names the incumbent session id, its ledger path, and its last heartbeat timestamp — enough for the operator to find the other conversation.
- [ ] No mutations occur on the scope issue or its child issues from the refused session.

### US2: Explicit takeover of a stuck / abandoned driver

**As an** operator whose earlier `/cockpit:auto` session is stuck, abandoned in another conversation, or otherwise unreachable, and who needs to resume driving from a new conversation,
**I want** an explicit `--takeover` (or equivalent gate confirmation) that replaces the incumbent claim,
**So that** I can regain control without waiting the full staleness threshold.

**Acceptance Criteria**:
- [ ] An explicit takeover request succeeds against a live claim and installs the new session id on the scope.
- [ ] The superseded session detects the lost claim on its next driving dispatch and stops driving (downgrades to observer or exits cleanly), without further advance/queue/merge calls.
- [ ] Takeover is auditable: both the takeover event and the superseded session's clean stop appear in their respective ledgers.

### US3: Crashed driver does not block indefinitely

**As an** operator whose previous `/cockpit:auto` session crashed (MCP server killed, container restart, network partition) without releasing its claim,
**I want** the stale claim to expire after a bounded staleness threshold,
**So that** I can arm a new session without ceremony after that window.

**Acceptance Criteria**:
- [ ] A claim whose heartbeat has not been refreshed for longer than the staleness threshold does not block a new arm; the new session takes the claim as if it were absent.
- [ ] Live claims (heartbeat within the threshold) continue to block per US1 — staleness is time-based, not "any restart wipes."

### US4: Clean release on terminal / normal exit

**As an** operator finishing an auto run normally (`epic-complete`, scope drained, or clean `SIGINT`),
**I want** the claim released immediately,
**So that** a follow-up session on the same scope does not need takeover or a staleness wait.

**Acceptance Criteria**:
- [ ] On terminal (`epic-complete` / drained-finish) the claim is removed synchronously before the auto skill exits.
- [ ] On clean `SIGINT` / graceful shutdown the claim is removed.
- [ ] After a released claim, a new arm on the same scope succeeds immediately.

### US5: Observers stay unaffected

**As an** operator or maintainer running `cockpit_status`, `/cockpit:watch`, or an additional `cockpit_await_events` subscriber against a scope some other session is driving,
**I want** observation to work without any claim interaction,
**So that** watching a live epic never blocks it and never requires takeover.

**Acceptance Criteria**:
- [ ] `cockpit_status` returns without consulting or mutating the claim.
- [ ] `/cockpit:watch` (and any observer-only `cockpit_await_events` subscriber) works against a claimed scope without triggering a claim check, refresh, or release.
- [ ] Multiple concurrent observers against a claimed scope do not interfere with the incumbent driver's heartbeat or release.

### US6: Different-scope concurrency unchanged

**As a** power operator running two `/cockpit:auto` sessions in parallel against **different** scopes,
**I want** both sessions to arm, drive, heartbeat, and release independently,
**So that** the claim mechanism does not regress the already-supported multi-scope workflow.

**Acceptance Criteria**:
- [ ] Two auto sessions armed against distinct scope refs both succeed with no cross-blocking.
- [ ] Each session's claim, heartbeat, ledger, and release are isolated to its own scope.
- [ ] Per-scope event-bus refcount/sharing semantics are unchanged.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The engine MUST expose an MCP-tool-backed claim primitive (recommended: `cockpit_claim` acquire + `cockpit_release` release) that writes and reads a claim marker on the scope issue on GitHub. Skill-side-only enforcement in `auto.md` is prohibited as the sole gate. | P0 | Enforceable outside the playbook; future non-playbook drivers inherit the guard. |
| FR-002 | The claim marker MUST carry at minimum: `sessionId`, `heartbeatAt` (ISO-8601), and a pointer to the session's ledger path (e.g. `.generacy/cockpit/auto-runs/<slug>-<timestamp>.ledger`). Exact storage shape (structured comment marker vs. label + comment vs. both) is a clarification. | P0 | Fields required for actionable refusal messages (US1). |
| FR-003 | Before the auto loop enters its main dispatch cycle, the engine MUST attempt to acquire the scope claim. If a live claim by another session exists, the acquire MUST refuse and no driving dispatch (`cockpit_advance` / `cockpit_queue` / `cockpit_merge`) may fire from the refused session. | P0 | US1 primary gate. |
| FR-004 | The refusal path MUST return a structured, actionable payload naming the incumbent's `sessionId`, its `ledger` path, and its `heartbeatAt`, plus an indicator of the takeover mechanism (e.g. `--takeover` flag). | P0 | Powers the operator-facing refusal message (US1 AC-2). |
| FR-005 | The engine MUST support explicit takeover: a distinct acquire mode (e.g. `takeover: true`) that replaces a live incumbent claim with the caller's session id atomically on GitHub. | P0 | US2. |
| FR-006 | On any driving dispatch (`cockpit_advance` / `cockpit_queue` / `cockpit_merge`), the engine MUST verify the caller still holds the scope claim. If the current claim on GitHub does not match the caller's `sessionId`, the dispatch MUST be refused and the caller MUST stop driving (downgrade to observer or exit cleanly). | P0 | Enforces the superseded-session stop half of US2. |
| FR-007 | The engine MUST refresh the caller's claim `heartbeatAt` on a coarse interval, piggy-backed on an existing periodic tool call (e.g. within `cockpit_await_events` while driver-armed, or a dedicated heartbeat call in the loop). The exact cadence is a clarification. | P0 | Keeps live claims from being reaped mid-run; matches auto loop's existing heartbeat cadence. |
| FR-008 | The engine MUST treat a claim whose `heartbeatAt` is older than a staleness threshold as absent — a new acquire succeeds without takeover ceremony. The exact threshold (e.g. 3× heartbeat interval) is a clarification. | P0 | US3. |
| FR-009 | On terminal (`epic-complete`, scope-drained finish) the engine MUST remove the claim marker synchronously before the auto skill exits. | P0 | US4. |
| FR-010 | On clean shutdown (`SIGINT` / graceful exit) the engine MUST remove the claim marker if it is still held. Best-effort — failure to remove is logged and left to the staleness backstop. | P1 | US4. |
| FR-011 | Observer tools MUST NOT read, refresh, or write the claim marker. Enumerated: `cockpit_status`, `/cockpit:watch`, and any `cockpit_await_events` subscriber not paired with a claim acquire. | P0 | US5. |
| FR-012 | The claim mechanism MUST be keyed by expanded scope-ref (`owner/repo#number`) using the same expansion path as `event-bus-registry.ts`. Concurrent sessions on distinct scope refs MUST not cross-block. | P0 | US6. |
| FR-013 | Ledger integration: acquire, takeover, heartbeat refresh, superseded-session stop, and release events MUST each write a structured line to the calling session's ledger (`.generacy/cockpit/auto-runs/<slug>-<timestamp>.ledger`) using the existing ledger schema. | P1 | Auditability (US2 AC-3). |
| FR-014 | A changeset MUST be included in the PR. Bump level (`patch` for fix, `minor` for the new MCP tool surface) is a clarification. | P0 | Per CI gate documented in CLAUDE.md. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Same-scope double-drive from two concurrent `/cockpit:auto` sessions | Second session refused before any driving dispatch fires; zero duplicated advance/queue/merge calls on scope child issues | Integration test: arm two sessions in sequence on the same scope; assert refusal payload on the second and zero driving-dispatch tool calls from it. |
| SC-002 | Explicit takeover flow | Takeover succeeds; superseded session stops driving on next dispatch attempt with no further advance/queue/merge; both events logged | Integration test: session A holds claim, session B takes over, session A next dispatch refused and stops. |
| SC-003 | Stale-claim recovery after crash | New session succeeds without takeover once `heartbeatAt` exceeds staleness threshold | Test with injectable clock: hold claim, stop heartbeating, advance clock past threshold, new acquire succeeds. |
| SC-004 | Clean release on terminal | Follow-up arm on same scope succeeds immediately (no takeover, no staleness wait) after `epic-complete` or drained-finish exit | Integration test: drive to terminal, arm again, assert immediate success. |
| SC-005 | Observer non-interference | Observer tools (`cockpit_status`, `/cockpit:watch`, observer `cockpit_await_events`) do not touch the claim marker on GitHub | Static: grep observer tool sources for claim-marker read/write paths returns none. Dynamic: run observers against a claimed scope and assert no writes to the marker comment/label. |
| SC-006 | Multi-scope isolation | Two auto sessions on distinct scope refs both arm and drive concurrently | Integration test: arm both, assert both hold their own claims, both dispatch independently, and both release cleanly. |
| SC-007 | Refusal message actionability | Refusal payload includes `incumbent.sessionId`, `incumbent.ledger`, `incumbent.heartbeatAt`, and takeover instructions | Unit test on the refusal payload shape. |

## Clarifications

The following are open and expected to be resolved in `/speckit:clarify`:

- **Q1 — Storage shape of the claim marker**: structured comment marker only, label only, or comment + label combination? (Label collides with existing `agent:*` / `waiting-for:*` label vocabulary; comment marker avoids collision but is harder to enumerate via label search.)
- **Q2 — Session id derivation**: reuse existing per-session identifier (ledger slug/timestamp, MCP `pnonce`, or a distinct new id)? Trade-off is discoverability from the ledger vs. process-lifetime stability.
- **Q3 — Heartbeat cadence**: exact interval (piggyback on `cockpit_await_events` drains, or dedicated heartbeat cadence like 60 s / 120 s)?
- **Q4 — Staleness threshold**: multiple of the heartbeat interval (e.g. 3×) or a distinct absolute floor (e.g. 5 min)?
- **Q5 — Takeover surface**: `--takeover` CLI flag on `/cockpit:auto`, a gate-style operator confirmation inside the skill, an MCP-tool argument (`takeover: true` on `cockpit_claim`), or all three?
- **Q6 — Bugfix vs. feature workflow labeling**: this changes MCP-tool surface (new tools + new refusal payload); does it ship under `workflow:speckit-feature` (current label) or split with `workflow:speckit-bugfix`? Bump level `minor` (new capability) vs. `patch` follows from this.
- **Q7 — MCP tool boundary**: single `cockpit_claim` with `{ acquire | takeover | release | heartbeat }` verbs vs. discrete tools (`cockpit_claim` / `cockpit_release` / `cockpit_heartbeat`)?
- **Q8 — Superseded-session detection cost**: verify claim on **every** driving dispatch (extra GitHub call per advance/queue/merge) or piggy-back on heartbeat refresh (bounded lag before superseded session notices)?

## Assumptions

- Every `/cockpit:auto` session already has a unique per-session identifier writable to GitHub (ledger slug + timestamp at minimum). If not, one is added.
- GitHub is a sufficient coordination substrate — no separate lock service is introduced. Rate limits on comment/label writes for heartbeat are tolerable at the chosen cadence.
- The auto skill's existing heartbeat cadence is coarse enough that a claim heartbeat piggy-backed on it does not spam GitHub.
- Concurrent observers against a live epic remain a first-class supported pattern and must not require any claim-side change.
- The per-scope event-bus refcount/sharing model in `event-bus-registry.ts` remains as-is — this spec adds a coordination layer above it, not a replacement.

## Out of Scope

- Parallelizing execution *across* sessions on the same scope (per-user worker lease cap is a separate orchestrator concern).
- Cross-session dedup of overlapping issue *sets* under different scopes — label collisions between issues shared across scopes are pre-existing and unchanged.
- Replacing the per-scope event-bus registry model or the ledger format.
- Enforcing the claim on non-driving dispatches (observer tools remain unaffected — FR-011).
- A generic distributed-lock service — the mechanism is GitHub-native and scope-issue-local by construction.
- Cross-repo scope claims — claim keying is `owner/repo#number` and does not need a cross-repo coordination model in this iteration.

---

*Generated by speckit*

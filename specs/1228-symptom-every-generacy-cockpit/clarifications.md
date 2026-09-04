# Clarifications: Scope cockpit doorbell gate-answer replay by epic ref set and persist consumed position

## Batch 1 — 2026-09-03

### Q1: Fresh-cursor degrade policy
**Context**: US4/FR-005 require that a missing or stale cursor against a pre-existing backlog file "degrade safely", but the policy is unresolved. The choice trades upgrade safety against losing legitimate answers: a brand-new epic starting on an existing cluster has a fresh cursor by definition, and skipping the whole file would drop any in-scope answers that arrived while no doorbell was running.
**Question**: When the cursor is missing or stale against a pre-existing answers file, what should the doorbell replay?
**Options**:
- A: Nothing — initialize the cursor at end-of-file; any unconsumed in-scope answers in the backlog are skipped.
- B: Replay from byte 0 but rely on the new epic-ref-set scoping to bound emission — in-scope answers are emitted regardless of age; only foreign-epic answers are dropped.
- C: Replay from byte 0 with scoping plus a recency window on `answeredAt` (e.g., only answers newer than N hours/days are emitted).

**Answer**: C — Replay from byte 0 with epic-ref-set scoping plus a recency window on `answeredAt` (24h default via `COCKPIT_ANSWERS_REPLAY_WINDOW_MS`, evaluated before the ref-set test, window drops logged at `info` like foreign drops). A silently converts every fresh-cursor start into operator re-asks because a restarted session depends on replay to consume gates answered while it was down, and B alone still emits every historical in-scope answer (~23 of 65 refs were in one epic's scope across 211 replayed lines on finetooth), each burning a `superseded` ack. The window also unifies the rotation and truncation branches, and `answeredAt` is already a validated ISO datetime on every line, so this is a clock compare with no new wire data.

### Q2: Cursor advancement semantics (emit vs. ack)
**Context**: The original #1023 spec said replay covers "lines not yet **acked**", but FR-004 speaks of the "consumed" position without defining consumption. If the cursor advances when a line is emitted, a session crash between emit and processing silently loses those answers (at-most-once). If it advances only after the session acks, a crash causes re-emission of already-processed answers (at-least-once), which the session currently handles via `superseded` acks.
**Question**: When should the persisted cursor advance — at emission time, or only after the auto session has acked the corresponding gate-answer?
**Options**:
- A: On emit (at-most-once) — simplest; a crash between emit and session processing loses those answers.
- B: On session ack (at-least-once) — no loss, but restarts may re-emit a small tail of already-processed answers.

**Answer**: A — Advance the persisted cursor on emit (at-most-once), defining emit as the point where the awaited `onEvent` resolves (stdout write callback fired plus bus emit), with the fsync debounced. There is no cluster-side ack signal the tailer can consume: `cockpit_gate_ack` forwards the outcome up-path to the cloud and writes nothing to the answers file or any local ledger, and the doorbell is a stdout-pipe child with no back-channel from the session, so option B would require designing a new ack feedback channel well outside this issue. The residual loss window is tiny and a lost answer is still recoverable because the cloud record stays answered and the escape hatch re-derives or re-asks after 3 sweeps.

### Q3: Ref-set freshness for late-created children
**Context**: FR-001 scopes answers by the epic's resolved ref set (epic + children) built via `buildRefSet`. Epics grow: children are created mid-run (e.g., by scope-add). If the doorbell's ref set is a snapshot from start-up, an answer for a newly created child would be dropped as foreign — and because the cursor advances past it, it would be permanently lost for this epic.
**Question**: Must the scope test account for children created after doorbell start (e.g., re-resolve the ref set on a miss or on scope-change events), or is a start-time snapshot acceptable?
**Options**:
- A: Start-time snapshot is acceptable — operators restart the doorbell after adding scope.
- B: Re-resolve the ref set before dropping an unknown ref (drop only if still foreign after refresh).
- C: Refresh the ref set on scope-change signals (e.g., cockpit scope-add), no per-miss re-resolution.

**Answer**: B — Re-resolve the ref set before dropping an unknown ref, dropping only if it is still foreign after the refresh, with miss-triggered refreshes throttled (min ~30s apart) and the tailer sharing one ref-set holder with the primary source so webhook and safety-net refreshes feed it too. With advance-on-emit (Q2) a wrong foreign drop is permanent, and the start-time snapshot is provably stale: `cockpit_scope_add` appends the child to the epic body and smee only learns via an epic issues webhook (500ms debounce) or a 10-minute safety-net timer, while poll-fallback mode resolves the epic once at startup with no webhook at all — so option C leaves a poll-mode doorbell blind for longer than the queue-to-clarify-gate-to-answer cycle. B is cheap because `resolveEpic` is a single `getIssue` plus body parse, misses are human-paced, and the Q1 recency window runs first so a fresh-cursor replay cannot fan out into hundreds of lookups.

### Q4: Cursor durability scope
**Context**: FR-004 requires the cursor to survive process restart, rotation, and truncation. The assumptions section leaves location open (`.generacy/cockpit/` suggested). Whether the cursor must also survive container/cluster recreation determines whether it belongs on the same persisted volume as the answers file or can live in more ephemeral storage.
**Question**: Must the persisted cursor survive cluster container recreation/upgrade (i.e., live on the same durable volume as the answers file), or is surviving process restarts within a container's lifetime sufficient (with recreation falling back to the Q1 degrade policy)?
**Options**:
- A: Same durability as the answers file — cursor and file live together; recreation does not trigger the degrade path.
- B: Process-restart durability is sufficient — container recreation intentionally falls back to the fresh-cursor degrade policy.

**Answer**: A — Give the cursor the same durability as the answers file so they live together and container recreation does not trigger the degrade path; suggested location `<answersDir>/cursors/<owner>__<repo>__<n>.json`, honoring the same `COCKPIT_ANSWERS_FILE`-derived directory, written with an atomic rename. The answers file sits on the `generacy-workspace` named volume that survives container rebuild, and recreation is routine on this stack (restarts re-run the entrypoint to refresh npm packages, and `generacy update` recreates on a new image digest), so under B every upgrade would re-enter the Q1 degrade path — precisely the flood US4/FR-005 exists to prevent. A cursor keyed on the file's ino plus byte offset is only meaningful next to the file it indexes, so storing it on a different lifetime would let it go stale independently.

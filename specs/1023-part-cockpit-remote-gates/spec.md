# Feature Specification: Cockpit doorbell — tail answers file → `gate-answer` events

**Branch**: `1023-part-cockpit-remote-gates` | **Date**: 2026-07-21 | **Status**: Draft
**Epic**: Cockpit Remote Gates (tracking issue in `generacy-ai/generacy-cloud`)
**Design doc**: [cockpit-remote-gates-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md)
**Phase**: P1, item 4 (cluster-side plumbing)

## Summary

The Cockpit Remote Gates epic moves `/cockpit:auto` human-gate answering out of the
driving Claude session and into a central operator inbox on generacy.ai. On the
answer path back to the cluster, the orchestrator appends each operator answer as a
JSON line to a shared **answers file**
(`/workspaces/.generacy/cockpit/answers.ndjson`).

This issue makes those file appends visible to the driving session on its two
existing wake paths:

1. **Doorbell stdout NDJSON stream** — watched by the harness `Monitor` tool.
2. **`cockpit_await_events` typed batches** — drained by the cockpit MCP server.

After this issue lands, an answer line appended by any writer (the orchestrator in
production; a test harness in unit tests) reaches both consumers as a
`{type: "gate-answer", ...}` event, with schema validation, restart replay of
unacked lines, and tolerance for the file not yet existing / being rotated /
being truncated.

## Context

- The doorbell (`packages/generacy/src/cli/commands/cockpit/doorbell/`) already
  runs alongside the smee.io SSE subscription and emits one NDJSON line per event
  on stdout. It uses the per-epic `EpicEventBus`
  (`packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts`) as its
  broadcast surface; `cockpit_await_events` drains the same bus.
- The **answers file writer** (orchestrator `POST /cockpit/answers` route) is a
  sibling issue in P1 — this spec assumes it exists but only reads what it
  writes. See §Assumptions for the wire contract this depends on.
- **The doorbell must never treat the answers file as authoritative for anything
  other than surfacing lines as events.** Applying answers to session state
  (label flips, comment posting, dispatch decisions) is `agency` scope (P4,
  auto.md D.12), not this issue.

## User Stories

### US1: Driving session sees an operator answer without polling

**As** a `/cockpit:auto` session running in a cluster (via the harness `Monitor`
tool watching doorbell stdout),
**I want** operator answers appended to the answers file to appear as
`gate-answer` NDJSON lines on doorbell stdout within seconds,
**So that** the D.12 gate-answer dispatch branch (agency P4) can wake and apply
the answer without polling GitHub or the cloud.

**Acceptance Criteria**:
- [ ] Appending a valid answer line to the answers file produces exactly one
  `{type: "gate-answer", ...}` line on doorbell stdout carrying the same
  `gateId`, `gateKey`, `optionId`, `freeText`, `actor`, `answeredAt`,
  `deliveryId` fields.
- [ ] End-to-end latency (append → stdout write) is bounded by the tail
  read cadence — no minute-scale polling.
- [ ] The stdout line survives round-tripping through `JSON.parse` and validates
  against the shared `GateAnswer` schema.

### US2: MCP tool caller sees the same events as typed batches

**As** an MCP client calling `cockpit_await_events`,
**I want** `gate-answer` entries returned as typed batch items alongside
`issue-transition` events,
**So that** callers that prefer the batched-cursor API (e.g. `/cockpit:auto`'s
event loop) see the same universe of events as the stdout stream, with the
existing cursor semantics unchanged.

**Acceptance Criteria**:
- [ ] A `gate-answer` event appended to the answers file appears in the next
  `cockpit_await_events` batch for the driving epic scope.
- [ ] The cursor advances past the `gate-answer` entry exactly like it does for
  `issue-transition` and other existing event kinds — no new reset/expiry
  classes introduced by this change.
- [ ] The event object is identical in shape to the stdout NDJSON line
  (`type: "gate-answer"` plus the payload fields).

### US3: Restart replays unacked answers

**As** a driving session whose doorbell subprocess was restarted (crash, cluster
takeover, or manual bounce) between the orchestrator appending an answer and the
session processing it,
**I want** the doorbell to replay answers that landed while it was down,
**So that** operator answers are never lost across restarts — the persistent
audit is the file itself, not doorbell process memory.

**Acceptance Criteria**:
- [ ] Given N lines already in the answers file at doorbell start, all N lines
  are re-emitted on both consumers (stdout + event-bus) before new appends
  begin.
- [ ] Replay is idempotent when the downstream session has already acked
  earlier `deliveryId`s in a previous run — this spec does not dedupe (that
  is auto.md scope), but repeated emission of the same `deliveryId` must not
  crash or reorder subsequent lines.
- [ ] Replay works whether the file existed at start (persisted from a prior
  run) or was created between doorbell start and first append.

### US4: Rotation / truncation does not lose or duplicate lines

**As** an operator whose long-running cluster hits the answers-file size cap and
the orchestrator rotates the file (rename + fresh empty file, or truncate in
place),
**I want** the doorbell to detect the rotation, continue tailing the new file,
and neither drop pending lines from the rotated-away file nor re-emit lines it
has already emitted from the pre-rotation portion of the current run,
**So that** long-running clusters survive rotation without operator intervention.

**Acceptance Criteria**:
- [ ] A rename-and-recreate rotation is detected within one poll/tick; the
  doorbell reopens the new file and emits any lines appended before reopen.
- [ ] An in-place truncate followed by a fresh append is detected; the
  doorbell resets its read position to 0 and emits the new line.
- [ ] No line emitted from the current file version is re-emitted after
  rotation (rotation-induced replay is bounded to the new file's contents).

### US5: Malformed lines are skipped, stream continues

**As** an operator debugging the system,
**I want** a malformed line in the answers file (invalid JSON, or valid JSON
that fails the `GateAnswer` schema) to be logged and skipped without stalling
subsequent lines,
**So that** a single bad line — from a bug in the writer, a partial write, or a
manual edit — does not silence the doorbell for that scope.

**Acceptance Criteria**:
- [ ] A line that is not valid JSON produces a `warn`-level log entry and is
  not dispatched to either consumer; the next valid line still reaches both.
- [ ] A line that is valid JSON but fails `GateAnswerSchema.safeParse` produces
  a `warn`-level log entry (with the `gateId` if present) and is not
  dispatched; the next valid line still reaches both.
- [ ] The log entry names the answers file path and the byte offset (or line
  number) of the skipped line so an operator can locate it.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | New doorbell submodule (working name `answers-tail.ts` under `doorbell/`) tails the answers file at `/workspaces/.generacy/cockpit/answers.ndjson` (path configurable via env var, default per design doc). | P1 | Path constant lives beside the tailer; env override name is a planning-phase decision. |
| FR-002 | The tailer handles the file-does-not-yet-exist case: it starts, waits for creation, then begins reading from offset 0. No error / no crash on startup with a missing file. | P1 | The orchestrator route creates the file lazily on first append. |
| FR-003 | On start, the tailer reads the entire existing file from offset 0 and emits every valid line before entering the polling / watch loop for new appends. | P1 | Satisfies US3 (restart replay). Position is not persisted across doorbell runs; the file itself is the durable record. |
| FR-004 | Each line is validated against the shared `GateAnswer` zod schema (from the P1 contracts issue). Lines that fail JSON parse OR schema validation are logged at `warn` and skipped; the stream continues with the next line. | P1 | Log message includes file path + line/offset + `gateId` (if extractable). |
| FR-005 | Each validated line is written to stdout as a single NDJSON line of the form `{type: "gate-answer", gateId, gateKey, optionId, freeText, actor, answeredAt, deliveryId}\n` — one line, one flush, ordered by file order. | P1 | Reuses the stdout-writing pattern in `subscribe.ts`. |
| FR-006 | Each validated line is also emitted into the epic's `EpicEventBus` (via `bus.emit(...)`) as a `CockpitStreamEvent` with `type: "gate-answer"`, so `cockpit_await_events` returns it in the next batch. | P1 | Requires extending `CockpitStreamEventSchema` (or its member union) to include the `gate-answer` variant. |
| FR-007 | The tailer detects file rotation (inode change on rename-and-recreate) and continues tailing the new file from offset 0. | P1 | Detection may use `fs.watch`, `stat`+inode comparison on tick, or the underlying tail library — implementation choice deferred to planning. |
| FR-008 | The tailer detects in-place truncation (size shrinks below current read position) and resets its read position to 0 for the current file. | P1 | Same detection tick as FR-007. |
| FR-009 | The tailer runs concurrently with the existing smee-source subscription in the doorbell process — neither blocks nor starves the other. | P1 | Both feed the same event bus / stdout writer. |
| FR-010 | Lines are emitted in file order (append order). Ordering across the smee source and the answers-file tail follows the existing bus-emit interleaving (no cross-source ordering guarantee beyond monotonic cursor). | P1 | Consistent with how `PhaseComplete` / `EpicComplete` events interleave today. |
| FR-011 | Partial trailing lines (bytes after the last `\n`) are held in a buffer and re-parsed once the line terminator arrives; a partial line at end-of-file is not dispatched. | P1 | Prevents split-write races between the orchestrator's write and the tailer's read. |
| FR-012 | The tailer exposes a stop/cleanup path (function returned from setup, or an `AbortSignal`) so doorbell shutdown fully releases file handles and watchers. | P2 | Matches the `SubscribeUnsubscribe` pattern in `subscribe.ts`. |
| FR-013 | The `GateAnswer` schema and the shared TypeScript `CockpitStreamEvent` gate-answer variant come from the P1 contracts module (planning-phase decision on exact import path — sibling issue: `packages/cockpit/src/gates/`). If that module has not landed when this issue starts, a temporary in-file schema copy is acceptable as long as it is a byte-for-byte match of the design doc's answer contract and is deleted by the integration issue (P1 item 5). | P1 | Cross-issue coordination note. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Round-trip visibility: an answer line appended by a test harness reaches doorbell stdout. | 100% of valid lines emitted; end-to-end latency ≤ 2s in the integration test. | Integration test appends a line, waits on stdout / event bus, asserts equivalence. |
| SC-002 | Round-trip visibility: same line reaches `cockpit_await_events`. | 100% of valid lines returned in the next batch. | Same integration test drains a batch via the bus and asserts one `gate-answer` entry. |
| SC-003 | Restart replay: N pre-existing lines are re-emitted on doorbell start. | All N lines on both consumers, in file order, before any post-start append. | Unit test seeds the file with N lines, starts the tailer, asserts stdout receives N lines before test appends one more. |
| SC-004 | Rotation survival: rename-and-recreate loses zero valid post-rotation lines. | Zero drops across a rotation cycle in the rotation test. | Test writes lines A/B, renames the file, writes lines C/D to the fresh file, asserts C/D on stdout. |
| SC-005 | Truncation survival: in-place truncate loses zero valid post-truncate lines. | Zero drops across a truncate cycle. | Test writes lines A/B, truncates to 0, writes line C, asserts C on stdout. |
| SC-006 | Malformed-line resilience: a bad line does not stop the stream. | Given lines [valid, malformed, valid], both valid lines emit; malformed logged at `warn`. | Unit test with mixed lines; assertions on stdout content and on the log sink. |
| SC-007 | No cursor-semantics regression for `cockpit_await_events`. | Existing `cockpit_await_events` test suite passes unchanged; new `gate-answer` variant does not alter cursor / expiry / reset classification. | Run existing event-bus test suite; add a mixed-event test that interleaves `issue-transition` and `gate-answer`. |

## Assumptions

- **Answers-file path** is `/workspaces/.generacy/cockpit/answers.ndjson` (per
  design doc §Architecture and §Component changes). If a sibling P1 issue
  changes this, this spec adopts the new path.
- **Line format** matches the design doc's Answer contract exactly:
  `{type: "gate-answer", gateId, gateKey, optionId, freeText, actor: {userId, email, displayName}, answeredAt, deliveryId}`. `optionId` may be
  `null` for pure free-text answers; `freeText` may be absent for pure option
  answers.
- **`GateAnswer` zod schema** is provided by the contracts issue
  (`packages/cockpit/src/gates/`, P1 item 1). This spec depends on that schema
  but does not define it — deviations must go through the epic per the "propose
  contract changes on the epic before diverging" rule.
- **Writer atomicity**: the orchestrator appends complete `\n`-terminated lines
  in a single `write` (or an `O_APPEND`-atomic equivalent). This spec does not
  attempt to reassemble half-lines across concurrent writers — one writer, one
  line, one atomic append.
- **The doorbell process owns both feeds**: the same process that runs the smee
  subscription runs the answers-file tailer. Cross-process replay is out of
  scope; a restarted doorbell re-reads the file (US3), which is the durable
  record.
- **Position is not persisted**. `deliveryId`-based deduplication is a
  consumer-side concern (auto.md D.12, P4). Restart replay in this issue is
  "re-read the whole file"; long-run cost is bounded by the orchestrator's
  rotation policy (sibling issue).
- **Rotation policy** (size cap and rename vs. truncate strategy) is the
  orchestrator's decision (sibling issue). This spec tolerates both idioms.
- **No secrets** land in the answers file — only operator-authored answer
  content (per design doc §Security). This spec's malformed-line logging is
  free to include full raw line bytes at `warn` level for debuggability.

## Out of Scope

- Writing the answers file. The orchestrator `POST /cockpit/answers` route is a
  sibling P1 issue.
- Applying answers to session state (label flips, comment posting, dispatch
  decisions, supersession checks). That is auto.md scope in agency (P4, D.12
  `gate-answer` dispatch branch).
- The up-path (`cockpit_gate_open`, `cockpit_gate_ack`, `cluster.cockpit`
  relay events). Sibling P1 issues.
- The gate wire contracts themselves (schemas, `gateId` derivation, generation
  rules). Sibling P1 issue (`packages/cockpit/src/gates/`).
- Cloud-side inbox, SSE, Firestore collection, UI. P2 and P3 in the epic.
- `deliveryId`-based deduplication across restarts. Consumer concern (P4).
- Backpressure / rate limiting on a pathologically fast writer. Design doc
  implies rotation as the pressure valve; if the tailer needs bounded
  in-memory buffering, that is a planning-phase decision.

---

*Generated by speckit; enhanced from issue #1023 and the epic design doc.*

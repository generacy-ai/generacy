# Feature Specification: Scope cockpit doorbell gate-answer replay by epic ref set and persist consumed position

**Branch**: `1228-symptom-every-generacy-cockpit` | **Date**: 2026-09-03 | **Status**: Draft
**Issue**: [generacy#1228](https://github.com/generacy-ai/generacy/issues/1228) | **Subsumes**: generacy#1111

## Summary

Every `generacy cockpit doorbell` arm-up re-emits the **entire historical gate-answer
backlog** as fresh `gate-answer` events, and the backlog it replays is scoped to the
**repo**, not to the bound epic. On the finetooth cluster a single doorbell start emitted
211 answers dating back to 2026-08-12, 42 of whose 65 distinct issue refs belonged to
*other* epics in the same repo.

This has two operator-visible consequences:

1. A restarted `/cockpit:auto` session is flooded with hundreds of stale `gate-answer`
   events. Per `auto.md` D.12 step 1, each event with no matching `openGates` record is
   acked `superseded` — so the run burns hundreds of tool calls and terminates cloud gate
   records that were never its business.
2. **Two epics in the same repo, driven from separate conversations, see each other's
   answers.** Observed in production ledgers (`Painworth/doc-intel` runs 93 and 94,
   2026-09-02): run 93's ledger carries rows for `#108`, `#109`, `#110` (run 94's scope)
   plus `#1`, `#5`, `#6`, `#7`, `#8` (August epics, acked `superseded (no record)`).

The fix is entirely cluster-side (the cloud already dedups on `deliveryId` and the live
file held zero duplicate `deliveryId`s). It has two independent halves: **scope answers by
the bound epic's resolved ref set** (not by a repo-string comparison), and **persist the
consumed byte position** per epic scope so a restart replays only lines appended since the
last consumed byte.

## Root cause

`packages/generacy/src/cli/commands/cockpit/doorbell/answers-file-source.ts`:

- **`doReplay()`** re-reads from byte 0 on first file discovery (and on
  rotation/truncation), bounded only by `DEFAULT_REPLAY_LINE_CAP = 10_000`. Position is
  tracked in-process only, so every process start is a full replay. The original spec
  (`specs/1023-part-cockpit-remote-gates/spec.md` and its contract) called for "replay of
  lines **not yet acked** on doorbell start" — the ack/consumed-position half was never
  implemented. Nothing downstream dedups: the contract delegates dedup to "the session",
  and `auto.md` invariant #7 forbids the session from filtering the stream.
- **`processLine()` step (c)** compares only `owner`/`repo` parsed out of the answer's
  `gateKey` against the bound `epicRef`. Same-repo foreign-epic answers pass; genuinely
  cross-repo child answers of a cross-repo epic are dropped (the `KNOWN LIMITATION` comment
  in the file). This is generacy#1111.

The append-only file never rotates in practice (`COCKPIT_ANSWERS_ROTATION_BYTES` defaults
to 32 MB; finetooth's file was 127 KB after three weeks), so replay volume grows
monotonically for the life of the cluster.

## User Stories

### US1: Restarted auto session is not flooded with stale answers

**As an** operator restarting a `/cockpit:auto` session for a long-lived epic,
**I want** the doorbell to replay only answers I have not already consumed,
**So that** the run does not burn hundreds of tool calls acking `superseded` gates and
does not terminate cloud gate records belonging to other epics.

**Acceptance Criteria**:
- [ ] A doorbell start against a pre-existing 300+ line answers file for epic
      `owner/repo#N` emits only in-scope, not-yet-consumed lines.
- [ ] A doorbell start against a fully-consumed file emits zero events.
- [ ] Restarting the doorbell does not re-emit anything already consumed.

### US2: Epics in the same repo do not see each other's answers

**As an** operator running two epics in the same repo from separate conversations,
**I want** each doorbell to emit only answers whose issue-ref belongs to its bound epic's
resolved ref set,
**So that** the two runs never cross-contaminate each other's gate ledgers.

**Acceptance Criteria**:
- [ ] An answer for a sibling epic in the same repo is dropped and logged at `info` with
      the `gateId`, not emitted.
- [ ] An answer whose issue-ref is a member of the bound epic's ref set (epic itself or a
      child) is emitted.

### US3: Cross-repo epic children are no longer lost (subsumes generacy#1111)

**As an** operator running a cross-repo epic,
**I want** answers for child issues in a different repo than the epic to be emitted,
**So that** cross-repo epics stop silently losing their children's answers.

**Acceptance Criteria**:
- [ ] An answer for a child issue in a different repo than the epic IS emitted.
- [ ] generacy#1111 is linked and closed as part of this work.

### US4: Existing backlog files do not replay on first cursor

**As an** operator upgrading an existing cluster that already carries a large backlog file,
**I want** a fresh cursor against a pre-existing file to not replay the backlog,
**So that** the upgrade does not itself trigger the flood this fixes.

**Acceptance Criteria**:
- [ ] A fresh (missing/stale) cursor against a pre-existing file replays from byte 0 but
      emits only answers that pass both the epic-ref-set scope test and an `answeredAt`
      recency window (default 24h, configurable via `COCKPIT_ANSWERS_REPLAY_WINDOW_MS`).
- [ ] Answers dropped by the recency window are logged at `info`, like foreign-epic drops.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Scope each answer by testing whether its `gateKey` issue-ref is a member of the bound epic's resolved ref set (epic + children), using the same ref-set construction as `SmeeDoorbellSource`/`buildRefSet`. | P1 | Replaces `processLine()` step (c) owner/repo string compare. |
| FR-002 | Drop foreign-epic answers (same repo or cross repo) and log them at `info` with the `gateId`. Before dropping an unknown ref, re-resolve the ref set and drop only if still foreign; miss-triggered refreshes are throttled (min ~30s apart), and the tailer shares one ref-set holder with the primary source so webhook and safety-net refreshes feed it too. | P1 | Late-created children (e.g., scope-add) must not be permanently lost — advance-on-emit makes a wrong drop unrecoverable. |
| FR-003 | Emit answers whose issue-ref is in scope, including child issues in a different repo than the epic (cross-repo epic). | P1 | Subsumes generacy#1111. |
| FR-004 | Persist the consumed position (ino + byte offset) per epic scope so replay resumes from the last consumed byte across process restart, rotation, and truncation. The cursor advances on emit (at-most-once), where emit means the awaited `onEvent` resolves (stdout write callback fired plus bus emit); fsync is debounced. | P1 | The ack/consumed-position half never implemented in #1023. No cluster-side ack signal exists for the tailer; a lost answer remains recoverable via the cloud record and the escape hatch (re-derive/re-ask after 3 sweeps). |
| FR-005 | On a missing or stale cursor, replay from byte 0 bounded by epic-ref-set scoping plus an `answeredAt` recency window (default 24h, `COCKPIT_ANSWERS_REPLAY_WINDOW_MS`), evaluated before the ref-set test; window drops logged at `info`. The same window bounds the rotation and truncation replay branches. | P1 | Settled in clarify Q1 (see US4). |
| FR-006 | Preserve existing rotation and truncation behaviour per the current state table, now driven by the persisted cursor rather than in-process position. | P1 | |
| FR-007 | Update the contract (`specs/1023-part-cockpit-remote-gates/contracts/answers-file-source.md`) and doorbell docs to match. | P2 | |
| FR-008 | Unit tests cover: fresh-cursor, resumed-cursor, rotation, truncation, same-repo-foreign-epic drop, cross-repo in-scope emit, recency-window drop on fresh cursor, and ref-set re-resolution before dropping an unknown ref (late-created child emitted after refresh). | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Events emitted on doorbell start against a fully-consumed pre-existing file | 0 | Run doorbell against a consumed 300+ line file; count emitted `gate-answer` events. |
| SC-002 | Events re-emitted on doorbell restart after consuming | 0 | Consume, restart, count. |
| SC-003 | Same-repo foreign-epic answers emitted | 0 | Feed a sibling-epic answer; assert dropped + logged. |
| SC-004 | Cross-repo in-scope child answers emitted | 100% | Feed a cross-repo child answer; assert emitted. |
| SC-005 | Reproduction figures from the issue eliminated | 0 out-of-scope emits | Re-run the finetooth reproduction (211 emitted / 42 out-of-scope) against the fix. |

## Assumptions

- The bound epic's resolved ref set is available to `AnswersFileSource` the same way it is
  to `SmeeDoorbellSource` (`buildRefSet`), or can be supplied through the same construction
  path.
- The cursor has the same durability as the answers file: it lives alongside it in the
  `COCKPIT_ANSWERS_FILE`-derived directory (suggested
  `<answersDir>/cursors/<owner>__<repo>__<n>.json`), written with an atomic rename, on the
  `generacy-workspace` named volume — so container recreation/upgrade does not trigger the
  fresh-cursor degrade path (settled in clarify Q4).
- Cloud-side behaviour is unchanged (`POST /cockpit/answers` already dedups on
  `deliveryId`).

## Out of Scope

- Cloud-side gate/answer delivery or dedup changes.
- Changing `auto.md` invariant #7 (session must not filter the stream) — the fix stays in
  the doorbell source.
- Rotation-byte threshold tuning (`COCKPIT_ANSWERS_ROTATION_BYTES`).

---

*Generated by speckit*

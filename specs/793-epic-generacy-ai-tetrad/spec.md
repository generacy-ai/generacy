# Feature Specification: Journal-based stuck detection (G5.2)

**Branch**: `793-epic-generacy-ai-tetrad` | **Date**: 2026-06-29 | **Status**: Draft

**Epic**: generacy-ai/tetrad-development#85 — Epic Cockpit
**Phase / Tier / Issue**: P5 / v3-polish / G5.2
**Source issue**: generacy-ai/generacy#793 (`[cockpit] Journal-based stuck detection`)
**Depends on**: G0.1 (#786 — cockpit engine foundation), G1.1 (#787 — cockpit watch + status verbs)

## Summary

A workflow worker that crashes, hangs on a stuck tool call, or silently stalls keeps its `agent:in-progress` label — so from the cockpit's perspective the issue still looks alive. Operators only catch it by noticing the timer on `cockpit status` "feels too long," which is exactly the failure mode the cockpit is supposed to remove.

This feature adds a second liveness signal: the worker's own JSONL journal. Every active worker appends entries to `.agency/conversations/{n}/journal.jsonl`. If an issue is labelled `agent:in-progress` but its journal has had no new entry for more than a configurable threshold (default 15 minutes), the cockpit flags it as **stuck**. The flag surfaces in both `generacy cockpit status` (as a column / badge on the relevant row) and `generacy cockpit watch` (as a synthetic NDJSON event).

The flag is advisory — the cockpit performs no mutations and applies no labels. Operators decide what to do.

Scope (per issue): `packages/cockpit/src/journal.ts` plus the wiring into status and watch. No new GitHub state, no schema migrations, no orchestrator changes.

## User Stories

### US1 — Operator detects a hung worker without staring at the clock (Priority: P1)

**As an** operator running `generacy cockpit status` on an active epic,
**I want** issues whose worker has gone silent to be visually distinct from issues whose worker is making progress,
**So that** I can intervene (kill the worker, re-dispatch, comment for help) without watching the dashboard for a half-hour to notice nothing has changed.

**Acceptance Criteria**:
- [ ] An issue with `agent:in-progress` and a journal entry < threshold old appears with no stuck flag.
- [ ] An issue with `agent:in-progress` and no journal entry in the last `threshold` minutes appears with a stuck flag in the status output.
- [ ] An issue with `agent:in-progress` and **no journal file at all** is treated according to the missing-journal policy (see FR-006).
- [ ] An issue without `agent:in-progress` is never flagged stuck, regardless of journal age.
- [ ] The `--json` output of `cockpit status` includes a boolean `stuck` field (and the `stuckReason` / `lastJournalAt` fields described in FR-005) on every row.

### US2 — Operator gets a push event when a worker goes silent (Priority: P1)

**As an** operator running `generacy cockpit watch` in a Monitor pane,
**I want** a stream event the moment an in-progress issue crosses the staleness threshold,
**So that** I am notified without having to re-run `status` on a cadence.

**Acceptance Criteria**:
- [ ] When an issue transitions from "fresh journal" to "stale journal" while still `agent:in-progress`, `watch` emits exactly one NDJSON event recording the transition.
- [ ] When the worker resumes (journal appended) before any label change, `watch` emits exactly one NDJSON event recording the recovery.
- [ ] When the issue leaves `agent:in-progress` (any label change), no further stuck-related event fires for that issue until it returns to `agent:in-progress`.
- [ ] The event passes Zod validation and is a strict extension of (or distinct from) the existing `CockpitEvent` schema — no other consumers break.

### US3 — Operator tunes the staleness threshold per repo (Priority: P2)

**As an** operator,
**I want** to configure the staleness threshold (and on/off switch) in `.generacy/config.yaml`,
**So that** repos with slow tool calls (long test runs, builds) don't false-flag while repos with fast iterations get prompt alerts.

**Acceptance Criteria**:
- [ ] A `cockpit.stuckDetection.thresholdMinutes` value in `.generacy/config.yaml` overrides the default.
- [ ] A `cockpit.stuckDetection.enabled: false` disables the feature; status and watch behave as they did before this feature was added.
- [ ] Default threshold is 15 minutes when nothing is configured (see Assumptions).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Provide a function that, given an issue number (and optionally a workspace root), returns the timestamp of the last entry in `.agency/conversations/{n}/journal.jsonl`, or `null` if the file does not exist. | P1 | Lives in `packages/cockpit/src/journal.ts`. Reads the **last line** of the JSONL file efficiently — see Assumptions for the I/O strategy. |
| FR-002 | Parse the last journal line as JSON, read the `timestamp` field, and return it as an ISO-8601 string. Tolerate truncated last lines (incomplete trailing write) by skipping to the previous complete line. | P1 | The JournalEntry shape already defines `timestamp` (see `packages/orchestrator/src/worker/types.ts`). |
| FR-003 | Provide a pure function `isStuck({ isInProgress, lastJournalAt, now, thresholdMs })` → `boolean` that returns `true` iff `isInProgress` is true and `(now − lastJournalAt) > thresholdMs`. If `lastJournalAt` is null and `isInProgress` is true, behave according to FR-006. | P1 | Pure / no I/O for testability. |
| FR-004 | The `cockpit status` command attaches `stuck` (boolean), `lastJournalAt` (ISO string or null), and `stuckReason` (one of `'stale'`, `'no-journal'`, `null`) to every `StatusRow` it builds. The status renderer surfaces stuck rows visually (e.g. a `⚠ stuck Nm` badge or column). The `--json` envelope round-trips these fields verbatim. | P1 | Extends `StatusRow` in `packages/generacy/src/cli/commands/cockpit/status/row.ts`. Color renderer should respect `--no-color` / non-TTY. |
| FR-005 | The `cockpit watch` command emits a `stuck` event on the transition from non-stuck → stuck and a `recovered` event on the transition from stuck → not-stuck-but-still-in-progress. The event schema (Zod) is added alongside existing `CockpitEvent` so consumers continue to validate cleanly. | P1 | Reuses watch's existing diff/poll loop; per-issue stuck state must be carried across poll iterations like label state already is. |
| FR-006 | Define and document the missing-journal policy. The default behavior is: **do not flag** a missing-journal issue as stuck — there are legitimate cases (queued / just-dispatched workers that have not written their first entry yet). The system MAY flag missing-journal as stuck after a separate `gracePeriodMinutes` (default = `thresholdMinutes`). | P1 | The exact rule is a clarification target — see Open Questions. |
| FR-007 | Configuration block in `.generacy/config.yaml` under `cockpit.stuckDetection`: `enabled` (default `true`), `thresholdMinutes` (default `15`), `gracePeriodMinutes` (default = `thresholdMinutes`), `journalRoot` (default `.agency/conversations`). Validated via the existing cockpit config Zod schema. | P1 | New keys; backwards-compatible (all optional). |
| FR-008 | Journal I/O failures (permission denied, file locked, malformed JSON on every line) MUST NOT crash status or watch. They are reported as `stuckReason: 'no-journal'` (or a future `'journal-error'` reason — see Open Questions) and structured-logged to stderr at most once per issue per poll cycle. | P1 | Hard reliability requirement — cockpit is a read-only sensor; it cannot regress that property. |
| FR-009 | Stuck detection MUST NOT make any GitHub API calls of its own. It uses only the labels already retrieved by status / watch for classification, and the local filesystem for journal timestamps. | P1 | Preserves the rate-limit budget that watch is careful about. |
| FR-010 | All paths to `.agency/conversations/{n}/journal.jsonl` MUST resolve relative to the configured workspace root (default: `process.cwd()`), MUST refuse to traverse outside it, and MUST treat `n` as `Number.isInteger(n) && n > 0` (no symlinks, no `..`). | P1 | Defense-in-depth — the journal-root config value is operator-controlled and the issue number comes from GitHub. |
| FR-011 | The journal module exposes only the public API needed by status and watch from `packages/cockpit/src/index.ts`. Internal helpers (line-reading, parsing, path-resolving) are not re-exported. | P2 | Matches the existing cockpit export discipline (`index.ts` is the curated surface). |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | A worker that exits abnormally without removing its `agent:in-progress` label is flagged stuck. | Within `thresholdMinutes + one watch poll interval` of the worker going silent. | Integration test: write a synthetic journal that stops at `now − 16min`, run `cockpit status`, assert `stuck: true`. |
| SC-002 | A worker that is making progress (journal updated every few minutes) is never flagged stuck. | 0 false positives across 1000 consecutive poll cycles in CI. | Property test in `__tests__/journal.test.ts`. |
| SC-003 | Stuck detection adds < 5 ms median per issue to `cockpit status` runtime. | Measured on 200 issues with realistic journal sizes. | Microbench in tests; report stays informational, no hard CI gate. |
| SC-004 | Status and watch never crash on malformed / missing / permission-denied journal files. | 0 crashes across the test suite's fault-injection cases. | Vitest cases that mock fs to return ENOENT, EACCES, and truncated JSON. |
| SC-005 | Configuration is end-to-end. | `cockpit.stuckDetection.thresholdMinutes: 1` in config + a journal 65 s old + `agent:in-progress` ⇒ flagged stuck. Disabling via `enabled: false` ⇒ never flagged. | Integration test. |
| SC-006 | Watch never emits more than one stuck event per stuck→fresh→stuck cycle without an intervening label change. | 1 event per state transition, deduplicated across poll iterations. | Test in `__tests__/watch.stuck.test.ts`. |

## Open Questions / Clarification Targets

These are flagged for `/speckit:clarify`. Sensible defaults are listed inline so an implementor can proceed if the operator does not weigh in.

1. **Missing-journal policy precise rule.** Three candidates:
   (a) Never flag a missing-journal issue (most conservative — feature exists only to catch *crashes mid-flight*).
   (b) Flag missing-journal only after `gracePeriodMinutes` since the issue gained `agent:in-progress` *and* no file appears (requires tracking label-acquisition time in watch).
   (c) Flag missing-journal as `'no-journal'` immediately on first observation.
   **Proposed default: (a).** It costs nothing in false positives. The cost is missing a class of stuck workers that crashed before writing any journal entry — but those are visible through other signals (no PR, no commits, log absence).

2. **Recovery semantics.** When does a stuck issue stop being stuck?
   (a) The journal's last entry timestamp moves forward (worker resumed and wrote something).
   (b) The label leaves `agent:in-progress`.
   Both (a) and (b) end the stuck state; the question is *which* event fires from watch.
   **Proposed default**: emit a `recovered` event for (a); for (b), the existing `label-change` event already covers it — don't double-fire.

3. **Journal file location authority.** The orchestrator's `ConversationLogger` currently writes to `specs/{issue-number}/conversation-log.jsonl`, while this issue specifies `.agency/conversations/{n}/journal.jsonl`. Which is canonical for cockpit's purposes?
   **Proposed default**: cockpit reads from the path in the issue (`.agency/conversations/{n}/journal.jsonl`). The orchestrator side is expected to converge — but this is a cross-package coordination point and should be confirmed in `/speckit:plan`. If the orchestrator location stays as-is, the journal module needs a configurable list of candidate paths or the orchestrator needs an additional write target.

4. **Stuck reason taxonomy.** Should `'journal-error'` (file unreadable / corrupt) be a distinct `stuckReason` from `'no-journal'`?
   **Proposed default**: keep two values — `'stale'` and `'no-journal'` — and fold "unreadable" into `'no-journal'`. Operators only care that the cockpit has no liveness signal; the cause is in the stderr log line.

5. **CLI override.** Should `cockpit status` and `cockpit watch` accept a `--stuck-threshold <minutes>` flag, or is config-only enough?
   **Proposed default**: config-only for the first cut. CLI flag is cheap to add later if operators ask for it.

## Assumptions

- Journal files are append-only, with each entry on its own line, terminated by `\n`. The orchestrator's `ConversationLogger` already enforces this (`appendFile` + JSONL).
- The last journal line is reliably the newest entry. The journal does not get rewritten or reordered after the fact.
- "Read the last line" can be implemented as a small `read()` from the end of the file (e.g. last 64 KB), scanning backward for `\n`, parsing the trailing complete JSON object. We don't need to load the whole file. Implementations may start with `readFile` + `split('\n')` and optimize later if SC-003 fails.
- Time source is `Date.now()` (UTC ms). Journal timestamps are ISO-8601 strings parseable by `Date.parse`.
- Workspace root for resolving `.agency/conversations/...` is `process.cwd()` unless overridden. Cockpit commands already run from the repo root; we do not need a new resolver.
- Default staleness threshold of **15 minutes** is chosen as a balance: long enough to ride out a slow `gh search` or `npm install`, short enough that an operator gets feedback within a coffee break. Threshold is configurable per FR-007.
- The default `gracePeriodMinutes` mirrors `thresholdMinutes` — operators rarely want to think about them separately.
- Tier `v3-polish` per the issue body means: this feature lands after the foundation, manifest, and core watch/status are stable; it does not block any other phase.

## Out of Scope

- **Automatic remediation.** No labels are added or removed; no comments are posted; no workers are killed. The cockpit remains a pure sensor (consistent with G1.1's acceptance criterion that `watch` performs zero mutations).
- **Orchestrator-side journal changes.** The orchestrator's logger and journal location are not modified here — only consumed. If Open Question #3 reveals a path mismatch, the resolution lives in a different issue.
- **PR-level stuck detection.** Only `agent:in-progress` issues are considered. PRs with their own workers (if any exist) are tracked through their parent issue.
- **Cross-cluster journal aggregation.** Stuck detection runs on the local filesystem of the machine running the cockpit. Workers running in a remote cluster are out of scope until a "remote journal" feature exists.
- **Historical stuck reporting.** No persistent record of past stuck events is kept by this feature. Watch emits events to stdout for the Monitor tool; downstream tooling decides whether to persist them.
- **Auto-tuned thresholds.** No learning of "this issue's normal cadence" — the threshold is global per repo.

## Non-Functional Requirements

- **Reliability**: All journal I/O is wrapped in try/catch. The journal subsystem can fail in any way without taking down `status` or `watch` (FR-008).
- **Performance**: Journal lookup MUST be O(1) in journal file size — i.e. read a bounded tail, not the whole file (SC-003).
- **Security**: Path resolution refuses traversal outside the workspace root (FR-010).
- **Testability**: The stuck-decision function (FR-003) is pure. The I/O function (FR-001) is the only impure surface; it accepts an `fs`-like dependency so tests can inject mocks.
- **Cross-cutting**: Adheres to existing cockpit conventions — Zod for new schemas, public API only via `packages/cockpit/src/index.ts`, vitest for tests, no new runtime deps unless justified.

---

*Generated by speckit*

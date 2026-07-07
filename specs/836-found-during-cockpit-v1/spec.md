# Feature Specification: `cockpit watch` must survive its own poll interval

**Branch**: `836-found-during-cockpit-v1` | **Date**: 2026-07-07 | **Status**: Draft | **Issue**: [#836](https://github.com/generacy-ai/generacy/issues/836)

## Summary

`generacy cockpit watch <epic-ref>` (and the `/cockpit:watch` skill wrapping it) is supposed to run continuously, poll GitHub every `--interval` ms (default 30 000), and print one NDJSON transition line per state change. Instead, it prints the startup line, runs the first poll, and exits 0 within seconds — never surviving even one interval.

Root cause is a single line in `packages/generacy/src/cli/commands/cockpit/watch.ts` at the `sleep()` helper (lines ~48–61): after `setTimeout(...)` the code calls `timer.unref?.()`. An unref'd timer does not keep Node's event loop alive. Once the first poll's async I/O settles and the loop `await`s the 30 s sleep, no referenced handle remains, the event loop drains, and the process exits 0 mid-sleep. The watcher's core contract — "stay alive and poll" — is defeated by its own timer.

Unit tests never caught it because they always inject `deps.abortSignal` for deterministic termination, so no test relies on a real un-aborted sleep keeping the process alive. This is the same class of miss as issues #800 and #826: the tests encode the code's assumptions rather than the runtime's behavior.

Downstream impact: `/cockpit:watch` is unusable end-to-end. A restart-wrapper around it cannot recover the behavior either, because each restart loses the baseline `SnapshotMap` used to diff transitions — restarted watchers see every issue as unchanged. The documented interim workaround is to poll `generacy cockpit status <epic-ref>` on a shell timer.

## User Stories

### US1: Operator watches an epic to completion

**As a** cockpit operator (human or the `/cockpit:watch` skill),
**I want** `generacy cockpit watch <epic-ref>` to keep running until I stop it (SIGINT/SIGTERM, `--abort`, or process kill),
**So that** I can rely on it to emit an NDJSON transition line whenever any issue or PR in the epic changes state, without wrapping it in a restart loop that would lose the transition baseline.

**Acceptance Criteria**:
- [ ] Given a valid epic ref and a normal environment, when I run `generacy cockpit watch <epic-ref>` with no `--abort`, the process stays alive past the first poll interval (empirically verified for at least 2 intervals at a short test interval).
- [ ] When a watched issue or PR transitions state between polls, the process emits exactly one NDJSON line describing the transition and does not exit.
- [ ] When I send SIGINT or SIGTERM, the process exits 0 within one interval.

### US2: CI/CD regression protection

**As a** contributor changing `watch.ts`,
**I want** an automated test that fails if the poll loop ever again "exits 0 during sleep,"
**So that** this bug class cannot regress silently.

**Acceptance Criteria**:
- [ ] A test in the generacy repo exercises the real `runWatch` loop (or the compiled CLI binary) with a short real interval and no injected `abortSignal`, and asserts the process/loop is still running after > 1 interval has elapsed.
- [ ] The test fails on the current (pre-fix) code and passes on the fixed code.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The poll-loop `sleep()` in `packages/generacy/src/cli/commands/cockpit/watch.ts` must not call `timer.unref()` on the timer used between polls when invoked from the CLI entry point. | P1 | The abort listener wired to SIGINT/SIGTERM/`deps.abortSignal` already guarantees prompt shutdown; the `unref` is not needed for clean exit. |
| FR-002 | If a non-CLI embedder ever needs an unref'd timer (so its own event loop can exit early), that behavior must be gated behind an explicit `WatchDeps` flag that the CLI entry point does not set. | P2 | Precaution — no current embedder is known. Default = referenced timer. |
| FR-003 | The watcher must continue to exit promptly (within one interval) on SIGINT, SIGTERM, or external `abortSignal` fire. | P1 | Must not regress the shutdown path. |
| FR-004 | A regression test must run the real un-aborted loop (short interval, e.g. 200 ms via `intervalOverride`) and assert the loop performs ≥ 2 poll ticks. | P1 | Uses `deps.onTick` counter or process-alive check. Must not depend on `deps.abortSignal` to keep the process alive. |
| FR-005 | No user-visible behavior change beyond "the watcher no longer exits prematurely": interval, NDJSON output shape, exit codes, log lines are unchanged. | P1 | Pure bugfix. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `timeout 75 generacy cockpit watch <valid-epic-ref> </dev/null` (default 30 s interval) survives past the first poll. | Process is killed by `timeout` (exit 124) rather than exiting 0 on its own within seconds. | Manual repro from the bug report; run pre- and post-fix. |
| SC-002 | Regression test coverage for "un-aborted sleep keeps loop alive." | New test present, red before fix, green after fix. | CI test result on branch `836-found-during-cockpit-v1`. |
| SC-003 | Existing `watch.ts` unit tests still pass. | 100 % pass. | `pnpm test` (or equivalent) for the generacy package. |
| SC-004 | `/cockpit:watch <epic>` on a live epic emits at least one transition line during a manually-induced state change (e.g., adding a label to a child issue). | ≥ 1 NDJSON line observed within one interval of the change. | Manual smoke test against a real epic (mirror of the tetrad-development#88 smoke test that surfaced this bug). |

## Assumptions

- No current embedder of `runWatch()` relies on the current `unref` behavior. (Grepped the repo; only the CLI action calls `runWatch`.)
- The abort path (`process.once('SIGINT', …)` + `process.once('SIGTERM', …)` + optional `deps.abortSignal`) is sound and does not need to change. Fix is confined to removing the `unref`.
- The existing snapshot/diff logic in `runOnePoll` and `snapshot.ts` is correct; this bug is purely about process lifetime, not about transition detection accuracy.

## Out of Scope

- Rewriting the transition-detection pipeline (`runOnePoll`, `SnapshotMap`, `emit`).
- Adding a persistent on-disk snapshot store to let a restart-wrapper recover the baseline (the interim workaround is `cockpit status` polling; a real restart-safe watcher is a separate feature).
- Changing the poll-interval floor / default, or adding new flags to `watch`.
- Fixing sibling issues #800 / #826 (referenced only as prior art of the same test-mirrors-code failure pattern).
- Changes to the `/cockpit:watch` skill wrapper itself (the skill is correct; it just currently observes an exiting subprocess).

---

*Generated by speckit*

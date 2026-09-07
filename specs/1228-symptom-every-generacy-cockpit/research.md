# Research: Doorbell gate-answer replay scoping and consumed-position persistence

**Feature**: #1228 | **Branch**: `1228-symptom-every-generacy-cockpit`

## Current-state findings

### F1: `AnswersFileSource` has no persisted position

`answers-file-source.ts` tracks `lastKnownIno`/`lastKnownSize` in-process only.
`doReplay()` resets `lastKnownSize = 0` and re-reads from byte 0 on first discovery,
rotation, and truncation, bounded only by `DEFAULT_REPLAY_LINE_CAP = 10_000`. The #1023
spec's "replay of lines not yet acked" was never implemented — the contract's non-goals
delegate dedup to the session, and `auto.md` invariant #7 forbids the session from
filtering, so nothing anywhere dedups replays. This is the flood mechanism.

### F2: Scope test is repo-string compare

`processLine()` step (c) parses `owner/repo` out of the answer's `gateKey` issue-ref and
compares (case-insensitively) against the bound epic's owner/repo. Consequences:

- Same-repo foreign-epic answers **pass** (the production cross-contamination).
- Cross-repo children of the epic are **dropped** (the `KNOWN LIMITATION` comment; #1111).
- Non-issue gateKey targets (filing / scope-drained) skip the filter and emit — keep this.

### F3: Ref-set machinery already exists and is reusable

`SmeeDoorbellSource` builds a `RefSetView` via `buildRefSet(resolveEpic(...))`
(`smee-source.ts:74`): `issues: Set<"owner/repo#n">` (lowercased repo), including the epic
itself. `resolveEpic` (`@generacy-ai/cockpit`) is one `gh.getIssue` + body parse — cheap
enough for miss-triggered refreshes. The smee source refreshes on epic-issue webhooks
(500 ms debounce) and a 10-minute safety-net timer; poll-fallback mode resolves once at
startup and never refreshes (the Q3 staleness argument).

### F4: Emit already has a natural "consumed" point

`doorbell.ts` `answersOnEvent` awaits the stdout `write()` callback and then `bus.emit()`
before resolving — exactly the Q2 definition of emit. The tailer already awaits `onEvent`
per line (backpressure contract), so cursor-advance-after-await slots in without new
synchronization.

### F5: Wiring context

- Production `runDoorbell` has `deps.gh` (a `GhCliWrapper`); the tailer is constructed
  with only `epicRef`/`onEvent`/`logger`/`filePath` today.
- `COCKPIT_DOORBELL_HARNESS=1` (hermetic #1024 harness) runs the tailer with **no
  GitHub** — no `gh`, no epic resolution, local bus. Any design requiring `resolveEpic`
  must degrade here.
- `COCKPIT_ANSWERS_FILE` already overrides the file path on both paths; the cursor dir
  must derive from it so tests and harness stay hermetic.
- `answeredAt` is a zod-validated ISO datetime on every line (`GateAnswerLineSchema`) —
  the recency window needs no new wire data.

## Decisions

### D1: Shared `EpicRefSetHolder` rather than per-source ref sets

**Decision**: extract ref-set ownership into a holder shared by `SmeeDoorbellSource` and
`AnswersFileSource`; the holder owns `resolveEpic` calls, the smee source keeps its
debounce/safety-net *triggers* and delegates resolve/store.

**Alternatives considered**:
- *Tailer resolves its own ref set independently* — doubles `getIssue` traffic, and the
  spec (FR-002) explicitly requires webhook/safety-net refreshes to feed the tailer.
- *Passing the smee source into the tailer* — inverts lifecycle (tailer starts before and
  outlives source selection; poll mode has no smee source at all).

### D2: Miss-triggered refresh throttle at 30 s in the holder

One timestamp inside `refreshOnMiss()`; misses within the window re-check the current set
and drop without resolving. Misses are human-paced (an answer arrives per operator click),
and the Q1 window runs before the scope test, so a fresh-cursor replay over an old backlog
cannot trigger refresh storms. Matches the clarify Q3 answer verbatim.

### D3: Harness mode keeps legacy repo-scope compare

With no `gh` there is nothing to resolve. Options: (a) epic-only static ref set — would
*drop* child-issue answers the #1024 harness feeds today (behavioural break in the rig
that guards FR-005/007/013/015 of that spec); (b) emit everything — reintroduces
cross-epic leakage in the rig; (c) keep the current owner/repo compare when no holder is
supplied. **Chosen: (c)** — zero harness churn, and the production paths always have a
holder. The #1111 limitation survives only inside the test rig, where it is moot.

### D4: Cursor advances past dropped lines too (positional consumption)

The cursor is a byte position, not an emit ledger. Malformed, window-dropped, and
foreign-dropped lines advance it once processed — otherwise a permanently-foreign line
would pin the cursor forever. This makes FR-002's refresh-before-drop the only guard
against wrongly losing a late-created child's answer; the documented escape hatch (cloud
record stays answered; re-derive/re-ask after 3 sweeps) covers the residual case.

### D5: Cursor file per epic scope, beside the answers file

`<answersDir>/cursors/<owner>__<repo>__<n>.json` (clarify Q4). Two epics in the same repo
get independent cursors — required, since each doorbell consumes the *shared* repo file at
its own pace and scope. `__` separator avoids `/` in filenames; owner/repo lowercased in
the filename to match the case-insensitive ref semantics. Atomic tmp+rename write —
same pattern as the machine-wide registry writes in this package. Debounced flush
(~500 ms) + flush on `stop()`; the at-most-once loss window (Q2) already tolerates a lost
debounce tail (re-emission, handled by `superseded` acks).

### D6: Recency window evaluated before the ref-set test

Order (c′) window → (c″) scope, per FR-005: the window is a pure clock compare on the
already-validated `answeredAt`, so out-of-window lines never trigger a ref-set miss
refresh. Window applies to the three *replay* branches (fresh/stale cursor, rotation,
truncation) — never to resumed-cursor tailing, where lines are by definition unconsumed
live traffic. Default 24 h; `COCKPIT_ANSWERS_REPLAY_WINDOW_MS` overrides; invalid values
fall back to default with a `warn`.

### D7: Keep `DEFAULT_REPLAY_LINE_CAP` as a backstop

The window supersedes the cap as the practical bound, but the cap stays (Infinity remains
test-only) so a pathological file with 10 000+ in-window lines still cannot wedge startup.

## Key sources

- `packages/generacy/src/cli/commands/cockpit/doorbell/answers-file-source.ts` (root cause)
- `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts` (`buildRefSet`, refresh cadence)
- `packages/generacy/src/cli/commands/cockpit/doorbell.ts` (wiring, harness mode, `answersOnEvent`)
- `packages/generacy/src/cli/commands/cockpit/watch/gate-answer.ts` (frozen line schema, `answeredAt`)
- `packages/cockpit/src/resolver/{resolve,types}.ts` (`resolveEpic` cost model)
- `specs/1023-part-cockpit-remote-gates/contracts/answers-file-source.md` (contract to amend)
- `specs/1228-symptom-every-generacy-cockpit/clarifications.md` (Q1–Q4, all settled)

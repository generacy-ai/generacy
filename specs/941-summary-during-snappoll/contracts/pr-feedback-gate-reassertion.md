# Contract: `PrFeedbackHandler` gate re-assertion (FR-002)

## Purpose

Guarantee that after the address-pr-feedback fix session terminates — on any exit branch (Case A/B, blocked-stuck, happy path, thrown error) — the linked issue's label set contains `waiting-for:implementation-review`. If the label is missing at exit, emit a loud structured error log so the stripping path becomes visible as its own defect.

## Behaviour

At the tail of `PrFeedbackHandler.handle()`'s shared `finally` block:

1. **Read labels.** `github.getIssue(owner, repo, issueNumber)`, extract `labels[]`.
2. **If read fails.** Log a `warn` and return (non-fatal — the `finally` must not throw).
3. **If `waiting-for:implementation-review` present.** Log at `debug`, return.
4. **If absent.** Emit exactly one `error` log with the fields below, then call `github.addLabels(owner, repo, issueNumber, ['waiting-for:implementation-review'])`. If the re-add fails, log at `warn` and return.

## Log event shape

```json
{
  "level": "error",
  "msg": "waiting-for:implementation-review missing at fix-session exit — re-adding (FR-002)",
  "event": "gate-label-missing-at-fix-exit",
  "owner": "...",
  "repo": "...",
  "issueNumber": 3,
  "pr": 14
}
```

- `event` is machine-parseable, stable across log versions.
- Aggregator alert (`SC-004`) keys on `event === 'gate-label-missing-at-fix-exit'`.

## Ordering constraint

The re-assertion call MUST come BEFORE `clearInProgressLabel(...)` inside the `finally` block. Rationale: if `agent:in-progress` is cleared first and the re-add fails, the terminal transient state is `{ no agent:*, no waiting-for:* }` — a cockpit observer would see the issue as "workflow ended, ready to merge" for the window between the two calls.

Ordering:
1. `ensureImplementationReviewGate(...)` — re-add gate label if missing
2. `clearInProgressLabel(...)` — clear `agent:in-progress`

Both are idempotent and non-throwing. GitHub `removeLabels` on an already-absent label is a no-op (per `gh-cli.ts` behaviour, documented in existing `PrFeedbackHandler` comments).

## Interaction with FR-003 guard

`ensureImplementationReviewGate` writes `waiting-for:implementation-review`, which is NOT a `completed:<gate>` label — so the FR-003 guard is inert here. The re-add uses `github.addLabels` directly (bypassing `LabelManager`) because `PrFeedbackHandler` already writes labels this way for other flows (`clearInProgressLabel`, `removeFeedbackLabel`, `addBlockedStuckFeedbackLoopLabel`). No architecture change.

## Test surface

Unit tests (in `pr-feedback-handler.gate-reassert.test.ts`, new):

- **Happy path with gate present** — `handle()` runs to happy-path exit; `github.getIssue` returns labels including `waiting-for:implementation-review`; no `addLabels` re-add call is made; no `error` log emitted.
- **Happy path with gate missing** — same as above but `github.getIssue` returns labels without the gate; assert one `error` log with the specified event, then one `addLabels(..., ['waiting-for:implementation-review'])` call.
- **Case B (no diff)** — `spawnClaudeForFeedback` returns false; gate missing on exit; assert the same log + re-add.
- **Thrown error path** — `commitAndPushChanges` throws; the `finally` still runs the check + re-add; log includes `event: 'gate-label-missing-at-fix-exit'`.
- **`getIssue` failure** — the read itself throws; assert a `warn` log and no re-add call; no crash.
- **`addLabels` re-add failure** — read succeeds, re-add throws; assert a `warn` log and the `finally` completes without throwing.

Integration coverage of the same behaviour is captured in the FR-005 test (see `pr-feedback-gate-invariant.integration.test.ts`).

## Non-goals

- **No auto-diagnosis of which code path stripped the gate.** The log surfaces the symptom; root-cause tracing is a follow-up issue (spec §Out-of-scope).
- **No blast-radius extension to other gates.** Only `waiting-for:implementation-review` is re-asserted; other gates (e.g. `sibling-review`) are not this handler's responsibility.
- **No metric emission.** Structured logs are the observability layer; a follow-up metric can key on the log aggregator.

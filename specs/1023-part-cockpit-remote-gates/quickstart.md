# Quickstart: Cockpit doorbell — tail answers file → gate-answer events

**Feature**: #1023 | **Branch**: `1023-part-cockpit-remote-gates`

## Who this is for

- **Operators** running `/cockpit:auto` who want to know how gate answers reach the driving session.
- **Implementers** of the P4 dispatch step (agency `auto.md`) who need to consume `gate-answer` events.
- **Sibling P1 issue owners** (orchestrator writer) who need to know what the tailer expects to read.

## What this feature ships

A new **wake source** inside the existing `generacy cockpit doorbell` process:

- Reads `/workspaces/.generacy/cockpit/answers.ndjson` (single-writer: the orchestrator route from the sibling P1 issue).
- Filters to lines matching the doorbell's bound epic.
- Emits `{type:"gate-answer", ...}` events onto **both** existing wake paths:
  - **Stdout NDJSON stream** — watched by the harness `Monitor` tool.
  - **In-process `EpicEventBus`** — returned by `cockpit_await_events` as typed batch items.

Consumers do not have to change their subscription code — the event flows through the same union type they already consume.

## Operator usage

**No new CLI flags.** The tailer starts automatically as part of `generacy cockpit doorbell <epic-ref>`.

```bash
# Same invocation as today — the tailer now runs alongside the smee source (or poll fallback).
generacy cockpit doorbell owner/repo#123
```

Once an operator answers a gate on `https://generacy.ai` (P3 UI), the orchestrator writer appends a line to `answers.ndjson`. The doorbell emits it to stdout within ~500 ms (fs.watch) or ≤ 2 s (poll fallback) — whichever fires first.

## Consumer usage

### Via the stdout NDJSON stream (harness `Monitor` tool)

Each answer becomes one line on stdout:

```jsonc
{
  "type": "gate-answer",
  "ts": "2026-07-21T19:37:00.000Z",
  "gateId": "gt_01H...",
  "deliveryId": "dl_01H...",
  "epic": "owner/repo#123",
  "line": {
    "gateId": "gt_01H...",
    "deliveryId": "dl_01H...",
    "scope": { "owner": "owner", "repo": "repo", "number": 123 },
    "answer": { /* whatever the gate record shape says */ },
    "answeredAt": "2026-07-21T19:36:58.000Z",
    "answeredBy": "chris@example.com"
    /* any additional fields from the epic-plan doc pass through here */
  }
}
```

### Via `cockpit_await_events` (MCP tool, typed batches)

```jsonc
// Request
{ "epic": "owner/repo#123", "cursor": "<opaque>", "maxWaitMs": 30000 }

// Response
{
  "status": "ok",
  "data": {
    "events": [
      { "type": "gate-answer", "ts": "2026-07-21T19:37:00.000Z", "gateId": "gt_01H...", /* ... */ }
    ],
    "cursor": "<new opaque>"
  }
}
```

Cursor semantics are unchanged (`cockpit_await_events` docs). `gate-answer` events participate in the same monotonic cursor sequence as `issue-transition` / `phase-complete` / `epic-complete`.

## Implementer setup

### Installing the schema

```ts
import { GateAnswerEventSchema, type GateAnswerEvent } from '@generacy-ai/generacy/watch/gate-answer';
// or from the union
import { CockpitStreamEventSchema, type CockpitStreamEvent } from '@generacy-ai/generacy/watch/stream-event';
```

*(Exact export paths depend on the package's `exports` field; see the implementation PR.)*

### Discriminating on `type`

```ts
function handleEvent(e: CockpitStreamEvent) {
  switch (e.type) {
    case 'gate-answer':
      return applyGateAnswer(e);   // your P4 dispatch
    case 'issue-transition':
      // existing handler
      break;
    case 'phase-complete':
    case 'epic-complete':
      // existing handlers
      break;
  }
}
```

### Idempotency

The tailer does NOT dedup by `deliveryId` — your consumer must. In particular:

- **Restart replay** re-emits every line the tailer sees at start (up to the 10 000-line cap).
- **Rotation** re-emits every line in the new file (also subject to the cap).

Use `line.deliveryId` as the idempotency key — it is guaranteed unique per operator answer submission by the orchestrator writer.

## Troubleshooting

### "I answered a gate on generacy.ai but nothing reached my auto session"

Check, in order:

1. **Is the doorbell running for the right epic?** `ps aux | grep doorbell` — the `epicRef` positional must match.
2. **Did the orchestrator write the line?** `ls -la /workspaces/.generacy/cockpit/answers.ndjson` — file should exist, `stat` size should have grown after your answer.
3. **Did the tailer see the append?** Look for `cockpit doorbell: source=…` on stderr (should be `smee` or `poll-fallback`) — either mode runs the tailer in parallel; a warn line like `answers-file-source: skipped line …` means malformed input.
4. **Was the line dropped as cross-epic?** Look for `answers-file-source: cross-epic drop gateId=… scope=…` at `info` on stderr.
5. **File more than 10 000 lines at start?** Look for `answers-file-source: replay-cap truncation, skipped bytes [X..Y]` on stderr. Answers below the cap are unreachable via replay; the sibling orchestrator rotation policy should be tuned to keep the file below the cap.

### "I see the event on stdout but `cockpit_await_events` returns empty"

- **Cursor issued by a prior MCP-server process?** The response includes `resetFrom: 'discarded'` — start with `cursor: undefined` for a fresh subscription.
- **Cursor from a different epic?** You will get `class: 'invalid-cursor', detail: 'cursor was issued for epic X, not Y'`.

### "The doorbell prints `warning: parent directory absent, waiting`"

Expected on fresh clusters — the orchestrator writer hasn't run yet. The tailer will pick up the directory + file when they appear. If the directory never appears, check the sibling P1 orchestrator issue.

## Related issues

- **Sibling P1** (orchestrator): writes `/workspaces/.generacy/cockpit/answers.ndjson`, owns `mkdir` of parent dir, owns rotation policy.
- **Sibling P4** (agency `auto.md`): applies `gate-answer` events to gate records; dedups by `deliveryId`.
- **Epic tracking** (generacy-cloud): full wire contracts in [`cockpit-remote-gates-plan.md`](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md).

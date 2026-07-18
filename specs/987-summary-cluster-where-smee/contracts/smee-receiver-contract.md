# Contract: `SmeeWebhookReceiver` extensions

**Feature**: `987-summary-cluster-where-smee`
**Applies to**: `packages/orchestrator/src/services/smee-receiver.ts`

## `onConnected` callback (FR-002)

### Signature

Added to `SmeeReceiverOptions`:

```ts
onConnected?: () => void;
```

### Semantics

- Fires exactly once per `SmeeWebhookReceiver` instance.
- Fires on the first successful SSE connect — immediately after the existing `Connected to smee.io channel` log line at `smee-receiver.ts:143`.
- Does NOT fire on subsequent reconnects. The `this.reconnectAttempt = 0` at `smee-receiver.ts:90` resets the backoff clock, but does NOT re-fire `onConnected`.
- Guarded by a private `connectedOnceFired: boolean` field, `false` at construction, set to `true` before the callback is invoked.
- Fired synchronously (not `queueMicrotask` / `setImmediate`). Callers should not throw from `onConnected`; any thrown error propagates into the receiver's connect loop and triggers a reconnect cycle (undesired). Callers wrap in `try/catch` at the invocation site if they perform I/O.

### Failure modes

- If `onConnected` is not provided (undefined), the receiver behaves exactly as today.
- If `onConnected` throws, the receiver catches, logs `warn`, and continues. The `connectedOnceFired` flag stays `true` — a thrown callback is still "fired" for the purposes of the once-only guarantee.

### Test cases (informative)

1. **Fires once on first connect**: mock SSE stream that connects, disconnects, reconnects. Assert `onConnected` mock called exactly once.
2. **Does not fire when receiver never connects**: mock `fetch` to reject. Assert `onConnected` never called.
3. **Thrown callback does not break receiver**: `onConnected` throws. Assert the receiver still processes subsequent events (SSE loop continues).

## Broad `recordWebhookEvent()` fan-out (FR-004)

### New constructor options

```ts
prFeedbackMonitor?: PrFeedbackMonitorService;
mergeConflictMonitor?: MergeConflictMonitorService;
clarificationAnswerMonitor?: ClarificationAnswerMonitorService;
```

All three optional. The existing (required) `monitorService: LabelMonitorService` constructor argument is unchanged.

### Semantics

For every SSE event parsed by `processSSEEvent`, once the event has passed:

- `eventType === 'message' || eventType === ''` (the existing SSE-event-type gate at `smee-receiver.ts:190-194`)
- valid JSON parse
- `body` present
- `body.repository.owner.login && body.repository.name` present
- `watchedRepos.has(${owner}/${repo})`

...the receiver calls `recordWebhookEvent()` on:

- `this.monitorService` (label monitor — required)
- `this.prFeedbackMonitor` (if provided)
- `this.mergeConflictMonitor` (if provided)
- `this.clarificationAnswerMonitor` (if provided)

The fan-out is unconditional on `x-github-event` type. Rationale (per research.md §Question 4): the staleness safety net only needs `lastWebhookEvent` to be non-null; broad fan-out ensures all four monitors see the smee leg is alive.

### Per-event processing dispatch (FR-004 + research §5)

After the fan-out, per-event dispatch runs:

| `x-github-event` | `action` | Dispatched to |
|---|---|---|
| `issues` | `labeled` | `monitorService.processLabelEvent` (existing path — unchanged) |
| `pull_request_review` | `submitted` | `prFeedbackMonitor.processPrReviewEvent` (new) |
| `pull_request_review_comment` | `created` | `prFeedbackMonitor.processPrReviewEvent` (new) |
| `issue_comment` | `created` | `clarificationAnswerMonitor.processClarificationAnswerEvent` (new) |
| any other | any | no processing dispatch — `recordWebhookEvent` fan-out only |

Merge-conflict processing is intentionally not wired via smee — see research.md §5. The poll path remains authoritative.

### Payload → event shape

- **`pull_request_review`**: `{ owner: payload.repository.owner.login, repo: payload.repository.name, prNumber: payload.pull_request.number, prBody: payload.pull_request.body || '', branchName: payload.pull_request.head.ref, source: 'webhook' }`.
- **`pull_request_review_comment`**: identical shape, sourced from `payload.pull_request` (comment payloads still include the parent PR).
- **`issue_comment`**: `{ owner: payload.repository.owner.login, repo: payload.repository.name, issueNumber: payload.issue.number, issueLabels: payload.issue.labels.map(l => l.name), source: 'poll' }`. Note the `source: 'poll'` — the existing `ClarificationAnswerEvent.source` type only admits `'poll'`. A follow-up may widen it to include `'webhook'`; the receiver's payload construction is prepared for the type change but does not require it for #987.

### Guards mirrored from direct-HTTP paths

- **PR-review guard**: mirrors `pr-webhooks.ts:83-97` — reject `pull_request_review` unless `action === 'submitted'`; reject `pull_request_review_comment` unless `action === 'created'`.
- **Watched-repo guard**: mirrors `pr-webhooks.ts:100-106`.
- **Assignee filter**: for `issue_comment` events, apply the existing smee-receiver assignee filter (`smee-receiver.ts:224-241`). For `pull_request_review*` events, do NOT filter at the smee layer — `PrFeedbackMonitorService.processPrReviewEvent` performs its own PR-link + assignee resolution downstream (matches `pr-webhooks.ts` behavior — it doesn't filter either).

### Error handling

- Any error from a processing dispatch is caught by the existing `try/catch` at `smee-receiver.ts:294-301`. The `recordWebhookEvent()` fan-out fires **before** the processing dispatch, so an error in processing does NOT prevent adaptive-poll health tracking from updating.

### Test cases (informative)

1. **Broad fan-out fires on any watched-repo event**: pipe an SSE event of type `x-github-event: pull_request` (which has no processing dispatch). Assert `recordWebhookEvent()` was called on all four monitor mocks.
2. **No fan-out on unwatched repo**: pipe an event for a repo not in `watchedRepos`. Assert `recordWebhookEvent()` not called on any monitor.
3. **PR-review dispatch**: pipe a `pull_request_review.submitted` event. Assert `prFeedbackMonitor.processPrReviewEvent` called with correct shape.
4. **PR-review-comment dispatch**: pipe a `pull_request_review_comment.created` event. Assert `prFeedbackMonitor.processPrReviewEvent` called.
5. **Issue-comment dispatch**: pipe an `issue_comment.created` event on a watched, assigned issue. Assert `clarificationAnswerMonitor.processClarificationAnswerEvent` called.
6. **Merge-conflict monitor NOT dispatched, but recordWebhookEvent fires**: pipe a `pull_request.synchronize` event. Assert `mergeConflictMonitor.recordWebhookEvent` called; no processing call.
7. **Optional monitors absent**: instantiate receiver without `prFeedbackMonitor`, `mergeConflictMonitor`, `clarificationAnswerMonitor`. Pipe events. Assert no crashes; only the required label monitor gets `recordWebhookEvent`.

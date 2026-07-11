# Contract: `generacy cockpit mcp` — MCP tool surface

Frozen interface for the seven tools advertised by the stdio MCP server. Playbook migrations (agency follow-up) are written against this contract.

## Tool 1: `cockpit_status`

**Description**: Print a one-shot snapshot of every ref in the epic body's phases. Read-only.

**Input**:
```json
{
  "epic": { "owner": "generacy-ai", "repo": "generacy", "number": 917 }
}
```
Or the string form: `{"epic": "generacy-ai/generacy#917"}`, `{"epic": "917"}` (cwd-inferred), or `{"epic": "https://github.com/generacy-ai/generacy/issues/917"}`.

**Output (ok)**:
```json
{
  "status": "ok",
  "data": {
    "owner": "generacy-ai",
    "repo": "generacy",
    "issue": 917,
    "rows": [ /* status rows, one per ref × phase-membership */ ]
  }
}
```

**Output (error)**: `invalid-args`, `wrong-kind` (PR number passed), `not-an-epic`, `transport`.

**Parity guarantee**: `data` shape === `renderJsonEnvelope({owner, repo, issue}, orderedRows)` output.

## Tool 2: `cockpit_context`

**Description**: Classify the current `waiting-for:*` gate for one issue and emit its bundle.

**Input**:
```json
{ "issue": { "owner": "generacy-ai", "repo": "generacy", "number": 917 } }
```

**Output (ok)**:
```json
{
  "status": "ok",
  "data": {
    "ref": { "owner": "...", "repo": "...", "number": 917, "nwo": "..." },
    "activeGate": "clarification",
    "labels": [ /* ... */ ],
    "bundle": { /* gate-specific structured payload */ }
  }
}
```

**Output (error)**: `invalid-args`, `wrong-kind`, `transport`, `invalid-cursor` (n/a — this tool has no cursor).

## Tool 3: `cockpit_advance`

**Description**: Manually flip `waiting-for:<gate>` → `completed:<gate>` on one issue. Posts an audit comment. Leaves `waiting-for:<gate>` in place (the worker owns clearing it on resume — see #845 label-pair invariant).

**Input**:
```json
{
  "issue": { "owner": "generacy-ai", "repo": "generacy", "number": 917 },
  "gate": "clarification"
}
```

**Output (ok, action=advanced)**:
```json
{
  "status": "ok",
  "data": {
    "ref": { "owner": "...", "repo": "...", "number": 917, "nwo": "..." },
    "gate": "clarification",
    "action": "advanced",
    "completedLabel": "completed:clarification",
    "commentUrl": "https://github.com/.../issuecomment-N"
  }
}
```

**Output (ok, action=already-advanced — idempotent no-op)**:
```json
{
  "status": "ok",
  "data": {
    "ref": { /* ... */ },
    "gate": "clarification",
    "action": "already-advanced",
    "completedLabel": "completed:clarification",
    "noop": true
  }
}
```

**Output (error, gate-refusal — active waiting-for:* differs)**:
```json
{
  "status": "error",
  "class": "gate-refusal",
  "detail": "issue generacy-ai/generacy#917 is waiting on \"plan-review\", not \"clarification\"",
  "hint": "call cockpit_context first to see the active gate"
}
```

**Output (error)**: `invalid-args`, `wrong-kind`, `unknown-gate` (schema-level rejection), `gate-refusal`, `transport`.

## Tool 4: `cockpit_resume`

**Description**: Re-arm a failed phase in place. Clears `agent:error` / `failed:<phase>` / stray `phase:<phase>` and applies `waiting-for:<preceding-gate>` + `completed:<preceding-gate>` + `agent:paused`. See #891.

**Input**:
```json
{ "issue": { "owner": "generacy-ai", "repo": "generacy", "number": 917 } }
```

**Output (ok)**:
```json
{
  "status": "ok",
  "data": {
    "ref": { /* ... */ },
    "action": "resumed",
    "targetPhase": "implement",
    "precedingGate": "implementation-review",
    "labelsAdded": ["waiting-for:implementation-review", "completed:implementation-review", "agent:paused"],
    "labelsRemoved": ["failed:implement", "agent:error", "phase:implement"]
  }
}
```

**Output (ok, action=no-op — non-failed issue, idempotent)**:
```json
{
  "status": "ok",
  "data": {
    "ref": { /* ... */ },
    "action": "no-op",
    "targetPhase": null,
    "precedingGate": null,
    "labelsAdded": [],
    "labelsRemoved": []
  }
}
```

**Output (error, gate-refusal — evidence-based refusal from #891)**:
```json
{
  "status": "error",
  "class": "gate-refusal",
  "detail": "multiple failed:* labels present: [failed:tasks, failed:implement]",
  "hint": "remove all but one failed:* label before resuming"
}
```

**Output (error)**: `invalid-args`, `wrong-kind`, `gate-refusal`, `transport`.

## Tool 5: `cockpit_queue`

**Description**: Enqueue eligible refs under a phase heading to the cluster pipeline. Applies `process:speckit-feature` label and cluster-account assignment. Confirm-gated in CLI, unconfirmed in MCP (agents don't type "y").

**Input**:
```json
{
  "epic": { "owner": "generacy-ai", "repo": "generacy", "number": 917 },
  "phase": "specify"
}
```

**Output (ok)**:
```json
{
  "status": "ok",
  "data": {
    "epic": { "owner": "...", "repo": "...", "number": 917 },
    "phase": "specify",
    "queued": [{"repo": "generacy-ai/generacy", "number": 918, "url": "..."}],
    "skipped": [{"repo": "...", "number": 919, "reason": "already-processing"}]
  }
}
```

**Output (error)**: `invalid-args`, `wrong-kind`, `not-an-epic`, `transport`.

## Tool 6: `cockpit_merge`

**Description**: Merge a PR once its required checks are green. Spawns a fixer subagent on red checks. Never merges on red.

**Input**:
```json
{ "pr": { "owner": "generacy-ai", "repo": "generacy", "number": 950 } }
```

**Output (ok, action=merged)**:
```json
{
  "status": "ok",
  "data": {
    "pr": { "owner": "...", "repo": "...", "number": 950, "url": "..." },
    "action": "merged",
    "checksState": "success",
    "mergeCommitSha": "abc123..."
  }
}
```

**Output (ok, action=fixer-spawned)**:
```json
{
  "status": "ok",
  "data": {
    "pr": { /* ... */ },
    "action": "fixer-spawned",
    "checksState": "failure",
    "fixerAgentId": "..."
  }
}
```

**Output (error, action=blocked)**:
```json
{
  "status": "error",
  "class": "gate-refusal",
  "detail": "PR has no required checks configured; refusing to merge blind",
  "hint": "configure required checks in branch protection first"
}
```

**Output (error)**: `invalid-args`, `wrong-kind` (issue number passed as `pr`), `transport`, `gate-refusal`.

## Tool 7: `cockpit_await_events`

**Description**: Long-poll for cockpit stream events (label changes, phase transitions, epic-complete). Returns a batch coalesced within a small window; caller re-arms with the returned cursor. See spec § Design item 2.

**Input**:
```json
{
  "epic": { "owner": "generacy-ai", "repo": "generacy", "number": 917 },
  "cursor": "eyJlcGljIjoiZ2VuZXJhY3ktYWkvZ2VuZXJhY3kjOTE3IiwicG9zaXRpb24iOjEyM30=",
  "maxWaitMs": 55000,
  "coalesceWindowMs": 3000,
  "maxBatchSize": 256
}
```

All fields except `epic` are optional; defaults are `AWAIT_EVENTS_DEFAULTS`.

**Output (ok, with events)**:
```json
{
  "status": "ok",
  "data": {
    "events": [
      { "type": "issue-transition", "ts": "...", "repo": "...", "kind": "issue", "number": 918, "from": null, "to": "waiting:clarification", "sourceLabel": "waiting-for:clarification", "url": "...", "event": "label-change", "labels": [ /* ... */ ] },
      { "type": "phase-complete", "phase": "clarify", "epicRepo": "generacy-ai/generacy", "epicNumber": 917, "ts": "..." }
    ],
    "cursor": "eyJlcGljIjoiZ2VuZXJhY3ktYWkvZ2VuZXJhY3kjOTE3IiwicG9zaXRpb24iOjEyNX0="
  }
}
```

**Output (ok, timeout with no events)**:
```json
{ "status": "ok", "data": { "events": [], "cursor": "<same as input>" } }
```

**Output (ok, expired-cursor reset)**:
```json
{
  "status": "ok",
  "data": {
    "events": [ /* events from current head */ ],
    "cursor": "<new opaque token>",
    "resetFrom": "expired"
  }
}
```
Caller MUST detect `resetFrom` and engage its startup-sweep recovery to reconcile potentially-missed events.

**Output (error, malformed cursor)**:
```json
{
  "status": "error",
  "class": "invalid-cursor",
  "detail": "cursor is not base64-encoded",
  "hint": "cursor tokens are opaque; pass verbatim from a prior await_events result"
}
```

**Output (error, never-issued cursor)**:
```json
{
  "status": "error",
  "class": "invalid-cursor",
  "detail": "cursor position 999 was never issued for epic generacy-ai/generacy#917",
  "hint": "start with cursor=undefined for a fresh subscription"
}
```

**Output (error, wrong-epic cursor)**:
```json
{
  "status": "error",
  "class": "invalid-cursor",
  "detail": "cursor was issued for epic generacy-ai/generacy#900, not #917"
}
```

**Guarantees**:
- **Delivery batching, never filtering** (agency#394 invariant): every event `cockpit watch` would emit for this epic appears in some batch, verbatim, in order.
- **Cursor idempotence**: passing the same non-expired cursor twice returns the same tail.
- **Verbatim event bodies**: `JSON.stringify(event)` matches (structurally) the NDJSON line `cockpit watch` would emit for the same underlying transition. Discriminator field: `type` (uniform across all sub-events per #887).
- **Ordering**: events within a batch are in the same order they were emitted by the poll loop.

**Constants** (exposed as `AWAIT_EVENTS_DEFAULTS`):
- `maxWaitMs: 55000`
- `coalesceWindowMs: 3000`
- `maxBatchSize: 256`

All per-call tunable via input fields. Server-side retention: `COCKPIT_MCP_EVENT_RETENTION_MS` (default 600 000), `COCKPIT_MCP_EVENT_RETENTION_COUNT` (default 10 000).

## Schema stability

The seven tool names + input/output shapes are the **interface freeze candidates** the spec names in § Out of scope. Once merged, adding fields is backwards-compatible; renaming or removing fields is not. Playbook migration lands against this contract.

## Uniform `type` discriminator (#887)

Every stream event object carries a `type` field with a stable string constant:

| `type` | Emitted for |
|--------|-------------|
| `"issue-transition"` | Any single-issue label change, close, merge, or check state transition |
| `"phase-complete"` | All refs in a phase reach terminal state |
| `"epic-complete"` | All phases in the epic reach terminal state |

Callers can dispatch on `type` alone without inspecting other fields. Consistent with the discriminated union `CockpitStreamEventSchema` in `watch/stream-event.ts`.

# Contract: Doorbell wake-line NDJSON schema

**Scope**: The wire format of every line written to stdout by `generacy cockpit doorbell` between the `armed\n` sentinel and process exit.

## Wire format

- **Encoding**: UTF-8
- **Framing**: NDJSON — one JSON value per line, terminated by `'\n'` (LF, not CRLF).
- **Order**: FIFO. Coalescing may emit multiple lines per wake (up to `MAX_BATCH_SIZE = 100`).
- **Sentinels** (unchanged):
  - `armed\n` — emitted exactly once, before any event lines.
  - Process exits with code 0 on `epic-complete` when `--exit-on-epic-complete` is set.

## Event line grammar

Every event line MUST parse as a JSON value conforming to one of the three discriminated variants below (`CockpitStreamEventSchema` at `packages/generacy/src/cli/commands/cockpit/watch/stream-event.ts:5-9`).

### Variant 1: `issue-transition` (CockpitEvent)

```json
{
  "type": "issue-transition",
  "ts": "2026-07-17T12:34:56.789Z",
  "repo": "generacy-ai/generacy",
  "kind": "issue",
  "number": 985,
  "from": null,
  "to": "waiting-for:clarification",
  "sourceLabel": "waiting-for:clarification",
  "url": "https://github.com/generacy-ai/generacy/issues/985",
  "event": "label-change",
  "labels": ["waiting-for:clarification", "process:speckit-feature"],
  "checks": "green"
}
```

**Field constraints** (also in `CockpitEventSchema`, `packages/generacy/src/cli/commands/cockpit/watch/emit.ts`):

| Field | Type | Required? | Notes |
|-------|------|-----------|-------|
| `type` | `"issue-transition"` | yes | Discriminator. |
| `ts` | ISO-8601 datetime | yes | |
| `repo` | `owner/repo` | yes | Regex `^[^/]+\/[^/]+$`. |
| `kind` | `"issue" \| "pr"` | yes | |
| `number` | positive int | yes | |
| `from` | `CockpitState \| null` | yes | **Always `null` on smee-originated events** (Q3=A). |
| `to` | `CockpitState \| null` | yes | Populated by `classifyIssue(labels).state` on smee (FR-003). |
| `sourceLabel` | `string \| null` | yes | |
| `url` | URL | yes | |
| `event` | `"label-change" \| "issue-closed" \| "pr-merged" \| "pr-closed" \| "pr-checks"` | yes | |
| `labels` | `string[]` | yes | |
| `initial` | `true` | no | Present only on poll-path first-sweep / mid-stream first-sight events. |
| `checks` | `"green" \| "red" \| "pending"` | no | Present only under FR-004 conditions (see below). |

### Variant 2: `phase-complete` (PhaseCompleteEvent)

Unchanged shape (`packages/generacy/src/cli/commands/cockpit/watch/aggregate-emit.ts:24-33`):

```json
{ "type": "phase-complete", "phase": "plan", "epicRepo": "…", "epicNumber": 985, "ts": "…" }
```

### Variant 3: `epic-complete` (EpicCompleteEvent)

Unchanged shape:

```json
{ "type": "epic-complete", "epicRepo": "…", "epicNumber": 985, "ts": "…" }
```

## `checks` field presence rules (FR-004)

`checks` MAY appear only on `issue-transition` events where either:

- `event === "pr-checks"`, OR
- `event === "label-change"` AND `sourceLabel === "completed:validate"`

On any other event, `checks` MUST be absent.

Even when the presence condition is met, `checks` MUST be **omitted** in all of these cases:

- No `PrSnapshot` cached in `SmeeDoorbellSource.prev` for `snapshotKey(repo, "pr", number)` (PR not yet resolved).
- `snap.checksRollup === "pending"` (in-flight).
- `snap.checksRollup === "none"` (no checks configured; skill re-queries to confirm).

Only when the cached `checksRollup` is `"success"` (→ `"green"`), `"failure"`, or `"error"` (→ `"red"`) is the field written.

## Backward compatibility

- **Old skill (bare-type consumer)**: A defensive parser (JSON.parse-guarded) reads only `.type` and dispatches as before. Extra fields are ignored. No breakage. See SC-004.
- **New skill (agency #437)**: Reads full line, dispatches without a `cockpit_status` re-query.
- **Legacy poll-path tests**: Any test that asserted `line === "issue-transition\n"` must be updated to parse JSON and assert `event.type === "issue-transition"`. Prior-shape assertions are load-bearing and will fail loud.

## Parseability guarantee

Every non-sentinel line MUST:

1. Be a syntactically valid JSON value.
2. Parse to `CockpitStreamEventSchema` (`packages/generacy/src/cli/commands/cockpit/watch/stream-event.ts`).
3. Terminate with a single `'\n'`.

Producers MUST NOT emit blank lines, whitespace-only lines, or partial JSON. Consumers MAY strict-validate; on validation failure, they SHOULD log and continue rather than crash.

## Test hooks

- **Line-shape unit test** (FR-008a): consume a line, parse via `JSON.parse`, run through `CockpitStreamEventSchema.parse` — MUST NOT throw.
- **`to` correctness** (FR-008b): assert `event.to === classifyIssue(event.labels).state` for every smee-originated line.
- **`checks` correctness** (FR-008d): drive the smee source with a fixture where `this.prev` has a known `PrSnapshot.checksRollup`; assert `checks` equals the Q1=A mapping and is absent when the mapping would be `pending`.
- **No-gh in smee path** (FR-008c): mock `GhCliWrapper`, drive one `pr-checks` webhook end-to-end, assert zero method invocations on the mock between webhook receipt and `onEvent` dispatch.

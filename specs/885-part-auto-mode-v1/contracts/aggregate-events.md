# Contract: `phase-complete` and `epic-complete` NDJSON events

## Output channel

Both events are emitted on **stdout only**, one JSON object per line, terminated by `\n`. No `suggestion` field. No human-readable prose on stdout. Stderr diagnostics unchanged (existing `cockpit watch:` prefix).

## `phase-complete`

```json
{"type":"phase-complete","phase":"P1 — Foundation","epicRepo":"generacy-ai/generacy","epicNumber":885,"ts":"2026-07-09T14:23:11.041Z"}
```

With `initial: true` (startup sweep):

```json
{"type":"phase-complete","phase":"P1 — Foundation","epicRepo":"generacy-ai/generacy","epicNumber":885,"ts":"2026-07-09T14:23:11.041Z","initial":true}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"phase-complete"` | yes | Discriminator |
| `phase` | string | yes | `ParsedPhase.heading` (e.g. `"P1 — Foundation"`) |
| `epicRepo` | string (`owner/repo`) | yes | Epic's repo |
| `epicNumber` | integer > 0 | yes | Epic's issue number |
| `ts` | ISO-8601 string | yes | Emission timestamp |
| `initial` | `true` | no | Present only on startup sweep for pre-completed phases |

### Firing rules

- Fires **once per transition into** the "phase complete" state (last open issue in the phase transitions to CLOSED). `not_planned` closures count as done.
- After a reopen that regresses the phase (any issue transitions CLOSED→OPEN), re-completion fires the event again.
- Empty phase (`refs.length === 0`): **never** fires. One stderr warn at startup instead.
- `(no phase)` bucket: **never** fires.
- Phase-less epic (`parsed.phases.length === 0`): **never** fires.

## `epic-complete`

```json
{"type":"epic-complete","epicRepo":"generacy-ai/generacy","epicNumber":885,"ts":"2026-07-09T14:25:03.782Z"}
```

With `initial: true`:

```json
{"type":"epic-complete","epicRepo":"generacy-ai/generacy","epicNumber":885,"ts":"2026-07-09T14:25:03.782Z","initial":true}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"epic-complete"` | yes | Discriminator |
| `epicRepo` | string (`owner/repo`) | yes | Epic's repo |
| `epicNumber` | integer > 0 | yes | Epic's issue number |
| `ts` | ISO-8601 string | yes | Emission timestamp |
| `initial` | `true` | no | Present only when epic was already complete at watch start |

### Firing rules

- Fires **once** when every ref in `parsed.allRefs` is CLOSED (regardless of phase structure).
- Empty phases contribute nothing to `allRefs`, so they don't block firing.
- With `--exit-on-epic-complete`, watch flushes stdout and exits `0` after emission.
- Without `--exit-on-epic-complete`, watch keeps polling (existing behavior).
- Re-emits **only** after a regression (any ref reopens) followed by a re-completion.

## Ordering within a poll cycle

Deterministic sequence when a single poll produces multiple events:

1. All per-issue events (`issue-closed`, `pr-merged`, `pr-closed`, `label-change`, `pr-checks`) in existing order.
2. All `phase-complete` events in `parsed.phases` body order.
3. `epic-complete` last if firing.

Guarantee: the last `issue-closed` that triggers a `phase-complete` is always visible before that `phase-complete`. When `--exit-on-epic-complete` is set, the `epic-complete` line is the final line ever written to stdout.

## `--exit-on-epic-complete` flag

- Boolean flag on `generacy cockpit watch`.
- Default: false (unchanged watch behavior).
- When true: after emitting the `epic-complete` NDJSON line, drain stdout and `process.exit(0)`.
- The exit is a **normal 0**, not a signal exit. Consumers watching for EOF on stdin will see clean EOF after the `epic-complete` line.

## Startup sweep

At watch start, if any phase is already complete or the whole epic is already complete, emit the corresponding event(s) with `initial: true` in the same ordering as normal ticks (per-issue initial sweep first, then `phase-complete`s in body order, then `epic-complete` last if firing).

## Startup warnings (stderr)

For each empty phase (`heading` present, `refs.length === 0`), emit one stderr line at watch startup:

```
cockpit watch: phase "<heading>" has no issue refs; treated as complete
```

## Non-fields

The following fields are **explicitly excluded** from the payload (payload-lying-drift avoidance):

- `closedRefs` — derivable from `status --json`.
- `totalCount` — derivable from `status --json`.
- `suggestion` — presentation, belongs to the watch plugin (agency#386).
- `phase` on `epic-complete` — no meaning.
- `repo`, `kind`, `number`, `url`, `labels`, `sourceLabel`, `from`, `to`, `event` — per-issue-event fields, don't apply to aggregates.

## Contract stability

Any addition of a new field is an additive migration (consumers must ignore unknown fields). Any change to firing rules or ordering is a breaking change requiring a new event `type`.

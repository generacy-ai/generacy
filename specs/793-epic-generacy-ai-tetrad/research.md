# Research: Journal-based stuck detection (G5.2)

**Branch**: `793-epic-generacy-ai-tetrad`

## Decisions

### D1. Read path is `specs/{n}/conversation-log.jsonl`, not `.agency/conversations/{n}/journal.jsonl`

**Decision**: Cockpit reads from the actual `ConversationLogger` write path
at `packages/orchestrator/src/worker/conversation-logger.ts:32`, which is
`{specDir}/conversation-log.jsonl` (i.e., `specs/{issue-number}/conversation-log.jsonl`).

**Alternatives**:
- A. Read `.agency/conversations/{n}/journal.jsonl` exactly as the issue
  specifies. Would be a silent no-op today — file does not exist for any
  issue. Per Q1's default, "missing" never flags as stuck, so the sensor
  would never fire.
- C. Probe both paths and use the most recently modified. More resilient if
  a future migration moves the file, but doubles per-issue I/O and hides the
  authoritative path from operators.

**Rationale (per clarif. Q3=B)**: B is correct today. The orchestrator owns
the journal writer; cockpit is a read-only sensor. If the writer ever moves,
the path constant in `journal.ts` is one line to change.

**Source**: `packages/orchestrator/src/worker/conversation-logger.ts:31-33`.

### D2. `recovered` event fires only on journal-advance, never on label exit

**Decision**: When an issue transitions from `stuck=true` to `stuck=false`,
emit `recovered` **only if** the issue is still classified `active` via
`agent:in-progress`. If the issue left `agent:in-progress` (label removed,
agent done, phase advanced), the existing `label-change` event from
`diff.ts:diffIssue` already covers it.

**Alternative**: Emit `recovered` unconditionally whenever `stuck` flips to
`false`. Simpler symmetry, but produces double-fire on every successful
phase exit (every issue that ever went stuck would emit both `label-change`
and `recovered` when the worker finally finished).

**Rationale (per clarif. Q2=A)**: Operators want one event per real-world
transition. Recovery-by-progress and recovery-by-label-change are distinct
semantic events; the existing diff already names the latter.

### D3. Two reason values: `'stale' | 'no-journal'` (plus `null`)

**Decision**: Folding "file exists but cannot be read" into `'no-journal'`
keeps the consumer surface tight. Operators learn the cause from the stderr
log line; the JSON envelope stays at two values.

**Alternative**: Add `'journal-error'` as a third value. Slightly more
informative in `--json` output, but requires a coordinated schema bump
across the renderer, the watch event, the status JSON envelope, and every
downstream consumer.

**Rationale (per clarif. Q4=A)**: Operators do not act differently on
"never wrote" vs "wrote-and-broken" — both mean "no liveness signal."

### D4. Threshold is config-only this iteration

**Decision**: Add `cockpit.stuckThresholdMinutes` to `.generacy/config.yaml`
with a default of 15 minutes. Do not add a CLI flag.

**Alternative**: Add `--stuck-threshold <minutes>` to both `status` and
`watch`. Cheap to implement, but adds two command-line surfaces to test and
document, and operators have not yet asked for it.

**Rationale (per clarif. Q5=A)**: Land the config knob first. Promote to a
CLI flag in a follow-up if operators want per-invocation override.

### D5. Sensor runs only on `active` + `agent:in-progress`

**Decision**: Gate the I/O on `classified.state === 'active'` and
`classified.sourceLabel === 'agent:in-progress'`. All other states skip the
sensor entirely (sensor returns conceptual zero — `stuck=false,
stuckReason=null`).

**Alternative**: Run the sensor on every issue every poll, populate
`lastEntryAt` universally. Useful diagnostic data, but multiplies I/O cost
by an order of magnitude with no operator-visible win.

**Rationale**: The acceptance criterion is narrow ("flags a stale
in-progress issue"). PRs, terminal issues, waiting issues, etc., do not
need a liveness signal.

## Implementation patterns

### Pattern: Pure sensor module with injectable `now` + `cwd` + `logger`

Cockpit's existing modules (`classifier.ts`, `config/loader.ts`) follow this
shape: pure functions, no module-level state, dependencies passed in as
options. `journal.ts` matches the pattern — tests can inject `now: () => new Date('…')`
and `cwd: tmpDir` without monkey-patching `fs` or `Date`.

### Pattern: Snapshot/diff pipeline (watch)

Watch is built around `prev: SnapshotMap → curr: SnapshotMap → events[]`.
Adding `stuck` / `stuckReason` to `IssueSnapshot` slots into this pipeline
naturally — `diffIssue` already compares fields between `prev` and `curr`
and emits events on change. The new transition logic adds two cases to the
same function.

### Pattern: Additive `StatusRow` fields → free `--json` propagation

`renderJsonEnvelope` serializes `StatusRow[]` directly. Adding `stuck` and
`stuckReason` to the row makes them appear in the JSON output with no
envelope-version bump and no renderer change.

## Sources

- `packages/orchestrator/src/worker/conversation-logger.ts` — authoritative
  journal writer path and `JournalEntry` schema.
- `packages/orchestrator/src/worker/types.ts:18-43` — `JournalEntry`
  interface (used only for the `timestamp` field; cockpit treats other
  fields as opaque).
- `packages/cockpit/src/state/classifier.ts` — `ClassifyResult` shape; gate
  source for D5.
- `packages/generacy/src/cli/commands/cockpit/watch/diff.ts` — existing
  `CockpitEvent` shape and the `label-change` discriminator referenced in
  D2.
- `packages/generacy/src/cli/commands/cockpit/status.ts:115` — the
  `classifyIssue` call where the sensor gate lives.
- Clarifications batch 1 (`specs/793-epic-generacy-ai-tetrad/clarifications.md`).

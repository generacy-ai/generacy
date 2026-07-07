# Clarifications

## Batch 1 — 2026-07-07

### Q1: Event discriminator and `from` field for initial lines
**Context**: `CockpitEvent.event` is currently one of `label-change | issue-closed | pr-merged | pr-closed | pr-checks`, and `from` is `CockpitState | null`. FR-003 adds `initial: true` but doesn't say what `event` and `from` carry on an initial-sweep line. The plugin (`/cockpit:watch`) branches its rendering off `event`, so this decides how initial lines render without any plugin change (FR-007).
**Question**: For a first-poll `initial: true` line, what values MUST `event` and `from` take?
**Options**:
- A: Reuse existing values — `event: 'label-change'`, `from: null` (baseline transition from "nothing" to the current state). Zero schema surface change beyond `initial`.
- B: Add a new discriminator — `event: 'initial'`, `from: null`. Explicit but expands the `event` enum and requires plugin fallback for unknown discriminators.
- C: `event: 'label-change'`, `from: <same as `to`>` (self-loop). Semantically odd but signals "no prior state observed".

**Answer**: A — `event: 'label-change'`, `from: null`, plus `initial: true`. FR-007's no-plugin-change goal rules out B (a new enum value needs an unknown-discriminator fallback = a plugin change), and C is a semantic lie. `from: null` renders naturally as "(none) → <state>", and `initial: true` is the explicit marker for anything that cares. This is NOT rev 2's baseline protocol returning: initial lines are actionable-only and the consumer is stateless.

### Q2: What qualifies an issue as actionable at first poll — labels or classifier?
**Context**: The engine already reduces multi-label issues to a single `classified.state` + `classified.sourceLabel` via tier precedence (`terminal < error < waiting < active < pending < unknown`). An issue can carry both a terminal-tier label (e.g., `completed:specify`) AND an actionable label (e.g., `waiting-for:clarification`); the classifier picks `completed:specify` as source. FR-002 defines the actionable set by label names, not by classifier state, so the two lenses can disagree.
**Question**: How does the sensor decide an issue is actionable on the first poll?
**Options**:
- A: Trust the classifier — emit iff `classified.state ∈ {waiting, error}` OR `classified.sourceLabel === 'completed:validate'`. Simple, single source of truth, but hides issues whose actionable label was outranked by a terminal one.
- B: Scan `labels[]` — emit iff ANY label in `labels[]` is in the actionable set (`waiting-for:*`, `completed:validate`, `failed:*`, `needs:intervention`, `agent:error`). Uses `classified.sourceLabel` for the `sourceLabel` field regardless. Catches every actionable label but may emit for issues the classifier considers terminal.
- C: Scan `labels[]` and emit one line per matching actionable label found (multiple lines possible per issue). Most complete but breaks the "one line per issue at first poll" wording implied by FR-001.

**Answer**: B — scan `labels[]` for any actionable label; use `classified.sourceLabel` for the `sourceLabel` field. Option A has a live counterexample sitting in the test epic right now: `christrudelpw/sniplink#2/#3/#4` each carry `completed:specify` AND `waiting-for:clarification`, and the classifier's tier precedence ranks the completed label above the waiting one — so trusting the classifier would skip the exact pending-clarification issues this feature exists to surface. Not C: one line per issue; the line's to-state is the classified state, the sweep just uses a wider net to decide emission. (The precedence itself — `completed:specify` outranking `waiting-for:*` — is misclassifying waiting issues as terminal in status output too; filed separately, not something this sweep should paper over.)

### Q3: `initial` field on polls 2..N — explicit `false` or omitted?
**Context**: FR-004 says polls 2..N must not carry `initial: true` — "either `false` or field omitted". Design notes float both `z.boolean().optional()` (allows both) and `z.literal(true).optional()` (only `true` or absent). Downstream tooling that checks `event.initial === false` behaves differently than tooling that checks `!event.initial`.
**Question**: On polls 2..N, MUST the `initial` field be absent from the emitted JSON, or explicitly present as `false`?
**Options**:
- A: Absent (omit the field). Schema: `z.literal(true).optional()`. Smaller wire footprint; distinguishes "first poll" cleanly from "later poll".
- B: Explicit `false`. Schema: `z.boolean()` (required). Every line carries `initial`; consumers can safely key on `event.initial === false`.
- C: Author's choice — either is valid per the schema `z.boolean().optional()`. Consumers must treat `undefined` and `false` identically.

**Answer**: A — absent on polls 2..N, schema `z.literal(true).optional()`. Consumers key on truthiness; "field present ⇔ first poll" is the cleanest wire contract and the smallest footprint.

### Q4: Ordering of initial-sweep lines within the first poll
**Context**: When N issues are actionable at startup, N NDJSON lines are emitted in one poll cycle. The current `SnapshotMap` iteration order is insertion order (which depends on the order refs were pulled from the epic body and GitHub). Tests, demos, and the SC-001 repro grepping for specific line contents benefit from determinism.
**Question**: MUST the initial-sweep emissions be sorted in a deterministic order?
**Options**:
- A: Yes — sort by `(repo, kind, number)` ascending. Deterministic; matches `snapshotKey` construction; easy to assert in tests.
- B: Yes — sort by tier priority first (`error` before `waiting` before `terminal`-actionable), then by `(repo, kind, number)`. Surfaces "louder" states first when scanning the terminal.
- C: No — emit in `SnapshotMap` iteration order. Simplest; sufficient because consumers don't rely on order today.

**Answer**: A — sort by `(repo, kind, number)` ascending. Deterministic and directly assertable; matches `snapshotKey` construction. Not B: urgency-first ordering is presentation policy, which belongs to the consumer, not the sensor.

### Q5: PR-specific baseline — is `checksRollup: 'failure'` actionable at first poll?
**Context**: FR-002 defines the actionable set as label names only. PRs carry an additional `checksRollup: 'pending' | 'success' | 'failure'` computed field (see `snapshot.ts`); a PR with red CI but no `failed:*` label would not appear in the actionable set by strict FR-002 reading. Polls 2..N do emit a `pr-checks` event on rollup changes, so the transition path already covers this — the question is only about first-poll baseline.
**Question**: At first poll, is a PR with `checksRollup === 'failure'` (and no actionable label) emitted as an initial line?
**Options**:
- A: No — actionability is label-only per FR-002. A red-CI PR with no `failed:*` label stays silent at baseline; the developer sees it only when the rollup changes (which won't happen if it started red). Matches strict reading.
- B: Yes — extend the actionable set to include `checksRollup: 'failure'` for PRs. Ensures no red PR is silently ignored on watcher restart. Requires updating FR-002 to mention the rollup.
- C: No, and also silence the `pr-checks` transition emission when `prev` snapshot is empty (i.e., already covered — no change needed).

**Answer**: B — include `checksRollup === 'failure'` in the first-poll actionable set, and amend FR-002 to say so. The governing principle: the initial sweep should show you exactly what the transition stream would have told you had the watch been running all along, collapsed to current state. A PR that was red before the watch started never changes rollup, so the transition path never fires — strict label-only reading (A/C) recreates this very bug one field over.

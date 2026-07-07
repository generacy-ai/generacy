# Research — #839 Cockpit watch startup sweep

This is a behavior-fix + narrow schema extension, not a design exercise. Research here documents the decisions that shaped the plan (all resolved in `clarifications.md`) and the two engine invariants that made the naive fixes fail.

## Decision Log

### D1: Emit at first poll, marked `initial: true`, only for actionable states

**Decision**: Replace the `if (prev.size === 0) return []` short-circuit in `computeTransitions` with a first-poll sweep that emits one line per snapshot in an actionable state. No cross-run persistence, no `seen-set`, no consumer-side dedupe.

**Rationale**: The bug in #839 is exactly this short-circuit — a developer running the documented `queue → watch` flow starts a watcher that is silent about every gate `queue` just moved into place. The rev-3 semantic is that the initial sweep should show *exactly what the transition stream would have told you had the watch been running all along, collapsed to current state*. Emitting only actionable states — not all six tiers, as rev 2 did — keeps the "silence when nothing needs me" contract (SC-002 / US3) and requires no plugin-side dedupe (Assumptions §1).

**Alternatives considered**:

- **Plugin-side `status --json` sweep at watch startup** (per an earlier discussion note). Rejected per FR-006: pushes classifier duplication into command markdown, drifts, and re-implements what the sensor already knows. The engine has the label set and the snapshot map — that is where the sweep belongs.
- **Full rev-2 baseline (emit every tier on first poll)**. Rejected explicitly by the spec Summary and FR-005. Consumers would need a `seen-set` file to survive watcher restarts without spam; the rev-3 stateless-per-line contract loses. Every operator would trade a silent-startup bug for a noisy-startup bug.
- **Cross-run dedupe via a persisted `seen-set`**. Rejected by FR-008 / Assumptions §1: the sensor stays stateless per run. Re-emitting the same still-pending line after Ctrl-C → restart is the desired behavior (US2 — "restart cost is zero").

**Source**: [`spec.md`](./spec.md) Summary + FR-001–FR-011; [`clarifications.md`](./clarifications.md) Q1–Q5.

### D2: Actionable-emission decision scans raw `labels[]`, not `classified.state`

**Decision**: The predicate for "should this snapshot be emitted at first poll?" iterates `Snapshot.labels[]` looking for any label in the actionable set. The emitted line's `to` and `sourceLabel` still come from `classified.state` / `classified.sourceLabel`.

**Rationale (per Q2)**: The classifier reduces multi-label issues to a single `state` + `sourceLabel` via tier precedence: `terminal < error < waiting < active < pending < unknown`. `completed:specify` is terminal, `waiting-for:clarification` is waiting — the classifier picks `completed:specify`, and any predicate that reads `classified.state` sees `terminal` and skips the issue. Q2's counterexample is live in the test epic today (`christrudelpw/sniplink#2/#3/#4`). Trusting the classifier would silently skip the exact issues this feature exists to surface. The narrow fix is to widen only the *decision* net — the emitted `to` state remains the classifier's answer, so a downstream consumer's rendering is unchanged.

**Alternatives considered**:

- **Trust `classified.state`** (Q2 option A). Rejected — miscarries against the live counterexample; silently violates SC-001 whenever a terminal label co-exists with a waiting one.
- **Emit one line per matching actionable label** (Q2 option C). Rejected — breaks FR-001's "one line per issue at first poll" and complicates plugin rendering.
- **Fix the classifier's tier precedence** (out of scope). The Q2 answer explicitly notes this is a separate bug — filed elsewhere, not something the sweep should paper over. This spec deliberately does the smaller thing.

**Source**: [Q2 in `clarifications.md`](./clarifications.md#q2-what-qualifies-an-issue-as-actionable-at-first-poll--labels-or-classifier).

### D3: Schema uses `z.literal(true).optional()` — no explicit `false` variant

**Decision**: `CockpitEventSchema` gains `initial: z.literal(true).optional()`. First-poll lines carry `initial: true`. Polls 2..N omit the field entirely — no `initial: false` variant exists on the wire.

**Rationale (per Q3)**: "Field present ⇔ first poll" is the cleanest wire contract and smallest footprint. Consumers key on truthiness (`if (event.initial)`), which is safe against both `false` and `undefined`. `z.literal(true)` prevents accidental drift where a producer emits `initial: false` and a naive consumer treats "field present" as an initial marker.

**Alternatives considered**:

- **`z.boolean()` required, explicit `false` on polls 2..N** (Q3 option B). Rejected — larger wire footprint, forces every line to carry a field that is only meaningful for one poll cycle.
- **`z.boolean().optional()` — either representation valid** (Q3 option C). Rejected — ambiguous contract; consumers can't distinguish "producer old and doesn't know about `initial`" from "producer new, poll 2+, field intentionally absent."

**Source**: [Q3 in `clarifications.md`](./clarifications.md#q3-initial-field-on-polls-2n--explicit-false-or-omitted).

### D4: Deterministic sort by `(repo, kind, number)` via `snapshotKey`

**Decision**: `computeInitialSweep` emits lines in ascending order by the map's `snapshotKey`, which is already `` `${repo}#${kind}#${number}` `` — string sort yields `(repo, kind, number)` ordering.

**Rationale (per Q4)**: Determinism is required for SC-008 (byte-stable output) and for grepping specific line contents in the SC-001 repro. Presentation ordering (urgency-first) is a consumer concern, not the sensor's — the sensor emits in stable, testable order.

**Alternatives considered**:

- **Tier-priority-first sort** (Q4 option B — error/waiting/terminal-actionable). Rejected — urgency ordering is presentation policy, belongs downstream.
- **`SnapshotMap` iteration order** (Q4 option C). Rejected — insertion order depends on `gh` result ordering, not deterministic across runs.

**Caveat**: `snapshotKey` sort is string-lex, so `owner/repo#issue#10` sorts before `owner/repo#issue#2`. SC-008 measures byte-stability (identical output for identical input), not strict integer order, so string-sort satisfies the metric. If a load-bearing test fixture surfaces the quirk, the fallback is a tuple-parse sort (documented in `plan.md` §Design Detail).

**Source**: [Q4 in `clarifications.md`](./clarifications.md#q4-ordering-of-initial-sweep-lines-within-the-first-poll) + `snapshot.ts:34` (`snapshotKey`).

### D5: PRs — extend actionable set with `checksRollup === 'failure'`

**Decision**: `isActionableSnapshot(snap)` returns true when `snap.kind === 'pr' && snap.checksRollup === 'failure'`, in addition to the label-based conditions. FR-002 is amended to include this. Issues never rollup-actionable (they don't carry `checksRollup`).

**Rationale (per Q5)**: The initial sweep must show what the transition stream *would have shown* had the watcher been running, collapsed to current state. Polls 2..N emit a `pr-checks` event when `checksRollup` transitions — but a PR that started red never transitions. Strict label-only reading (Q5 option A) recreates the very silent-startup bug this spec exists to fix, one field over.

**Alternatives considered**:

- **Label-only reading** (Q5 option A). Rejected — bug in another guise; a red PR with no `failed:*` label is a very real state and today's `pr-checks` path never covers it at baseline.
- **Silence `pr-checks` at first poll** (Q5 option C). Rejected — doesn't solve the problem; the transition stream isn't going to catch up because `prev.checksRollup` doesn't exist.

**Source**: [Q5 in `clarifications.md`](./clarifications.md#q5-pr-specific-baseline--is-checksrollup-failure-actionable-at-first-poll).

## Engine Invariants That Shaped the Design

### I1: The classifier is tier-precedence-lossy — the sweep must bypass it for the *decision* only

`classifyByPattern` in `packages/cockpit/src/state/label-map.ts` returns a single `CockpitState` per label. `classify(labels)` (in `packages/cockpit/src/state/classifier.ts`) then picks a single winner by tier precedence. Any single-lens read (`classified.state`) loses the co-existing waiting label. The spec's FR-011 codifies this: emission decision reads raw labels; emitted `sourceLabel` reads classifier output. This is a deliberate two-lens design, not accidental.

### I2: `snapshotKey` is already sortable — no new key type needed

`snapshotKey(repo, kind, number)` returns a string. String-sort yields the deterministic order the spec asks for at zero cost. The alternative — introducing a `SnapshotOrdinal` interface with `sortKey(a, b): number` — would be over-engineering.

### I3: `emit.ts` validation runs by default

`CockpitEventSchema.parse` runs on every `emit(event)` unless `skipValidate: true` is set. Any consumer or producer that emits `initial: false` would throw immediately in dev — desirable defense-in-depth for the `z.literal(true).optional()` contract.

## Sibling Prior Art

Same "silent startup baseline" family of bugs as #822, #826, #828, #830, #836 (all under the `found-during-cockpit-v1` branch prefix). Each was a slightly different failure mode of "first poll produces no output when the developer expected output." The recurring lesson: the sensor's "silence" contract needs a well-defined actionable subset, not a blanket silence. This spec crystallizes that subset (FR-002) and centralizes it in one file (SC-006).

## Sources

- [Node.js — `Timer.unref()`](https://nodejs.org/api/timers.html#timeoutunref) — indirectly relevant (sibling #836).
- [Zod — `z.literal`](https://zod.dev/?id=literals) — for the `initial` field type.
- [`packages/generacy/src/cli/commands/cockpit/watch/diff.ts`](../../packages/generacy/src/cli/commands/cockpit/watch/diff.ts) — the exact site of the fix.
- [`packages/generacy/src/cli/commands/cockpit/watch/snapshot.ts`](../../packages/generacy/src/cli/commands/cockpit/watch/snapshot.ts) — `snapshotKey`, `Snapshot`, `SnapshotMap` shape.
- [`packages/cockpit/src/state/label-map.ts`](../../packages/cockpit/src/state/label-map.ts) — classifier tier precedence (invariant I1).

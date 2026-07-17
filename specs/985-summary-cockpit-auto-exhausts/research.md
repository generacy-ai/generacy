# Research: Doorbell full-event wake line (#985)

## Problem framing

The doorbell subprocess writes to stdout to wake the `/cockpit:auto` skill. Today's wire format is a single discriminator token per event (`issue-transition\n`, `phase-complete\n`, `epic-complete\n`). The skill then dispatches by re-querying GitHub via `cockpit_status(json=true)` to reconstruct the state that was already in the webhook payload. On a 15-ref epic that's ~28 GraphQL calls per wake; ~50 wakes/hr saturates the 5000 pts/hr quota.

The fix is to serialize the whole event on the wake line so the skill can dispatch off the line contents alone — no re-query.

## Prior art in the codebase

### `watch/emit.ts` already emits NDJSON

`emit()` at `packages/generacy/src/cli/commands/cockpit/watch/emit.ts:34-39` is the reference pattern:

```ts
export function emit(event: CockpitEvent, opts: EmitOptions = {}): void {
  const out = opts.stdout ?? process.stdout;
  const stamped = { ...event, type: 'issue-transition' as const };
  const validated = opts.skipValidate === true ? stamped : CockpitEventSchema.parse(stamped);
  out.write(`${JSON.stringify(validated)}\n`);
}
```

The doorbell chose a bare-type serializer historically (`subscribe.ts:22-24`); the pattern to converge on is `JSON.stringify(event) + '\n'`. Aggregate events (`phase-complete` / `epic-complete`) are already serialized this way by `aggregate-emit.ts:57-62` — the doorbell just needs to *route* through the same shape.

**Decision**: Rewrite `lineForEvent` to `JSON.stringify(event) + '\n'` — a one-line change. Do **not** revalidate here; validation already happens at the `webhook-to-event.ts` `buildEvent` boundary (schema is `CockpitEventValidated`) and at the aggregate emit boundary.

**Alternative rejected**: Introduce a `emit`-style validating wrapper in the doorbell. Redundant — the event has already been validated by the producer.

### `classifyIssue` is pure and label-only

`packages/generacy/src/cli/commands/cockpit/shared/classify-issue.ts:14-17` wraps `@generacy-ai/cockpit`'s `classify(labels)` and returns `{ state, sourceLabel, labels }`. Zero I/O. This is the exact primitive `diff.ts` uses on the poll path — the smee path just wasn't calling it.

**Decision**: Call `classifyIssue(labels)` inside `buildEvent` and populate `to` and `sourceLabel`. This is a one-place change that fixes both `label-change` and `issue-closed`/`pr-*` events by construction.

**Alternative rejected**: Add `to`/`sourceLabel` at the `processEventBlock` layer in `smee-source.ts`. Would work but pushes classification further from where the labels enter the pipeline (`buildEvent`); higher risk of missing an event kind.

### `PrSnapshot.checksRollup` is already cached by the smee source

`SmeeDoorbellSource` maintains `this.prev: SnapshotMap` at `smee-source.ts:134`, populated by `maybeRefreshAggregate` at line 420. `PrSnapshot.checksRollup` (`watch/snapshot.ts:6,30`) has one of 5 values: `pending | success | failure | none | error`.

That map is **read-through**: it exists for the aggregate refresh, but nothing prevents the smee event path from consulting it. This is exactly the shape Q2=D asks for.

**Decision**: In `smee-source.ts` `processEventBlock`, after `webhookToStreamEvent` returns and before `this.onEvent(ev)`, look up `this.prev.get(snapshotKey(ev.repo, 'pr', ev.number))` for `pr-checks` and `completed:validate` events. If found, apply the strict Q1=A mapping and only stamp `checks` when the result is `'green'` or `'red'`.

**Alternative rejected (A/B/C)**: Trigger a fresh check-status query per event, or coalesce/debounce a targeted query, or extend `maybeRefreshAggregate` to fire on `pr-checks`. All re-introduce load — `pr-checks` fires per check-run completion (dozens per PR), which is exactly the amplifier this issue removes. Q2=D forbids doorbell-side GraphQL for `checks`.

### `from` is not derivable from a single webhook payload

The poll path computes `from` by diffing `prev`/`curr` snapshots. The smee webhook only carries the *post-transition* state. Filling `from` on the smee path requires a stateful cache keyed on `${owner}/${repo}#${number}` (option B in Q3), which is cold-start-unreliable and adds complexity.

**Decision (Q3=A)**: `from` stays `null` on smee events. Dispatch keys on `to`; `from` is dead weight.

**Alternative rejected**: Maintain a cross-event last-seen classification cache. Cold-start / doorbell-restart / cache-eviction all defeat it, and consumers can't tell a miss from a legitimate initial transition. Not worth the machinery.

### Enum stays 3 values (no `unknown`)

`ChecksRollup` has 5 values; Q1=A collapses to 3 (`green | red | pending`); Q4=A rules out a 4th sentinel. When the cached rollup is `pending`, `none`, or absent, the field is **omitted entirely** — the skill treats absent identically to `pending` and falls back to one authoritative query.

**Decision (Q4=A)**: Omit the field. Optional in the schema.

## Implementation patterns

### NDJSON serialization

- **Source**: `packages/generacy/src/cli/commands/cockpit/watch/emit.ts:38`
- **Applies to**: `subscribe.ts:22-24` (`lineForEvent`)
- **Note**: `subscribe.ts` already routes through `lineForEvent` from both `subscribeAndEmit` (poll fallback) and `doorbell.ts:236-247` (smee `onEvent`). One change updates both paths.

### Local label classification

- **Source**: `packages/generacy/src/cli/commands/cockpit/shared/classify-issue.ts`
- **Applies to**: `webhook-to-event.ts:109-132` (`buildEvent`)
- **Zero-cost proof**: `classify(labels)` is `import { classify } from '@generacy-ai/cockpit'` — pure function, no I/O. FR-005 static analysis passes by construction.

### Read-through cache lookup

- **Source**: `smee-source.ts:134` (`this.prev: SnapshotMap`)
- **Applies to**: `smee-source.ts:315-350` (`processEventBlock`)
- **Access pattern**: `this.prev.get(snapshotKey(ev.repo, 'pr', ev.number))` — O(1), synchronous. Returns `PrSnapshot | undefined`.
- **Skip conditions** (any → omit `checks`):
  - `ev.event !== 'pr-checks'` AND `ev.sourceLabel !== 'completed:validate'`
  - `snap == null` (PR not yet in cache — spec/plan phase)
  - `snap.kind !== 'pr'` (defense in depth; `snapshotKey` with `'pr'` should never resolve to an issue)
  - `snap.checksRollup === 'pending' | 'none'` (Q4=A: absent === skill-side pending)

## Key sources / references

- Spec: `specs/985-summary-cockpit-auto-exhausts/spec.md`
- Clarifications: `specs/985-summary-cockpit-auto-exhausts/clarifications.md`
- Root-cause trace: PR #980, PR #982, issue #970 / #978 context
- Reference NDJSON pattern: `packages/generacy/src/cli/commands/cockpit/watch/emit.ts:34-39`
- Reference classification: `packages/generacy/src/cli/commands/cockpit/shared/classify-issue.ts:14-17`
- Cached rollup source: `packages/generacy/src/cli/commands/cockpit/watch/snapshot.ts:6,30`
- Cross-repo skill consumer (not merged in this PR): `generacy-ai/agency#437`

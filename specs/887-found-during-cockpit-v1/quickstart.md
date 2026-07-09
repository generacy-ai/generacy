# Quickstart: Uniform `type` discriminator on `cockpit watch`

## What changes for consumers

Every line the `cockpit watch` NDJSON stream emits now carries a `type` field with one of exactly three values: `issue-transition`, `phase-complete`, `epic-complete`. Filtering or dispatching on `type` sees 100% of the stream. Existing consumers dispatching on `event` (per-issue) continue to work unchanged — the change is purely additive.

## Basic usage

### Dispatch on `type` (recommended)

```ts
import { CockpitStreamEventSchema } from '@generacy-ai/generacy';
import { createInterface } from 'node:readline/promises';

const rl = createInterface({ input: child.stdout });
for await (const line of rl) {
  if (!line) continue;
  const evt = CockpitStreamEventSchema.parse(JSON.parse(line));
  switch (evt.type) {
    case 'issue-transition':
      // evt is fully narrowed — evt.event, evt.number, evt.repo, etc. available
      handleIssueTransition(evt);
      break;
    case 'phase-complete':
      // evt.phase, evt.epicRepo, evt.epicNumber
      handlePhaseComplete(evt);
      break;
    case 'epic-complete':
      handleEpicComplete(evt);
      if (evt.initial !== true) break;
      // Was already complete when we attached — decide whether to celebrate.
      break;
  }
}
```

### `grep '"type"'` — safe again

```bash
generacy cockpit watch owner/repo#123 | grep '"type"'
# Emits every line — no silent drops.
```

Prior to this change, the same filter dropped every `issue-transition` line. See spec `#887` for the incident this fix addresses.

### Legacy: dispatch on `event`

```ts
if (evt.type === 'issue-transition') {
  switch (evt.event) {
    case 'label-change':   /* … */ break;
    case 'issue-closed':   /* … */ break;
    case 'pr-merged':      /* … */ break;
    case 'pr-closed':      /* … */ break;
    case 'pr-checks':      /* … */ break;
  }
}
```

Existing code keyed on `event` continues to work — no rename, no removed values.

### `jq` example: count events by type

```bash
generacy cockpit watch owner/repo#123 --exit-on-epic-complete \
  | jq -c '[.type] | @tsv' \
  | sort \
  | uniq -c
```

## Detecting startup-sweep lines

```ts
if (evt.initial === true) {
  // This state was already true when watch started — don't re-alert.
} else {
  // This is a live transition — take action.
}
```

`initial: true` is present on all three `type` values during startup sweep (per-issue introduced in #839, aggregate introduced in #885).

## Package-root import surface

```ts
export {
  CockpitStreamEventSchema,     // z.discriminatedUnion('type', [...])
} from '@generacy-ai/generacy';

export type {
  CockpitStreamEvent,           // = z.infer<typeof CockpitStreamEventSchema>
} from '@generacy-ai/generacy';
```

The three constituent schemas (`CockpitEventSchema`, `PhaseCompleteEventSchema`, `EpicCompleteEventSchema`, `AggregateEventSchema`) remain available at their existing paths for callers that need finer-grained parsing.

## Troubleshooting

### "The stream still has lines without `type`"

Verify you're on the post-#887 version of `@generacy-ai/generacy`. If the fix is in place, `emit()` stamps `type: 'issue-transition'` unconditionally — even payloads that reach `emit()` without one exit stamped. If a line without `type` reaches stdout, the bypass is either upstream of `emit()` (a direct `process.stdout.write`) or the fix has regressed — file an issue.

### "`grep '"type"'` still drops lines"

Same as above — post-#887, every line must contain the substring `"type":`. If not, the fix has regressed.

### "My existing code broke after upgrade"

Only three additions ship: (1) new `type` field on per-issue lines, (2) new `stream-event.ts` module, (3) new package-root export. If your code broke, most likely you had a schema with `.strict()` on the per-issue shape that now sees an unknown `type` field — extend your consumer schema to accept it, or migrate to `CockpitStreamEventSchema`.

## Commands reference

No new CLI commands or flags. The `cockpit watch` CLI surface is unchanged.

- `generacy cockpit watch <epic-ref>` — stream events.
- `generacy cockpit watch <epic-ref> --exit-on-epic-complete` — drain and exit `0` after `epic-complete`.

## See also

- **Spec**: `specs/887-found-during-cockpit-v1/spec.md`
- **Clarifications**: `specs/887-found-during-cockpit-v1/clarifications.md`
- **Data model**: `specs/887-found-during-cockpit-v1/data-model.md`
- **Contracts**: `specs/887-found-during-cockpit-v1/contracts/`
- **README** (post-merge): `packages/generacy/README.md#cockpit-watch--stream-grammar`

# Contract: `CockpitStreamEventSchema` discriminated union

## Public API

Exported from `@generacy-ai/generacy` (package root).

```ts
import { CockpitStreamEventSchema, type CockpitStreamEvent } from '@generacy-ai/generacy';
```

## Discriminated union grammar

```ts
CockpitStreamEventSchema = z.discriminatedUnion('type', [
  CockpitEventSchema,          // type: 'issue-transition'
  PhaseCompleteEventSchema,    // type: 'phase-complete'
  EpicCompleteEventSchema,     // type: 'epic-complete'
])
```

## Wire shape — JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "oneOf": [
    {
      "type": "object",
      "required": ["type","ts","repo","kind","number","from","to","sourceLabel","url","event","labels"],
      "properties": {
        "type": { "const": "issue-transition" },
        "ts": { "type": "string", "format": "date-time" },
        "repo": { "type": "string", "pattern": "^[^/]+/[^/]+$" },
        "kind": { "enum": ["issue","pr"] },
        "number": { "type": "integer", "minimum": 1 },
        "from": { "oneOf": [{ "type": "string" }, { "type": "null" }] },
        "to": { "oneOf": [{ "type": "string" }, { "type": "null" }] },
        "sourceLabel": { "oneOf": [{ "type": "string" }, { "type": "null" }] },
        "url": { "type": "string", "format": "uri" },
        "event": { "enum": ["label-change","issue-closed","pr-merged","pr-closed","pr-checks"] },
        "labels": { "type": "array", "items": { "type": "string" } },
        "initial": { "const": true }
      }
    },
    {
      "type": "object",
      "required": ["type","phase","epicRepo","epicNumber","ts"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "phase-complete" },
        "phase": { "type": "string", "minLength": 1 },
        "epicRepo": { "type": "string", "pattern": "^[^/]+/[^/]+$" },
        "epicNumber": { "type": "integer", "minimum": 1 },
        "ts": { "type": "string", "format": "date-time" },
        "initial": { "const": true }
      }
    },
    {
      "type": "object",
      "required": ["type","epicRepo","epicNumber","ts"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "epic-complete" },
        "epicRepo": { "type": "string", "pattern": "^[^/]+/[^/]+$" },
        "epicNumber": { "type": "integer", "minimum": 1 },
        "ts": { "type": "string", "format": "date-time" },
        "initial": { "const": true }
      }
    }
  ]
}
```

## Example lines

### `issue-transition` (label-change)

```json
{"type":"issue-transition","ts":"2026-07-09T14:20:03.111Z","repo":"o/r","kind":"issue","number":123,"from":"pending","to":"active","sourceLabel":"phase:plan","url":"https://github.com/o/r/issues/123","event":"label-change","labels":["phase:plan"]}
```

### `issue-transition` (initial sweep)

```json
{"type":"issue-transition","ts":"2026-07-09T14:20:03.111Z","repo":"o/r","kind":"issue","number":123,"from":null,"to":"active","sourceLabel":"phase:plan","url":"https://github.com/o/r/issues/123","event":"label-change","labels":["phase:plan"],"initial":true}
```

### `phase-complete`

```json
{"type":"phase-complete","phase":"P1 — Foundation","epicRepo":"generacy-ai/generacy","epicNumber":885,"ts":"2026-07-09T14:23:11.041Z"}
```

### `epic-complete`

```json
{"type":"epic-complete","epicRepo":"generacy-ai/generacy","epicNumber":885,"ts":"2026-07-09T14:25:03.782Z"}
```

## Emit-side stamping guarantee (FR-004)

Both `emit()` (per-issue) and `emitAggregate()` (aggregate) stamp the `type` literal into the payload **before** the `skipValidate` branch. Result: a payload reaching `emit()` without (or with a bogus) `type` still exits stamped `'issue-transition'`; a payload reaching `emitAggregate()` retains any existing valid `type` and is otherwise validated normally.

## Consumer patterns

### Type-based dispatch

```ts
import { CockpitStreamEventSchema } from '@generacy-ai/generacy';

for await (const line of readLines(child.stdout)) {
  const evt = CockpitStreamEventSchema.parse(JSON.parse(line));
  switch (evt.type) {
    case 'issue-transition':  handleIssueTransition(evt); break;
    case 'phase-complete':    handlePhaseComplete(evt);   break;
    case 'epic-complete':     handleEpicComplete(evt);    break;
  }
}
```

### Backward-compat: dispatch on `event` (per-issue only)

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

### `grep '"type"'` sees every line

Guaranteed by the emit-side stamping — the failure mode observed in the auto-mode session (#885 T-S4) no longer occurs.

# Contract: `formatManualAdvanceComment` (updated for #845)

**Module**: `packages/generacy/src/cli/commands/cockpit/manual-advance-marker.ts`
**Callers**: `packages/generacy/src/cli/commands/cockpit/advance.ts` (only)
**Delta reason**: Per clarifications Q1→C, the marker sentence must describe the label-pair persistence explicitly rather than imply a `waiting-for:X → completed:X` label diff. The old sentence teaches the wrong mental model to any future reader of the issue thread.

## Signature

Unchanged.

```ts
export interface ManualAdvanceMarker {
  gate: string;
  actor?: string;
  ts: string;
}

export function formatManualAdvanceComment(marker: ManualAdvanceMarker): string;
```

## Behavior

### `actor` present + non-empty

HTML prelude **byte-stable** (do not change — scanned by downstream cockpit surfaces):

```
<!-- generacy-cockpit:manual-advance gate=<gate> actor=<actor> ts=<ts> -->

Marked `completed:<gate>` by **@<actor>** — `waiting-for:<gate>` left in place for the worker to clear on resume.
```

### `actor` `undefined` or empty string

```
<!-- generacy-cockpit:manual-advance gate=<gate> ts=<ts> -->

Marked `completed:<gate>` — `waiting-for:<gate>` left in place for the worker to clear on resume.
```

- No `actor=` placeholder in the HTML comment (behavior from #830 preserved).
- No `by @…` sentence fragment.
- Trailing period on the sentence preserved.

## Validation (unchanged from #830)

- `gate` MUST match `GATE_REGEX` (`^[a-z][a-z0-9-]*$`). Throws on violation.
- `actor` validated **only** when present and non-empty; MUST match `ACTOR_REGEX` (`^[A-Za-z0-9-]+$`).
- `ts` MUST be a non-empty ISO-8601 string that round-trips through `new Date(ts).toISOString()`.

## Byte-stability guarantee

The HTML comment prelude (`<!-- generacy-cockpit:manual-advance … -->`) is unchanged.

- `clarification-comment-finder.ts` and any other downstream scanners MUST continue to match `<!-- generacy-cockpit:manual-advance gate=<x> …` verbatim.
- Only the human-facing sentence below the prelude is updated.

## Test cases

| `actor` input | Expected sentence text |
|---|---|
| `'alice'` | ``Marked `completed:<gate>` by **@alice** — `waiting-for:<gate>` left in place for the worker to clear on resume.`` |
| `undefined` | ``Marked `completed:<gate>` — `waiting-for:<gate>` left in place for the worker to clear on resume.`` |
| `''` | Same as `undefined` |
| `'invalid space'` | Throws (regex violation) |
| Bad `gate` | Throws (regex violation) |
| Bad `ts` | Throws (round-trip check) |

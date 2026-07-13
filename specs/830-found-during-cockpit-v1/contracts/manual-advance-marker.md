# Contract: `formatManualAdvanceComment` (updated)

**Module**: `packages/generacy/src/cli/commands/cockpit/manual-advance-marker.ts`
**Callers**: `packages/generacy/src/cli/commands/cockpit/advance.ts` (only)
**Delta reason**: `resolveCockpitIdentity(mode: 'optional')` may return `undefined`. FR-003 requires `cockpit advance` to degrade cosmetically instead of failing when identity is unresolved.

## Signature

```ts
export interface ManualAdvanceMarker {
  gate: string;
  actor?: string;          // ← was required, now optional
  ts: string;
}

export function formatManualAdvanceComment(marker: ManualAdvanceMarker): string;
```

## Behavior

### `actor` present + non-empty

Output byte-identical to today:

```
<!-- generacy-cockpit:manual-advance gate=<gate> actor=<actor> ts=<ts> -->

Manually advanced `waiting-for:<gate>` → `completed:<gate>` by **@<actor>**.
```

### `actor` `undefined` or empty string

`actor=` attribute is omitted from the HTML comment; `by …` clause is omitted from the sentence:

```
<!-- generacy-cockpit:manual-advance gate=<gate> ts=<ts> -->

Manually advanced `waiting-for:<gate>` → `completed:<gate>`.
```

- No `actor=` placeholder in the HTML comment.
- No `by @unknown` or `by @cluster` sentence fragment.
- Trailing period on the sentence preserved.

## Validation

- `gate` — MUST match `GATE_REGEX` (`^[a-z][a-z0-9-]*$`). Unchanged. Throws on violation.
- `actor` — validation runs **only when `actor` is a non-empty string**. If provided, MUST match `ACTOR_REGEX` (`^[A-Za-z0-9-]+$`). If `undefined` or `""`, validation is skipped.
- `ts` — MUST be a non-empty ISO-8601 string that round-trips through `new Date(ts).toISOString()`. Unchanged. Throws on violation.

## Backwards Compatibility

- Callers that pass `actor: string` see identical output. No changes to the marker parser (the HTML-comment scanner in `clarification-comment-finder.ts` or `merge.ts` if any) since the marker gate/ts attributes are unchanged.
- The absence of `actor=` in the HTML comment is an intentional signal for downstream parsers: "identity was unresolvable at advance time". Downstream may safely default to `undefined` when `actor=` is absent.

## Test Cases

| actor input | Expected output |
|---|---|
| `'alice'` | `<!-- … actor=alice ts=… -->\n\n… by **@alice**.` |
| `undefined` | `<!-- … ts=… -->\n\n… .` (no `actor=`, no `by …`) |
| `''` | Same as `undefined` — `actor=` omitted; `by …` omitted |
| `'invalid space'` | Throws (regex violation) — no lenient path for invalid non-empty actors |
| `null` (as `unknown`) | Throws — TS type disallows, so no runtime handling required; tests may skip |

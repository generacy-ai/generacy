# Contract: `StatusRow` + `renderJsonEnvelope` field additions

**Location**: `packages/generacy/src/cli/commands/cockpit/status/row.ts` and `render-table.ts`.
**Consumers**: `cockpit status --json` output (piped to downstream cockpit-web / cockpit skills / operator scripts).

## `StatusRow` — added fields

```ts
export interface StatusRow {
  // ... existing fields unchanged ...
  issueState: 'OPEN' | 'CLOSED';
  stateReason: 'COMPLETED' | 'NOT_PLANNED' | null;
}
```

### `issueState`
- Source: `Issue.state` (from `gh search issues` or `gh issue view`).
- Semantics: raw GitHub issue open/closed state.
- Consumer derivation: `done = row.issueState === 'CLOSED'`. Downstream consumers derive `done` per-call — no cached boolean field on the envelope (Q2-A / SC-002).

### `stateReason`
- Source: `Issue.stateReason` (added to `Issue`; see `data-model.md`).
- Semantics: GitHub's `stateReason` field, normalized to `'COMPLETED' | 'NOT_PLANNED' | null`.
- `null` when the issue is OPEN, or when GitHub returns an unknown reason (defensive coercion).

## `renderJsonEnvelope` — no schema wrapper change

The envelope shape is:

```ts
export interface StatusEnvelope {
  scope: { kind: 'epic'; owner: string; repo: string; issue: number };
  rows: StatusRow[];
}
```

`renderJsonEnvelope` uses `JSON.stringify(envelope)` verbatim. The two new `StatusRow` fields flow through with no serializer changes.

**Example row (closed-merged)**:
```json
{
  "repo": "christrudelpw/sniplink",
  "kind": "issue",
  "number": 2,
  "title": "…",
  "state": "terminal",
  "sourceLabel": "completed:validate",
  "issueState": "CLOSED",
  "stateReason": "COMPLETED",
  "prNumber": 12,
  "checks": "success",
  "url": "…",
  "phase": "P1"
}
```

Note that `state: "terminal"` and `sourceLabel: "completed:validate"` are preserved (unchanged label-derived signal). Downstream consumers filter `done` off `issueState`, not off the label residue.

**Example row (closed-not-planned)**:
```json
{
  "…": "…",
  "state": "terminal",
  "sourceLabel": "completed:validate",
  "issueState": "CLOSED",
  "stateReason": "NOT_PLANNED",
  "…": "…"
}
```

**Example row (open)**:
```json
{
  "…": "…",
  "issueState": "OPEN",
  "stateReason": null
}
```

## Table render (non-JSON)

`fmtRow` inspects `row.issueState` and swaps the `state` and `sourceLabel` columns:

| `issueState` | `stateReason` | State column | Source column | Colour |
|--------------|---------------|--------------|---------------|--------|
| `OPEN` | (any) | `row.state` (existing) | `row.sourceLabel` (existing) | `colorizer.state(...)` (existing palette) |
| `CLOSED` | `COMPLETED` | `✓ merged` | `merged/closed` | green |
| `CLOSED` | `NOT_PLANNED` | `✗ closed` | `(not planned)` | dim grey |
| `CLOSED` | `null` | `✓ merged` | `merged/closed` | green (defensive default — GitHub returned no reason but issue is closed) |

Closed rows stay under their phase-group header (Q1-A rejects Q1-C's `— Done —` sub-section).

## Backwards compatibility

- Consumers reading `state` and `sourceLabel` continue to work — those fields are unchanged. They read the label-derived tier (`terminal` / `active` / ...), which is preserved as-is on closed rows.
- Consumers that need the new "done" signal MUST switch to `issueState === 'CLOSED'`. Continuing to key off `sourceLabel === 'completed:validate'` will re-produce the #873 bug pattern — this is a documented deprecation of the label-only pattern for actionability decisions in downstream code.

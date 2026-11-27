# Data Model: Zero-question clarify phase must not strand an issue

No new entities, types, or persisted data. The change is a branch inside one existing
predicate. Shapes involved:

## Existing types (unchanged)

```ts
// packages/orchestrator/src/worker/types.ts
export interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  // … warn / error / debug / child
}
```

## Modified function signature

```ts
// packages/orchestrator/src/worker/clarification-poster.ts
export function hasPendingClarifications(
  checkoutPath: string,
  issueNumber: number,
  logger?: Logger,          // NEW — optional, FR-002 info log on the ENOENT branch
): boolean;
```

Callers:

| Caller | Change |
|--------|--------|
| `phase-loop.ts` `on-questions` gate (~L1976) | passes `this.logger` |
| `__tests__/has-pending-clarifications.test.ts` | may omit (optional) |

## Decision table (the real "model")

Evaluated top to bottom; first match wins.

| # | State | Result | FR | Changed? |
|---|-------|--------|----|----------|
| 1 | `specs/` unreadable or no `<issue>-*` dir (`findSpecDir` → `undefined`) | `true` (pause) | FR-003 | no |
| 2 | `readFileSync` throws, `code === 'ENOENT'` | `false` (advance) + info log | FR-001/FR-002 | **yes** |
| 3 | `readFileSync` throws, any other/absent `code` (EACCES, EIO, plain Error) | `true` (pause) | FR-004 | no |
| 4 | content trims to `''` | `false` (advance) | FR-006 | no |
| 5 | non-empty content, zero parsed `### Q<n>:` questions | `true` (pause) | FR-005 | no |
| 6 | ≥1 parsed question unanswered | `true` (pause) | — | no |
| 7 | all parsed questions answered | `false` (advance) | — | no |

## Validation rules

- Row 2 requires row 1 to have passed (spec dir confirmed present) — this ordering is the
  invariant that makes ENOENT safe to treat as "zero-question run".
- The `code` check must be exact string equality with `'ENOENT'`; an `undefined` code falls
  through to row 3 (fail closed).

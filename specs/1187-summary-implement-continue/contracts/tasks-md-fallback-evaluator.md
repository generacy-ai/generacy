# Contract: tasks.md fallback evaluator

Module: `packages/orchestrator/src/worker/tasks-md-fallback.ts`

## Public surface (orchestrator-internal — not re-exported at package boundary)

```ts
export type TasksMdEvaluation =
  | { kind: 'incomplete'; unchecked: number; checked: number; total: number }
  | { kind: 'complete';   unchecked: 0;      checked: number; total: number }
  | { kind: 'unreadable'; reason: string };

/** FS-backed evaluator: resolves specs/{issueNumber}-* and reads tasks.md. */
export function evaluateTasksMd(context: WorkerContext): TasksMdEvaluation;

/** Pure checkbox counter over tasks.md content. Exported for direct unit test. */
export function countTasks(content: string): {
  unchecked: number;
  checked: number;
  total: number;
};
```

## `countTasks(content)` — parse contract

- Split on newlines; test each line against `^[ \t]*[-*+] \[( |x|X)\]`.
- Capture group ` ` (single space) → **unchecked**; `x` or `X` → **checked**.
- `total = unchecked + checked` (non-matching lines excluded).
- Empty string / no matching lines → `{ unchecked: 0, checked: 0, total: 0 }`.
- Idempotent, pure, no I/O.

### Examples

| Input line              | Counted as |
|-------------------------|------------|
| `- [ ] T001 Do a thing` | unchecked  |
| `- [x] T002 Done`       | checked    |
| `- [X] T003 Done`       | checked    |
| `  * [ ] nested`        | unchecked  |
| `+ [x] plus bullet`     | checked    |
| `## Phase 1`            | ignored    |
| `- [~] partial`         | ignored    |
| `Some prose - [ ] mid`  | ignored (bracket not line-anchored) |

## `evaluateTasksMd(context)` — classification contract

1. `specsDir = join(context.checkoutPath, 'specs')`.
2. `readdirSync(specsDir)`; filter `d.startsWith(\`${issueNumber}-\`)`.
   - **read error / dir missing** → `{ kind: 'unreadable', reason: 'specs dir not readable: …' }`.
   - **zero matches** → `{ kind: 'unreadable', reason: 'no spec dir for issue N' }`.
   - **multiple matches** → `{ kind: 'unreadable', reason: 'ambiguous spec dirs for issue N: …' }`.
3. `tasksPath = join(specsDir, match, 'tasks.md')`; read UTF-8.
   - **missing / read / decode error** → `{ kind: 'unreadable', reason: 'tasks.md not readable: …' }`.
4. `const { unchecked, checked, total } = countTasks(content)`.
   - `unchecked > 0` → `{ kind: 'incomplete', unchecked, checked, total }`.
   - `unchecked === 0` (all checked **or** `total === 0`) → `{ kind: 'complete', unchecked: 0, checked, total }`.

## Phase-loop integration contract

Inserted in `phase-loop.ts` immediately **before** the increment block (`:873`),
gated on:

```ts
if (phase === 'implement' && result.success && result.implementResult === undefined) {
  const evalResult = (deps.evaluateTasksMd ?? evaluateTasksMd)(context);
  if (evalResult.kind === 'incomplete') {
    result.implementResult = {
      partial: true,
      tasks_remaining: evalResult.unchecked,
      tasks_completed: evalResult.checked,
      tasks_total: evalResult.total,
    };
  } else if (evalResult.kind === 'unreadable') {
    this.logger.info(
      { phase, reason: evalResult.reason, issueNumber: context.item.issueNumber },
      'tasks.md safety net: advancing (fallback source unavailable)',
    );
  }
  // 'complete' → no-op → existing block skipped → advance
}
```

**Guarantees**:
- Fires **only** when the sentinel is absent (`implementResult === undefined`) —
  SC-005: sentinel-present runs are byte-identical.
- On `incomplete`, control falls through to the existing `:873` block, which
  applies the no-progress guard (FR-003), WIP commit/push, fresh session, and
  `i--; continue`.
- On `complete` / `unreadable`, `result.implementResult` stays undefined → the
  `:873` block is skipped → the phase advances (FR-004 / FR-006).

## Success-criteria traceability

| SC | Assertion |
|----|-----------|
| SC-001 | `incomplete` classification re-enters implement (phase-loop test). |
| SC-002 | T001–T011 checked / T012–T026 unchecked fixture ⇒ `incomplete`, no `completed:implement`. |
| SC-003 | all-checked or no-tasks.md ⇒ advance exactly as today. |
| SC-004 | unchecked count not decreasing across two increments ⇒ no-progress guard escalates. |
| SC-005 | sentinel-driven increment tests pass unmodified. |

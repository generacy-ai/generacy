# Quickstart: tasks.md safety net

## What it does

After a `success` implement phase that emitted **no** `SPECKIT_IMPLEMENT_PARTIAL`
sentinel, the engine reads the workflow's `tasks.md`. If unchecked `- [ ]` tasks
remain, it re-enters the implement phase (WIP commit, fresh session) instead of
granting `completed:implement` and advancing to review. The sentinel remains the
fast path; `tasks.md` is the fallback source of truth.

## Where the code lives

```
packages/orchestrator/src/worker/tasks-md-fallback.ts   # evaluator + parser
packages/orchestrator/src/worker/phase-loop.ts          # synthesis block before :873
packages/orchestrator/src/worker/claude-cli-worker.ts   # wires the default evaluator
```

## Behavior at a glance

| tasks.md state (no sentinel)        | Outcome                                   |
|-------------------------------------|-------------------------------------------|
| ≥1 unchecked `- [ ]`                | Re-enter implement                        |
| all `- [x]`                         | Advance (grant `completed:implement`)     |
| zero task lines                     | Advance (task-less story, FR-004)         |
| no spec dir / ambiguous / unreadable| Advance + log FR-006 reason (fail-open)   |
| sentinel present                    | Unchanged — sentinel decides (SC-005)     |

## Run the tests

```bash
pnpm --filter @generacy-ai/orchestrator test tasks-md-fallback
pnpm --filter @generacy-ai/orchestrator test phase-loop
```

## Verify the #26 regression is fixed

Fixture: `tasks.md` with T001–T011 checked (`- [x]`) and T012–T026 unchecked
(`- [ ]`), implement returns `success` with `implementResult === undefined`.
Expected: evaluator returns `{ kind: 'incomplete', unchecked: 15, checked: 11,
total: 26 }`, phase-loop synthesizes `implementResult`, re-enters implement, and
does **not** grant `completed:implement`.

## Troubleshooting

- **Phase advances despite unchecked tasks** → the sentinel was present
  (`implementResult !== undefined`); the fallback intentionally defers to it (Q1=A).
- **`tasks.md safety net: advancing (fallback source unavailable)` in logs** →
  the spec dir was missing/ambiguous or tasks.md was unreadable (FR-006 fail-open).
- **`Implement increment made no progress` escalation** → the unchecked count did
  not decrease across two increments (no-progress guard, FR-003/SC-004).

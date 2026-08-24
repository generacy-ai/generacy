# Quickstart: tasks.md heading-grammar safety net (#1192)

## What this changes

The #1187 `tasks.md` safety net counted only checkbox tasks (`- [ ] T001`). It now
also counts heading tasks (`### T001` unchecked → `### T001 [DONE]` done), so a
heading-format `tasks.md` with unfinished work re-enters the implement phase instead
of silently advancing. The fix lives entirely in
`packages/orchestrator/src/worker/tasks-md-fallback.ts` (`countTasks`) plus one
log-only line in `phase-loop.ts`.

## Verify

```bash
cd /workspaces/generacy
pnpm --filter @generacy-ai/orchestrator test tasks-md-fallback
pnpm --filter @generacy-ai/orchestrator test phase-loop
```

## The two grammars

```markdown
- [ ] T001 checkbox task, unchecked
- [x] T001 checkbox task, done

### T001 Heading task, unchecked
### T001 [DONE] Heading task, done
```

Both grammars sum into one `{unchecked, checked, total}` tally, so a mixed file
counts correctly.

## Edge cases (deliberate)

| Line | Counts as |
|------|-----------|
| `### T001 Description [DONE]` | **unchecked** — `[DONE]` must be immediately after the ID (Q2=B). |
| `### T001-T026 remaining` (and en-/em-dash) | **zero tasks** — range/summary headings are rejected (Q3=A). |
| `### Phase 3.1: T012`, `### Task T001` | **zero tasks** — ID not immediately after the heading marker. |
| `tasks.md` with no task lines of either grammar | **complete** (fail-open), plus a distinct log line (FR-006). |

## Behavior

- Heading-format unfinished file → `incomplete` → the existing #1187 increment
  synthesizes `implementResult` and re-enters implement (no-progress guard retained).
- All-checked or genuinely task-less file → `complete` → advance.
- Missing/ambiguous spec dir or unreadable `tasks.md` → `unreadable` → advance with
  the existing log (unchanged).

## Not in this change

- No implement-prompt change, no sentinel-format change, no label-protocol change.
- No new `TasksMdEvaluation` kind, no new persisted state, no new public exports.
- The phase-loop increment block, `ImplementPartialResult` synthesis mapping, and the
  sentinel fast path are untouched.

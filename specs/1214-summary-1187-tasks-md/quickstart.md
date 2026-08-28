# Quickstart: Manual-task awareness in the #1187 tasks.md safety net (#1214)

## What this does

The #1187 tasks.md safety net re-enters implement whenever unchecked tasks remain. Manual-verification tasks (browser checks, deploy checklists) stay unchecked by design, so the re-entry makes no progress and the no-progress guard fails complete-and-green stories with `failed:implement`. After #1214, the engine classifies unchecked tasks as *manual* or *automatable*:

- **All remaining tasks manual** (or `waiting-for:manual-validation` already on the issue) → engine commits WIP, grants `completed:implement`, applies `waiting-for:manual-validation` + `agent:paused`, and pauses.
- **Mixed remainder** → re-enters implement scoped to the automatable count only.
- **No manual tasks, no label** → byte-identical to #1187.

## Marking a task as manual

Two tiers, applied per unchecked task line (both checkbox and heading grammars):

```markdown
- [ ] T005 Verify the deploy dashboard [manual]      <!-- Tier 1: [manual] marker, anywhere in the line -->
- [ ] T028 Manually verify the export flow            <!-- Tier 2: keyword in first 4 words -->
- [ ] T029 Hand-test the retry path                   <!-- Tier 2: hand-test keyword -->
### T030 Check production alerts [manual]             <!-- Tier 1, heading grammar -->
```

Not manual:

```markdown
- [ ] T012 rewrite the entire user manual section     <!-- keyword at word 5+ -->
- [ ] T013 add manuals directory                      <!-- "manuals" fails whole-word match -->
```

Keywords: `manual`, `manually`, `hand-test` — case-insensitive, whole-word, first 4 words of the task text only. The `[manual]` marker wins over keywords and never affects checked/unchecked counting.

## Operator resume flow

1. The engine pauses with `waiting-for:manual-validation` + `agent:paused` (and `completed:implement` already granted).
2. Perform the manual verification steps listed in tasks.md.
3. Apply `completed:manual-validation` to the issue.
4. The label monitor enqueues a `continue`; the resolver resumes at `validate` (the gate's `resumeFrom`), which resolves cleanly because `completed:implement` exists.

If the label was applied while automatable tasks still remained, a structured divergence warning appears in the worker log (`reason: 'manual-validation-label-present'`) — the label still wins.

## Verifying the implementation

```bash
pnpm --filter @generacy-ai/orchestrator test -- tasks-md-fallback
pnpm --filter @generacy-ai/orchestrator test -- phase-loop.manual-validation
```

Key fixtures pinned by tests (SC-009):

- Painworth/ai-lawfirm#2723 — "Manually verify …" T028/T029 (keyword tier)
- Painworth/ai-lawfirm#2714 — trailing `[manual]` markers (marker tier)

## Troubleshooting

- **Story paused but tasks look automatable** — check for `waiting-for:manual-validation` on the issue; the label suppresses synthesis unconditionally (Q4=A). Remove it if applied in error, then resume.
- **Manual tasks not detected** — the keyword must land in the first 4 words of the task text; use the `[manual]` marker for reliable classification anywhere in the line.
- **Label read failed** — the engine warns and falls back to tasks.md classification as if the label were absent (never blind re-entry).

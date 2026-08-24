---
"@generacy-ai/orchestrator": patch
---

Teach the `tasks.md` safety net to recognize the heading task grammar (#1192, `workflow:speckit-bugfix`).

The #1187 safety net counted only GitHub-style checkbox task lines (`- [ ] T001`). The implement prompt emits **two** task grammars — checkbox and heading (`### T001` unchecked → `### T001 [DONE]` done). A `tasks.md` written in the heading grammar parsed as zero task lines, so `evaluateTasksMd` returned `{ kind: 'complete', total: 0 }`, the safety net no-op'd, `completed:implement` was granted, and a substantially-unfinished tree advanced into review→remediate — silently reproducing the exact bug #1187 was built to prevent.

The fix is additive and confined to `countTasks`: heading-task detection (`### T001`) with a strict `[DONE]` position (checked only when `[DONE]` immediately follows the task-ID token) and a boundary that rejects range/summary follow-ons (`### T001-T026 remaining`, en-/em-dash variants). Both grammars feed the same `{ unchecked, checked, total }` tally, so mixed-grammar files sum. Checkbox behavior is byte-identical. The phase-loop `complete` branch also gains one log-only `info` line keyed on `total === 0`, so an operator can distinguish "no task lines recognized in either grammar" from a legitimate all-checked advance. All changes are orchestrator-internal (`worker/` surface); no new public exports and no new label vocabulary.

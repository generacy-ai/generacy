---
"@generacy-ai/orchestrator": patch
---

Make the tasks.md safety net manual-task aware (#1214).

The #1187 safety net treated every unchecked task in `tasks.md` as automatable
and re-entered implement over it. Manual-verification tasks (browser checks,
deploy checklists) stay unchecked by design, so the second pass made no
progress and the no-progress guard failed complete-and-green stories with
`failed:implement` + `failed:implement-repeated`.

`countTasks` now also counts the **manual** subset of unchecked tasks, using
two detectors: a position-lenient `[manual]` marker, and whole-word
`manual` / `manually` / `hand-test` within the first four words of the task
text. `unchecked` / `checked` / `total` are unchanged. `TasksMdEvaluation`
gains a `manual-only` variant, and its `incomplete` variant carries the
`automatable` / `manual` split.

The phase loop pauses on the existing `waiting-for:manual-validation` gate —
granting `completed:implement` first so the gate's `resumeFrom: 'validate'`
resolves — whenever the gate label is already on the issue or every remaining
unchecked task classifies manual. Mixed remainders still re-enter, but the
synthesized `tasks_remaining` counts automatable tasks only. The no-progress
guard performs the same check before escalating, covering the case where the
agent emitted `SPECKIT_IMPLEMENT_PARTIAL` over a purely manual remainder.

No new label vocabulary and no new persisted state. The sentinel path is
untouched, so runs that emit `SPECKIT_IMPLEMENT_PARTIAL` behave exactly as
before.

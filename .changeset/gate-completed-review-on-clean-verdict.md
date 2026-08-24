---
"@generacy-ai/orchestrator": patch
---

Grant `completed:review` only on a clean review verdict. The phase loop granted
`completed:review` on every successful review-phase execution — before the
verdict was inspected — so a `changes-required` review (about to remediate and
re-review) was labelled "review completed" while its findings were still open.
That misreported progress (cockpit's `STAGE_COMPLETE_PIPELINE_ORDER` treats
`completed:review` as a stage-complete marker) and set the label-derived-resume
trap the merge-conflict path already carries an explicit-`startPhase` workaround
for (a resume could resolve straight past an open review into `validate`).

The review verdict is now read up front and the grant is gated on it: a
`changes-required` pass clears `phase:review` without granting `completed:review`
(new `LabelManager.onPhaseExecutedWithoutCompletion`), and the clean grant lands
on the converging pass. The cap/remediate/verdict logic keys on the review
sidecar (`verdict` / `remediationCount` / `round`), never on this label, so
withholding it is behavior-safe.

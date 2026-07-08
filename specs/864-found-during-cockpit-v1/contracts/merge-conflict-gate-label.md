# Contract: `waiting-for:merge-conflicts` Gate

Per Q1 clarification: new label pair for merge-conflict pauses, symmetric with existing `waiting-for:*` gates.

## Label pair

| Label | Applied when | Cleared when |
|-------|--------------|--------------|
| `waiting-for:merge-conflicts` | `performBaseMerge` returns `{ ok: false }` before any of implement / pre-validate / validate. | Human resolves the conflict and adds `completed:merge-conflicts` to signal the workflow to resume. |
| `completed:merge-conflicts` | Applied by a human (or the follow-up conflict-resolution subagent when built). | Consumed by the next worker run — treated identically to any other `completed:<gate>` label. |

Both labels follow the standard `waiting-for:<X>` / `completed:<X>` pair and are picked up by cockpit's label-derived gate vocabulary. No cockpit-side changes needed for `cockpit status` / `cockpit watch` to render them (SC-004).

## Gate condition

`GateDefinitionSchema.condition` enum extended with `'on-merge-conflict'`. This value is documentational — the trigger point is not `gateChecker.checkGates` (which evaluates conditions in the *post-phase* branch of the loop) but the *pre-phase* branch where `performBaseMerge` runs. The declaration in `WorkerConfig.gates` documents "this workflow reserves this label for merge-conflict pauses" and allows tests / feature-flag paths to selectively disable it by dropping the entry.

Default entries added to `speckit-feature` and `speckit-bugfix`:

```ts
{ phase: 'implement', gateLabel: 'waiting-for:merge-conflicts', condition: 'on-merge-conflict' },
{ phase: 'validate',  gateLabel: 'waiting-for:merge-conflicts', condition: 'on-merge-conflict' },
```

(Pre-validate does not need its own entry — pre-validate runs inside the `phase === 'validate'` branch of the phase loop, so a pre-validate conflict pauses the validate phase with the same label. See `phase-loop.ts:155–183` for the current pre-validate placement.)

## Trigger semantics

Direct imperative trigger from the phase-loop, not driven by `gateChecker`:

```
if (mergeResult.ok === false) {
  // errorEvidence.mergeConflict → renderer picks the merge-conflict variant
  await labelManager.onGateHit(phase, 'waiting-for:merge-conflicts');
  await stageCommentManager.updateStageComment({ ..., errorEvidence: { mergeConflict: {...} } });
  return { results, completed: false, lastPhase: phase, gateHit: true };
}
```

Mirrors the `on-sibling-review` pattern (`phase-loop.ts:479–495`) where the runtime condition determines whether the gate activates.

## Pairing with #849

The paired resume-dedupe clear (`LabelManager.onGateHit` clears `phase-tracker:<owner>:<repo>:<issue>:resume:merge-conflicts` on successful gate-label application) applies automatically — no additional wiring needed. This is FR-005: "paired with `completed:merge-conflicts`, per the existing pause/resume protocol".

## Resume flow

When the human (or follow-up subagent) resolves the conflict, they push to the feature branch and add `completed:merge-conflicts`. The label-monitor service enqueues a resume job on the resume-label event, and `PhaseLoop` re-enters at the interrupted phase. On re-entry, the pre-phase base-merge runs again — if the human's resolution stuck, it now succeeds cleanly. If not, the pause fires again with the fresh conflicted-paths list.

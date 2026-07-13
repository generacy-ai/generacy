---
"@generacy-ai/orchestrator": patch
"@generacy-ai/workflow-engine": patch
---

Stop the label-op crash-loop and provision missing protocol labels on demand (#889).

Two composing defects made the #864 pre-implement base-merge pause path
crash-loop the worker on repos provisioned before the `waiting-for:merge-conflicts`
label existed:

- **Missing label provisioning.** `gh issue edit --add-label` hard-fails when the
  label doesn't exist, so the pause failed on every pre-#864 repo. Labels the
  orchestrator can apply are now ensured to exist (created on demand) before they
  are applied — generalizing to any future protocol-vocabulary addition, with no
  operator `gh label create` step. A label-protocol audit test fails if a label is
  added to the engine vocabulary without being in the provisioning source of truth.
- **Label-op failure crash-looped the fleet.** After `LabelManager`'s 3-attempt
  retry was exhausted, the error propagated unhandled and `WorkerDispatcher`
  released the item back to `pending`; the next worker re-claimed, hit the same
  missing label, and released again — indefinitely. A label-op failure is now a
  terminal failure of the *individual item* (`agent:error`, left in place, not
  re-queued) with a #865-style alert naming the failing label operation and site
  and including the underlying `gh` error as evidence. The worker keeps processing
  other items — no unhandled throw escapes `ClaudeCliWorker.processItem`.

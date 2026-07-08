---
"@generacy-ai/orchestrator": patch
---

Fix orchestrator resume dedupe stranding legitimate same-gate re-visits (#849).

The ~12h resume dedupe TTL was surviving across a pause, so a second resume
event for the same gate (e.g. the re-review loop after `address-pr-feedback`)
was deduped away and never enqueued. `LabelManager.onGateHit` now invalidates
the paired `resume:<gate>` dedupe key immediately after the pause labels land
on GitHub, via a best-effort worker-mode `PhaseTrackerService.clear` callback.
The clear is one-shot and only runs once the `waiting-for:<gate>` label is
confirmed applied, so a dedupe is never cleared for a pause that didn't
manifest.

---
"@generacy-ai/orchestrator": patch
---

Fix orchestrator resume dedupe stranding issues by keying on in-flight queue state instead of history (#862).

The previous dedupe keyed on `(issue, gate)` history via a phase-tracker key, so
its correctness depended on every pause path routing #849's paired-clear callback,
on no pre-fix keys surviving under the TTL, and on TTL races never landing wrong —
which produced a second live stranding after #849 shipped. Replaces it with a
queue-level idempotency check (`enqueueIfAbsent` keyed on the per-issue queue
itemKey, cleared when the item completes/fails), which is exactly scoped to the
real purpose — collapsing webhook/poll double-enqueue of the same occurrence — and
removes the paired-clear obligations and TTL tuning entirely.

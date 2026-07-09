---
"@generacy-ai/orchestrator": patch
---

Migrate the PR-feedback enqueue to in-flight queue-state dedupe, completing #862 (#879).

The pr-feedback surface still deduped via `PhaseTracker.tryMarkProcessed` (a
`phase-tracker:<owner>:<repo>:<issue>:address-pr-feedback` SET NX with a ~12–24h
TTL), so a stale key from a prior handler era — or any crash-shaped gap between
mark and settle — could silently block the first trusted enqueue after a deploy
and then spontaneously "heal" at TTL expiry. The enqueue now dedupes against
in-flight queue state (`enqueueIfAbsent` on the per-issue itemKey, the same
atomic layer the resume path uses post-#862), which self-clears when the item
completes/fails/is dropped. The `DEDUP_PHASE` / `tryMarkProcessed` usage and
#869 FR-006's clear-on-exit settlement obligations are removed — one dedupe
mechanism across both surfaces, no TTL tuning, and the PhaseTracker machinery
becomes fully deletable as #862 intended.

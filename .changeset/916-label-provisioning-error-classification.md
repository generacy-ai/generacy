---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": patch
---

Fix the two label-provisioning surfaces classifying create-races and real
failures inconsistently, and stop over-long label descriptions failing
provisioning (#916).

- `@generacy-ai/workflow-engine`: add a shared `classifyLabelProvisioningError`
  helper (exported, with the `ProvisioningErrorClassification` type) so
  `LabelManager.ensureRepoLabelsExist` (per-worker ensure-pass) and
  `LabelSyncService.syncRepo` (boot-time bulk sync) distinguish a benign
  `already exists` create-race from a real failure (422/401/403/5xx) from one
  home instead of drifting apart. Shorten the `paused:*` / merge-conflict
  `WORKFLOW_LABELS` descriptions that exceeded GitHub's label-description length
  limit and triggered 422s on create.
- `@generacy-ai/orchestrator`: `LabelSyncService.syncRepo` now catches per-label
  errors — races count as `unchanged` (no longer flip the repo to failed) while
  real failures are logged with cause/status and fail the repo; a `listLabels`
  failure remains fatal for that repo. `LabelManager` records a
  provisioning-failure lineage map and routes all label applies through
  `applyLabels`, so an apply-time 404 on a workflow label is enriched with the
  provisioning cause the operator needs.

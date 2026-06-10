---
"@generacy-ai/config": minor
"@generacy-ai/orchestrator": minor
---

feat(orchestrator): per-repo validate command overrides via .generacy/config.yaml

The validate-phase commands (`validateCommand` / `preValidateCommand`) were
orchestrator-global and monorepo-shaped (`pnpm test && pnpm build`). A single
orchestrator serves many repos, so a single-package repo with a different shape
(e.g. an Astro site with no `test` script) failed validate on every issue —
`pnpm test` exits non-zero before the build runs.

The target repo's `.generacy/config.yaml` `orchestrator` block can now set
`validateCommand` / `preValidateCommand`, which are merged onto the global
worker config per-job before the phase loop runs.

- `@generacy-ai/config`: `OrchestratorSettingsSchema` gains optional
  `validateCommand` / `preValidateCommand`.
- `@generacy-ai/orchestrator`: new pure helper `applyRepoValidateOverrides`
  (preserves an explicit empty `preValidateCommand` = skip install); the worker
  loads the repo's orchestrator settings at the existing per-job config hook and
  passes the merged config to the phase loop. Backward-compatible — repos
  without the block keep the global defaults.

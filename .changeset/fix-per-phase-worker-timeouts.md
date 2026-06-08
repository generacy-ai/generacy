---
"@generacy-ai/orchestrator": minor
---

fix: per-phase worker timeouts so plan/implement aren't killed at 10m

The orchestrator worker applied a single flat `phaseTimeoutMs` (default 10m) to
every CLI phase, so the heavier `plan` and `implement` phases were SIGKILL'd at
the deadline mid-work (the worker never wrote `plan.md`), surfacing as a
`failed:plan` label ~10m after `phase:plan`.

`WorkerConfig` now supports `phaseTimeoutOverrides`, a per-phase map that falls
back to `phaseTimeoutMs` for any phase without an override. `plan` and
`implement` default to 60m; the fallback for the lighter phases is raised to
20m. Overrides are
configurable without code changes via `orchestrator.yaml`
(`worker.phaseTimeoutOverrides`) or env vars: `WORKER_PHASE_TIMEOUT_MS` for the
fallback and `WORKER_PHASE_TIMEOUT_<PHASE>_MS` (e.g. `WORKER_PHASE_TIMEOUT_PLAN_MS`)
per phase.

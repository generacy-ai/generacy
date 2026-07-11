---
"@generacy-ai/orchestrator": patch
---

Fix the orchestrator phase-loop running the pre-phase base-merge twice per
validate cycle (#914). The second call site (between `install` and `validate`,
added in #864) re-ran `git reset --hard` + `git clean -fd` and destroyed the
freshly-installed toolchain, breaking the validate step. The base-merge now
runs at most once per cycle: a block-scoped `hasBaseMergedThisCycle` guard is
set after the single pre-`install` merge, the redundant between-install-and-
validate call site is removed, and the `implement` path is wrapped in the same
guard (symmetry immunization) so a future edit cannot reintroduce a double
merge. The guard re-initializes on every loop iteration, preserving the
existing retry semantics (`i--; continue;`).

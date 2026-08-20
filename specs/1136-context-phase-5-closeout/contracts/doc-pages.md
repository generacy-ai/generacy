# Contract: Docs pages + sidebar wiring

Governs the four new pages, the retroactive wiring of `bugfix-profile-config.md`, and the build gate.

## Pages to create

### 1. `docs/docs/guides/generacy/review-remediate-migration.md` (FR-001, FR-002, FR-005)

Front matter: `sidebar_position` after `configuration`. Required sections:
- **CI trigger** — add `ready_for_review` to the repo `ci.yml` `pull_request` `types`; explain that a **skipped** run reads as SUCCESS in naive rollups, and the merge gate treats `skipped` ≠ `passed`.
- **Slimming `validateCommand`** — narrow to fast checks (lint/format/typecheck/build) for repos whose CI owns the suite; include the single-package and root-config-diff guardrails.
- **Per-workflow config** — copy-pasteable `orchestrator.workflows.speckit-feature` AND `orchestrator.workflows.speckit-bugfix` examples. Link to `../reference/bugfix-profile-config.md` for the full bugfix profile (do not duplicate).
- **Feature flags** — `WORKER_REVIEW_PHASE_ENABLED`, `WORKER_CI_MERGE_GATE_ENABLED`, both default OFF.
- **Gate semantics** — `remediation-limit` (fires at counter cap; inspect surfaced findings; resume with `completed:remediation-limit`, which resets the counter; contrast with the retired `blocked:stuck-feedback-loop` dead-end), relocated post-validate `implementation-review`, and `waiting-for:ci`.

### 2. `docs/docs/reference/review-artifacts.md` (FR-003)

Hybrid contracts reference — see `findings-artifact.md` and `review-marker.md` in this dir for the exact shapes. Required:
- Inline summary of the sidecar shape + a link to `packages/orchestrator/src/worker/review-artifact.ts` (#1124) as source of truth.
- Inline summary of the marker strings + a link to `packages/orchestrator/src/worker/review-poster.ts` (#1125).
- State the generacy-cloud contract-name key: `generacy-engine-review` / `generacy-finding:`.
- State that the artifact is engine-internal and GitHub review state is never source of truth.

### 3. `docs/docs/guides/generacy/review-remediate-rollout.md` (FR-004, FR-005)

Checklist page, repo-agnostic. Required ordered checklist:
1. Publish `@channel` packages.
2. Restart the cluster.
3. Restart the workers.
4. Start a fresh Claude session.

Plus: an explicit callout that **`generacy update` alone is NOT sufficient**; a canary-story step on `<CANARY-REPO>`; a rollback note (flip `WORKER_REVIEW_PHASE_ENABLED` / `WORKER_CI_MERGE_GATE_ENABLED` off to revert to the pre-epic flow).

### 4. `docs/docs/guides/generacy/review-remediate-dogfood.md` (FR-006, FR-007)

Unchecked runbook (GitHub-style `- [ ]` checkboxes). Required:
- Drive one feature story `implement → review ⇄ remediate → validate → final gate → merge` on `<CANARY-REPO>`.
- Drive one bugfix through the same loop under the bugfix profile.
- Record findings and link results back to epic `generacy-ai/generacy#1120`.
- A note that the live run is an operator step performed **after** this PR merges (Q1→C).

## Sidebar wiring (`docs/sidebars.ts`, FR-009)

- Guides → Generacy `items`: `+ 'guides/generacy/review-remediate-migration'`, `+ 'guides/generacy/review-remediate-rollout'`, `+ 'guides/generacy/review-remediate-dogfood'`.
- Reference `items`: `+ 'reference/bugfix-profile-config'` (retroactive), `+ 'reference/review-artifacts'`.

## Acceptance gate

`cd docs && npm ci && npm run build` completes clean with `onBrokenLinks:'throw'`. Every new page is reachable from the rendered sidebar, and every internal link resolves. (SC-007.)

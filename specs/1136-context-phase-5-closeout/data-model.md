# Data Model: Phase-5 closeout

This is a documentation issue — the "entities" are docs pages and the shipped contracts they describe. No runtime types are added.

## Docs page inventory

| Page (id) | Path | Kind | User stories | FRs |
|-----------|------|------|--------------|-----|
| `guides/generacy/review-remediate-migration` | `docs/docs/guides/generacy/review-remediate-migration.md` | Guide | US1, US2 | FR-001, FR-002, FR-005 |
| `reference/review-artifacts` | `docs/docs/reference/review-artifacts.md` | Reference | US3 | FR-003 |
| `guides/generacy/review-remediate-rollout` | `docs/docs/guides/generacy/review-remediate-rollout.md` | Guide (checklist) | US4 | FR-004, FR-005 |
| `guides/generacy/review-remediate-dogfood` | `docs/docs/guides/generacy/review-remediate-dogfood.md` | Runbook (unchecked) | US5 | FR-006, FR-007 |
| `reference/bugfix-profile-config` (existing) | `docs/docs/reference/bugfix-profile-config.md` | Reference | — | FR-009 (wire only) |

## Sidebar wiring (docs/sidebars.ts)

- **Guides → Generacy** `items`: append `review-remediate-migration`, `review-remediate-rollout`, `review-remediate-dogfood` after `guides/generacy/configuration`.
- **Reference** `items`: add a top-level `reference/bugfix-profile-config` entry (retroactive, FR-009) and `reference/review-artifacts`. Both sit at the Reference category root, beside the API/Configuration/CLI sub-categories.

## Documented shapes (mirrored from shipped code — not defined here)

### Findings-artifact sidecar (`ReviewArtifactSchema`, #1124)

Path: `.generacy/review-findings-<sanitized-workflowId>.json` (sanitize: `[^a-zA-Z0-9_-]` → `_`).

| Field | Type | Notes |
|-------|------|-------|
| `findings[]` | array | per-finding records (below) |
| `findings[].severity` | `critical \| major \| minor` | |
| `findings[].file` | string (min 1) | |
| `findings[].line` | int > 0, optional | |
| `findings[].title` | string (min 1) | |
| `findings[].detail` | string (min 1) | |
| `findings[].round` | int ≥ 0 | round the finding was raised |
| `findings[].status` | `open \| resolved` | |
| `verdict` | `clean \| changes-required` | engine-recomputed; agent claim ignored |
| `round` | int > 0 | monotonic review round |
| `lastReviewedCommitSha` | string (min 1) | |
| `remediationCount` | int ≥ 0, default 0 | caps review↔remediate loop (#1128) |

Engine-internal: GitHub review state is **never** the source of truth.

### Engine review marker (`review-poster.ts`, #1125)

| Marker | Format | Purpose |
|--------|--------|---------|
| Body | `<!-- generacy-engine-review round=<N> -->` | tags an engine-posted COMMENT-event review; prefix `generacy-engine-review` |
| Inline | `<!-- generacy-finding:<marker> -->` | tags a per-finding inline comment |

Contract-name key the generacy-cloud mirror matches on: `generacy-engine-review` (body) / `generacy-finding:` (inline). Lets the PR-feedback monitor exclude engine-authored reviews so the engine does not race its own loop.

## Documented flags & gates (mirrored from shipped code)

| Name | Kind | Default | Notes |
|------|------|---------|-------|
| `WORKER_REVIEW_PHASE_ENABLED` | env flag | OFF | gates `review`/`remediate` |
| `WORKER_CI_MERGE_GATE_ENABLED` | env flag | OFF | gates CI-aware merge readiness |
| `waiting-for:remediation-limit` | gate label | — | fires at remediation counter cap; `completed:remediation-limit` resumes and resets the counter |
| `waiting-for:ci` | gate label | — | bounded CI wait → timeout → resumable pause |
| `implementation-review` (relocated) | gate | — | final human approval, post-validate (moved from post-implement) |

## Per-workflow config keys (documented, not defined)

Under `orchestrator.workflows.<name>` in `.generacy/config.yaml`: `maxRemediations`, `review.profile`, `review.blockingSeverity`, `validateCommand`, `ciWaitTimeoutMs`, opt-in `failThenPass`. Full bugfix example lives in `bugfix-profile-config.md` (linked, not duplicated).

## Validation rules

- Every internal doc link must resolve (`onBrokenLinks:'throw'`).
- Every documented field/flag/label/marker must match the cited shipped file (FR-008).
- Checklist/runbook pages must contain no undocumented manual step (SC-003) and use a `<CANARY-REPO>` placeholder (Q3→A).

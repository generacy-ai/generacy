# Tasks: publish-preview race + SHA traceability

**Input**: Design documents from `/specs/749-summary-publish-preview/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/workflow-inputs.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Helper Scripts

- [X] T001 [P] [US2] Create `scripts/stamp-source-sha.mjs` — Node ESM, `node:` builtins only. Reads `git rev-parse HEAD`, iterates `packages/*/package.json`, filters out `private: true` and entries in `.changeset/config.json#ignore`. For each eligible package: append `-<sha7>` to `version` if not already present (idempotent), set `gitHead` to full 40-char SHA, set `generacy.sourceSha` to full 40-char SHA while preserving other `generacy.*` keys. Writes back with `JSON.stringify(pkg, null, 2) + '\n'`. Pattern mirrors existing `scripts/verify-pack-no-workspace-deps.js`. See research.md §"Stamping `gitHead` and version suffix" and contracts/workflow-inputs.md §"Stamping contract" for the full spec.

- [X] T002 [P] [US1] Create `scripts/check-preview-staleness.mjs` — Node ESM, `node:` builtins only. Reads `candidateSha` via `git rev-parse HEAD`. Reads `currentPreviewSha` via `npm view @generacy-ai/generacy@preview gitHead` (anchor package from D7). Decision table from data-model.md §"State transitions":
  - If `currentPreviewSha` is empty or not matching `/^[0-9a-f]{40}$/`: log "No baseline gitHead for ... — publishing unconditionally", exit 0 (D3 fail-open).
  - If `candidateSha === currentPreviewSha`: log republish-allowed message, exit 0.
  - Run `git merge-base --is-ancestor <candidate> <current>`. Exit code 0 (is-ancestor) → log `STALE: candidate <sha> is an ancestor of current preview <sha>` and `Refusing to publish. Set force_rollback=true to override (workflow_dispatch only).`, exit 1. Non-zero (not ancestor) → exit 0.
  Required log messages exactly per contracts/workflow-inputs.md §"Staleness check contract".

## Phase 2: Workflow Wiring

<!-- Phase boundary: T001 and T002 must exist before workflow edits reference them -->

- [X] T003 [US3] Add `workflow_dispatch.inputs.force_rollback` to `.github/workflows/publish-preview.yml`. Edit the `on:` block to declare `force_rollback` as `type: boolean`, `required: false`, `default: false`, with the description from contracts/workflow-inputs.md §"Triggers". The `push: develop` trigger gets no inputs (GitHub does not provide inputs to push events; FR-007).

- [X] T004 [US1] Add a "Resolve origin/develop HEAD" step in `.github/workflows/publish-preview.yml` immediately after `actions/checkout@v6` and before `Install dependencies`. Run `git fetch origin develop` and `git checkout origin/develop`. This is the PRIMARY race defense (D6 / FR-002) — every subsequent step (`pnpm install`, `Build`, `Ensure changesets`, `Version (snapshot)`, stamp, publish) operates on the resolved HEAD, not the event-time ref.

- [X] T005 [US1][US3] Add a "Check preview staleness" step in `.github/workflows/publish-preview.yml` after "Resolve origin/develop HEAD" and before any build step. Runs `node scripts/check-preview-staleness.mjs`. Gate the step with `if: github.event.inputs.force_rollback != 'true'` (string comparison per data-model.md §"Validation" — `type: boolean` inputs arrive as strings `"true"`/`"false"`). Step failure (exit 1) must fail the job (no `continue-on-error`). FR-006: no retry, no self-redispatch.

- [X] T006 [US3] Add a "Log rollback override warning" step in `.github/workflows/publish-preview.yml`, gated by `if: github.event.inputs.force_rollback == 'true'`. Emit the exact warning text from contracts/workflow-inputs.md §"Required log output on rollback override" (lines: `WARNING: force_rollback=true — skipping staleness check.`, `  candidate    = <candidate-sha>`, `  current      = <current-sha>`, `  This is an auditable, deliberate backward publish.`). Resolves SHAs via `git rev-parse HEAD` and `npm view @generacy-ai/generacy@preview gitHead` inside the step.

- [X] T007 [US2] Add a "Stamp source SHA" step in `.github/workflows/publish-preview.yml`. Runs `node scripts/stamp-source-sha.mjs`. Per contracts/workflow-inputs.md §"Ordering", this step MUST run AFTER `Version (snapshot)` (which rewrites `version`) and BEFORE `Verify no workspace protocol leaks in packed tarballs` (so the verify step sees the final manifest) and BEFORE `Publish preview` (so the registry receives stamped manifests).

## Phase 3: Validation (Manual)

<!-- Phase boundary: Phase 2 must complete before validation can run -->

- [ ] T008 [US1][US2] Verify SC-002 on a staging publish: trigger the workflow manually, then run `npm view @generacy-ai/generacy@preview version` (expect `0.0.0-preview-<14d>-<sha7>`), `npm view @generacy-ai/generacy@preview gitHead` (expect 40-char hex matching the workflow's source SHA), and `npm view @generacy-ai/generacy@preview generacy.sourceSha` (same 40-char hex). Document results in PR description.

- [ ] T009 [US3] Verify SC-004 on staging: dispatch the workflow against a deliberately older SHA on a staging fork (or by force-pushing develop backward in a fork). Confirm the job fails with the `STALE: candidate ... is an ancestor of current preview ...` message. Re-dispatch with `-f force_rollback=true`; confirm the job succeeds and the `WARNING: force_rollback=true` log line appears. Document results in PR description.

## Dependencies & Execution Order

**Strict order**:
- T001 and T002 are independent of each other and of every other task — both `[P]` (different files, no shared symbols). Land them first.
- T003 (workflow input declaration) is independent of T004/T005/T007 (which add steps to the same file but in different places); however, all four edit `.github/workflows/publish-preview.yml`, so they cannot be parallelized as a matter of file conflicts. Apply them in a single workflow-edit pass: T003 → T004 → T005 → T006 → T007.
- T005 depends on T002 (script must exist before the workflow step calls it).
- T007 depends on T001 (script must exist before the workflow step calls it).
- T006 depends on T003 (the `force_rollback` input must exist for the conditional to be meaningful).
- T008 and T009 depend on Phase 2 being merged and a publish having run. T008 only needs one successful publish; T009 needs an additional dispatch-with-older-SHA run.

**Parallel opportunities**:
- T001 [P] and T002 [P] in Phase 1 — different files, no shared symbols.
- T008 and T009 can be performed in parallel after Phase 2 lands (they exercise different paths through the workflow and don't share state).

**Critical path**:
T001 + T002 (parallel) → T003 → T004 → T005 → T006 → T007 → T008 + T009 (parallel)

---

*Generated by speckit*

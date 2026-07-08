# Feature Specification: Fresh single-package repos survive validate; failed phases post their evidence to the issue

**Branch**: `847-found-during-cockpit-v1` | **Date**: 2026-07-08 | **Status**: Draft
**Source**: [generacy-ai/generacy#847](https://github.com/generacy-ai/generacy/issues/847) — cockpit v1 integration smoke test finding #15, observed on `christrudelpw/sniplink#2`/`#3` `failed:validate`.

## Summary

Two orthogonal but co-manifesting gaps caused every fresh single-package project in the cockpit v1 smoke test to `failed:validate` on its first issue with no self-service diagnostic path.

**Gap A — Monorepo-shaped default `preValidateCommand` kills single-package repos before `validateCommand` runs.**
`packages/orchestrator/src/worker/config.ts:59` defaults `preValidateCommand` to `pnpm install && pnpm -r --filter './packages/*' build`. On a repo without a `packages/` directory (e.g. a scaffolded single-package Next.js app — arguably the most common shape for new users), `pnpm -r --filter './packages/*'` matches zero projects and exits non-zero, `phase-loop.ts:161` records "Pre-validate install failed", and the phase stops before `runValidatePhase` (line 179) ever executes. The per-repo `orchestrator.{validateCommand,preValidateCommand}` override *is* honored by `mergeWorkerConfigWithOverrides` (`config.ts:100`), but nothing populates it: a staging-created project arrives with a bare `.generacy/config.yaml`, so every fresh single-package project fails validate on its first issue.

**Gap B — `failed:<phase>` posts no diagnostic evidence to the issue.**
When the pre-validate install (or any phase) fails, `phase-loop.ts` calls `stageCommentManager.updateStageComment({ status: 'error', ... })`. `StageCommentManager.renderStageComment` (`stage-comment-manager.ts:119`) renders the progress table and a `**Status**: ❌ Error` line, but does not include the failing command, exit code, or stderr — even though `PhaseResult.error` (`cli-spawner.ts:247`) already carries `{ message, stderr, phase }` and the process's `resolvedExitCode`. The developer reviewing the failed issue on GitHub — or through the cockpit's `failed:*` actionable classification — sees only "validate ❌ error" and must `docker exec` into a worker container to answer "failed HOW?"

Both gaps are P0 for first-run trust: the first issue on a fresh project fails, and there is no self-service way to see why.

## User Stories

### US1 — First issue on a fresh single-package project reaches `validate` (Gap A)

**As a** developer whose staging-created project is a single-package repo (Next.js/Astro/Vite scaffold),
**I want** `preValidateCommand` to not require a `packages/` directory,
**So that** my first speckit issue reaches `validateCommand` and either passes or fails on my *actual* test/build.

**Acceptance Criteria**:
- [ ] A fresh single-package repo with no `.generacy/config.yaml` `orchestrator` block succeeds through the pre-validate step (or skips it cleanly) on its first `phase:validate` run.
- [ ] The existing behavior for monorepos (repos that *do* have `packages/`) is unchanged — `pnpm -r --filter './packages/*' build` still runs.
- [ ] The per-repo `orchestrator.{validateCommand,preValidateCommand}` override still takes precedence when set (regression guard on `mergeWorkerConfigWithOverrides`).
- [ ] Repro path: scaffold a Next.js template, run one issue through speckit — validate reaches the repo's own `npm test && npm run build` (or equivalent) without a hardcoded per-repo override.

### US2 — Failed phase surfaces its own evidence on the issue (Gap B)

**As a** developer reviewing a `failed:validate` (or any `failed:<phase>`) label on a GitHub issue,
**I want** the failing command, its exit code, and the tail of stderr posted to the issue,
**So that** I can diagnose the failure from GitHub or the cockpit without `docker exec` into the worker.

**Acceptance Criteria**:
- [ ] When a phase fails, the failing command string, the resolved exit code, and a bounded stderr tail are visible on the GitHub issue (either in the stage comment or a dedicated error comment).
- [ ] The stderr tail is bounded (~last 30 lines, hard character cap) so a failed phase cannot post a multi-megabyte comment.
- [ ] Timeouts and aborts are surfaced with their distinct message (`Phase "…" timed out after Nms` / `Phase "…" was aborted`) — this evidence already exists in `PhaseResult.error.message` and just needs to reach the issue.
- [ ] Successful phases are unchanged — no evidence block is appended on `status: 'complete'`.
- [ ] The cockpit's `failed:*` actionable classification continues to work; the added text is inside the same comment the cockpit already reads or a sibling comment it can find.

### US3 — Staging-created projects arrive pre-configured for their actual shape (Gap A, stronger fix)

**As a** developer whose project is created via the cloud staging flow,
**I want** the scaffolder/cloud project-creation to write a project-appropriate `orchestrator` block at creation time,
**So that** my `.generacy/config.yaml` reflects the template's package manager and scripts from day one and I never depend on the orchestrator's monorepo-shaped defaults.

**Acceptance Criteria**:
- [ ] For each staging template, the emitted `.generacy/config.yaml` contains an `orchestrator` block with template-appropriate `validateCommand` and `preValidateCommand` (or an explicit empty `preValidateCommand` meaning "skip install").
- [ ] The block is authored by the cloud project-creation / template flow, not by the orchestrator at runtime.
- [ ] Existing projects (no template rewrite) are not disrupted — the orchestrator's default still degrades safely per US1.

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                                                                     | Priority | Notes                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| FR-001 | The default `preValidateCommand` MUST NOT hard-fail on a repo without a `packages/` directory. The `pnpm -r --filter './packages/*' build` half MUST only run when a `packages/` directory exists at the workspace root; otherwise, skip it.    | P0       | `config.ts:59` + `phase-loop.ts` or wrapper shell               |
| FR-002 | The per-repo `orchestrator.{validateCommand,preValidateCommand}` override in `.generacy/config.yaml` MUST continue to take precedence over the default. An explicit empty `preValidateCommand` MUST be preserved as "skip install".              | P0       | Regression guard on `mergeWorkerConfigWithOverrides`            |
| FR-003 | When a phase fails (including pre-validate install), the GitHub-visible failure surface MUST include: the failing command string, the resolved exit code, and a bounded tail of stderr.                                                          | P0       | Data already in `PhaseResult.error` (`cli-spawner.ts:247`)      |
| FR-004 | The stderr tail posted to the issue MUST be bounded: at most ~30 lines AND a hard character cap (proposed: 4 KiB), whichever comes first. Longer output MUST be truncated with a "… truncated" marker.                                          | P0       | Prevents multi-MB comments from a runaway process               |
| FR-005 | Timeout and abort failures MUST surface their distinct top-level message (`Phase "…" timed out after Nms` / `Phase "…" was aborted`) — not a generic "Error".                                                                                    | P1       | Already in `PhaseResult.error.message`                          |
| FR-006 | The cockpit's `failed:*` classification MUST continue to detect the failure. Whether the evidence lives in the stage comment or a dedicated error comment is an implementation choice, but the classification pipeline MUST NOT regress.        | P0       | See `cockpit` watch/status                                     |
| FR-007 | Successful phase completions MUST NOT gain a diagnostic evidence block. The evidence surface is exclusively for `status: 'error'` transitions.                                                                                                   | P1       | Keep the happy-path comment clean                              |
| FR-008 | Documentation MUST call out the new degrade behavior and per-repo override so template authors can set the block explicitly if they want to override the auto-detection.                                                                        | P2       | `docs/docs/getting-started/configuration.md`                    |
| FR-009 | (Optional / decouplable) The cloud staging project-creation SHOULD emit a template-appropriate `orchestrator` block in `.generacy/config.yaml`. This is a strictly additive fix and does not depend on FR-001–FR-008 landing first.              | P2       | Companion issue in `generacy-cloud` — out of scope for this PR |

## Success Criteria

| ID     | Metric                                                                                     | Target                                        | Measurement                                                                     |
| ------ | ------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------- |
| SC-001 | First issue on a fresh single-package repo (no `orchestrator` override) reaches `validate` | 100% (0% pre-validate false-failures)         | Repro on Next.js scaffold; assert `phase:validate` runs the repo's real command |
| SC-002 | Every `failed:<phase>` issue surface answers "failed HOW?" without a `docker exec`         | 100% of failure comments contain cmd + code + stderr tail | Inspect a failed-validate comment produced end-to-end                            |
| SC-003 | Monorepo repos (with a `packages/` directory) show no behavior change                      | 0 regressions                                 | Existing `phase-loop.test.ts` + one integration monorepo run                    |
| SC-004 | Stderr tail hard-cap holds under adversarial output                                        | ≤ 4 KiB per comment even for GB-scale stderr | Fuzz test: pipe 100 MB of stderr through a synthetic failing phase              |
| SC-005 | Per-repo override precedence preserved                                                     | 0 regressions                                 | `packages/orchestrator/src/worker/__tests__/config.test.ts` extended            |

## Assumptions

- The GitHub App token wired into `StageCommentManager` has `issues: write` on target repos (unchanged from today).
- Existing `PhaseResult.error.stderr` capture in `cli-spawner.ts` is representative of the real failure (i.e. the failing command is `sh -c` and its stderr is what we want to show). No investigation of stderr fidelity across the shell layer is in scope.
- The cockpit reads stage comments (not the issue body) to classify `failed:*`. Adding text to the same comment or a marker-tagged sibling comment does not break its parser. Verified by reading `packages/cockpit`.
- Staging-created projects will not be retroactively edited to add an `orchestrator` block. FR-009 covers new projects only.
- No behavior change is required for phases that already emit their own evidence surface (e.g. `implement` retries) — the change is limited to `error` transitions from `phase-loop.ts`.

## Out of Scope

- Cloud staging changes to write template-appropriate `orchestrator` blocks (FR-009). Tracked as a companion issue in `generacy-cloud`. Land the orchestrator-side degrade first so the cloud change can be additive.
- Retrofitting existing projects with an `orchestrator` block. Users can manually add one; the degrade behavior in FR-001 catches the common case.
- Rewriting stderr capture to interleave with stdout, add ANSI stripping, or normalize line endings — evidence is posted as-is (with a 4 KiB / 30-line cap).
- New per-phase timeout tuning. Existing `DEFAULT_INSTALL_TIMEOUT_MS` and `DEFAULT_VALIDATE_TIMEOUT_MS` are unchanged.
- Cockpit UI changes to render the new evidence block differently — the block is plain markdown; the cockpit's existing renderer picks it up as-is.
- Multi-package-manager detection (npm/yarn/bun). Auto-degrade in FR-001 stays pnpm-shaped; other managers still need a per-repo override (or FR-009 template block).

---

*Generated by speckit*

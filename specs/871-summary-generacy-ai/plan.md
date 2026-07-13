# Implementation Plan: Close the orchestrator + generacy CI test-coverage blind spot

**Feature**: Wire `@generacy-ai/orchestrator` and `@generacy-ai/generacy` into the CI merge gate, remediate the 18 pre-existing orchestrator + 36 pre-existing generacy test failures, and stand up a blocking `integration` job with a real Redis service container for tests that legitimately need ambient infra.
**Branch**: `871-summary-generacy-ai`
**Date**: 2026-07-09
**Spec**: [spec.md](./spec.md)
**Status**: Complete

## Summary

Two-part remediation:

1. **CI wiring (Q5 = A + C)** — drop the two `--filter '!'` exclusions on `@generacy-ai/orchestrator` and `@generacy-ai/generacy` from `.github/workflows/ci.yml`'s `Test (packages)` step, and add a new **blocking** `integration` job with `services: redis:` that runs the `*.integration.test.ts` glob via a new `vitest.integration.config.ts`. No `continue-on-error`, no nightly cron.
2. **Test remediation** — before the CI gate flips green, land the following in the same PR (or a stack merged together):
   - **Group A (7 tests, 3 files)** — Redis-dependent relay tests → rename to `*.integration.test.ts` and run against real Redis in the new integration job. No hand-mocked ioredis.
   - **Group B (`health-code-server` suite)** — provide missing `auth` block in the test config fixture.
   - **Group C (7 activation tests, 2 files)** — add `cloud_url` to approved-response fixtures (matches #517 schema).
   - **Group D (4 webhook-setup-service tests)** — refresh HTTP mock expectations.
   - **Generacy suite (36 failures, 15 files)** — mock/CLI-assertion drift; fix in place using the same per-group treatment.

The design choice at every step is "no invisible convention": every excluded test surfaces via a filename suffix (`.integration.test.ts`) that is greppable and blocking, and there is no per-suite env-var opt-in that renders as green-when-skipped.

## Technical Context

**Language/Version**: TypeScript (Node.js ≥22).
**Primary Dependencies**: `vitest` (test runner, already pinned across packages), `ioredis` (real Redis client for integration tests), GitHub Actions `services:` block (Redis service container).
**Storage**: N/A — this feature only touches test config, CI YAML, test fixtures/mocks, and test filenames.
**Testing**: `vitest run` for unit; new `vitest.integration.config.ts` for integration (glob `**/*.integration.test.ts`).
**Target Platform**: GitHub-hosted `ubuntu-latest` runners; local reproduction via `docker run --rm -p 6379:6379 redis`.
**Project Type**: Monorepo — pnpm workspaces; changes span `.github/workflows/ci.yml`, root `vitest.config.ts` / new `vitest.integration.config.ts`, `packages/orchestrator/**`, `packages/generacy/**`.
**Performance Goals**: Integration job should not materially extend the merge-gate critical path — the Group A rename is 7 tests behind a Redis service container, all localhost, expected sub-minute.
**Constraints**: (1) No `continue-on-error: true`, (2) no scheduled/nightly runner as the only home for tagged tests, (3) no env-var-gated `skipIf` inside test files (Q2 rejected A explicitly), (4) no test file that is genuinely infra-bound stays in the default unit suite.
**Scale/Scope**: ~54 tests to fix (18 orchestrator + 36 generacy), 22 files touched in test code, 1 CI YAML, 2 vitest configs, 2 package `test:integration` scripts.

## Constitution Check

*Gate: no `.specify/memory/constitution.md` file present in this repo (`.specify/memory/` does not exist; only `.specify/templates/` does). No constitution gates apply.*

## Project Structure

### Documentation (this feature)

```text
specs/871-summary-generacy-ai/
├── spec.md                 # Feature specification (already exists)
├── clarifications.md       # Q1–Q5 answers (already exists)
├── plan.md                 # This file
├── research.md             # Phase 0 — decisions + rationale
├── data-model.md           # Phase 1 — N/A per feature (test/CI-only, no runtime entities)
├── quickstart.md           # Phase 1 — how to run + verify the new gates locally
├── contracts/
│   └── ci-jobs.md          # CI job shape (input trigger → services → command → block-on-fail)
├── checklists/             # (populated by /speckit.checklist if requested)
└── tasks.md                # Populated by /speckit.tasks (NOT this command)
```

### Source Code (repository root)

Only these paths are touched by this feature. All source-code paths are absolute from repo root.

```text
.github/
└── workflows/
    └── ci.yml                                    # MODIFIED — drop 2× --filter '!'; add integration job

vitest.config.ts                                  # MODIFIED — add exclude for **/*.integration.test.ts
vitest.integration.config.ts                      # NEW — include only **/*.integration.test.ts

packages/orchestrator/
├── package.json                                  # MODIFIED — add "test:integration" script
├── vitest.config.ts                              # MODIFIED — exclude **/*.integration.test.ts from unit
├── src/
│   ├── __tests__/
│   │   ├── relay-integration.test.ts             # RENAME → relay-integration.integration.test.ts (Group A)
│   │   ├── server-relay-routes.test.ts           # RENAME → server-relay-routes.integration.test.ts (Group A)
│   │   └── health-code-server.test.ts            # MODIFIED — add valid `auth` block to config fixture (Group B)
│   ├── activation/
│   │   └── __tests__/
│   │       ├── poller.test.ts                    # MODIFIED — add `cloud_url` to approved-response fixture (Group C)
│   │       └── activate.test.ts                  # MODIFIED — add `cloud_url` to approved-response fixture (Group C)
│   └── services/
│       └── __tests__/
│           ├── relay-bridge.test.ts              # RENAME → relay-bridge.integration.test.ts (Group A)
│           └── webhook-setup-service.test.ts     # MODIFIED — refresh HTTP mock expectations (Group D)

packages/generacy/
├── package.json                                  # MODIFIED — add "test:integration" script (matching orchestrator)
├── vitest.config.ts                              # MODIFIED — exclude **/*.integration.test.ts from unit
└── src/                                          # MODIFIED — fix 36 failures across 15 files (mock/CLI-assertion drift)
                                                  # Exact file list captured in tasks.md; primary offenders known from Q4 baseline:
                                                  # - "No lifecycleAction export is defined on the mock" (×5 files)
                                                  # - CLI-output string drift (init, validate, placeholders, destroy, workspace-setup)
                                                  # - "AgentLauncher is not a constructor" (mocked constructor no longer exists)
```

**Structure Decision**: This is a CI + test-code change only — no new runtime source, no new packages, no new domain code. The two "structural" additions are (1) a root `vitest.integration.config.ts` sibling of `vitest.config.ts`, and (2) a filename suffix convention (`*.integration.test.ts`) recognized by both configs. Both are explicitly chosen over env-var-gated `skipIf` (Q2 answer C) so the convention is visible in git-grep and in file listings, and impossible to silently un-run.

## Phased Approach

- **Phase 0 (research.md)** — pin every decision to the clarification that produced it and record the alternatives so future contributors don't re-litigate.
- **Phase 1 (contracts/, data-model.md, quickstart.md)** — freeze the CI job shape and the local-reproduction commands. No runtime data model (see below).
- **Phase 2 (tasks.md, produced by `/speckit.tasks`)** — decompose into one task per file for the 22 test-file remediations, plus 4 config/CI tasks. Group A files (rename) sequenced before the integration job flips blocking; Group B/C/D and generacy fixes are parallelizable per file.

## Complexity Tracking

No constitution violations to justify (no constitution file). The two "extras" beyond the minimum are:

| Choice | Why Needed | Simpler Alternative Rejected Because |
|--------|------------|--------------------------------------|
| New `vitest.integration.config.ts` + filename suffix | Group A tests legitimately need Redis; they must run *somewhere blocking*, and the convention must be greppable so future contributors don't reinvent it | Q2 = C explicitly rejects env-var `skipIf` inside files — it renders as green/skipped in every default run, i.e. the invisible-convention failure mode this whole issue is about |
| Separate blocking `integration` CI job with `services: redis` | Group A tests need a service container the unit job doesn't; adding `services:` to the base `ci` job would slow every PR unnecessarily | Q3 = C explicitly rejects both `continue-on-error: true` (rebuilds the blind spot with a green checkmark on top) and nightly cron (rot on a delay); a separate blocking job is the smallest addition that satisfies both |

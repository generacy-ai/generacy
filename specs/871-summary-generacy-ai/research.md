# Research: Close the orchestrator + generacy CI test-coverage blind spot

**Feature**: 871 | **Date**: 2026-07-09

Every decision below is pinned to a clarification (Q1–Q5 in [clarifications.md](./clarifications.md)) and to the observed state of the repo at develop `33c9f11`.

## Decision 1 — Test-fix strategy: fix-in-place except for infra-bound tests

**Choice**: Group A (Redis-dependent, 7 tests / 3 files) moves behind the `*.integration.test.ts` convention. Groups B (config), C (activation `cloud_url`), D (webhook HTTP mocks) are fixed in the default unit suite because they are pure schema/mock/HTTP-mock drift. Generacy's 36 failures are the same category as B/C/D and land the same way.

**Rationale** (Q1 answer B):
- Groups B/C/D and generacy failures are already unit tests that never needed ambient infra; the failures are literally "the test fixture doesn't match the schema/mock signature the code now uses." No runtime infra required — just refresh the fixture.
- Group A is genuinely ioredis-dependent: the failures are `ECONNREFUSED 127.0.0.1:1` from a real ioredis client. Hand-mocking ioredis pub/sub would recreate the most-recurrent defect class the cockpit smoke test has surfaced (#800, #826, #836, #853, #855, #861 — "tests encode the code's assumptions"). A service-container Redis is cheap and deterministic, so use the real thing.

**Alternatives rejected**:
- **Q1 = A (fix all 18 in place with deep ioredis mocks)** — rebuilds the defect class listed above. Deep pub/sub mocks mirror what the code expects, not what Redis actually does.
- **Q1 = C (tag all 18)** — introduces unnecessary integration-runner surface for tests that need no infra.
- **Q1 = D (case-by-case per group across separate PRs)** — increases coordination cost and delays the CI-wiring flip. Bundled per Q4 = B.

## Decision 2 — Integration tag mechanism: filename suffix

**Choice**: `*.integration.test.ts` filename convention. Default `vitest.config.ts` excludes the glob; new `vitest.integration.config.ts` includes only that glob.

**Rationale** (Q2 answer C):
- Visible in the filename and in `git grep '\.integration\.test\.ts'`.
- Impossible to accidentally re-add to the unit run without either renaming the file or editing both configs.
- Mirrors the standard vitest / jest community pattern (e.g., `@testing-library` docs, pnpm workspaces).

**Alternatives rejected**:
- **Q2 = A (`describe.skipIf(!process.env.RUN_INTEGRATION)`)** — renders as green/skipped in every default run. This is the exact "invisible convention" failure mode that produced the current blind spot.
- **Q2 = B (separate vitest config, matched by directory not filename)** — works, but directory-based selection is easier to accidentally bypass (drop a file in the wrong folder → runs in unit suite silently). Filename suffix is greppable per-file.

## Decision 3 — Integration runner home: PR-triggered blocking job with `services: redis`

**Choice**: A new `integration` job in `.github/workflows/ci.yml` that:
- Triggers on the same events as the existing `ci` job (`pull_request` + `push` to `develop`/`main`).
- Declares `services: redis:` (health-checked service container on `localhost:6379`).
- Runs `pnpm -r --if-present run test:integration` (each package's script points at `vitest --config vitest.integration.config.ts run` or equivalent).
- **Blocks merge on failure**. No `continue-on-error`.

**Rationale** (Q3 answer C):
- Non-blocking (Q3 = B) is sanctioned invisibility — this issue exists because red-that-doesn't-block rots. `continue-on-error: true` rebuilds the blind spot with a green checkmark on top.
- Nightly (Q3 = A) is the same rot on a delay, discovered only after the regression already landed on develop.
- GitHub-hosted `services: redis:` runs on the same runner over localhost — deterministic, low-latency, no cross-network flake surface.

**Alternatives rejected**:
- **Q3 = A (nightly cron)** — regressions land on `develop` before anyone sees the failure.
- **Q3 = B (`continue-on-error: true`)** — the failure surface is dishonest ("green checkmark, but not really green").

**Flake-handling policy**: If a specific integration test proves flaky after merge, quarantine that single test with an explicit `it.skip` + issue link, not a job-wide `continue-on-error`. This is written into the plan so a future contributor doesn't reach for the wrong tool.

## Decision 4 — Generacy suite baseline: in-scope, fix in place

**Choice**: The 36 pre-existing generacy failures across 15 files are in scope for this issue and land alongside the CI-wiring flip.

**Rationale** (Q4 answer B, with measured data):
- Ran on develop `33c9f11` after `pnpm --filter '@generacy-ai/generacy...' build && pnpm --filter @generacy-ai/generacy test`: **36 failed | 1692 passed | 4 skipped (1732)**.
- Every failure category identified is mock/CLI-assertion drift — no ambient-infra dependency:
  - `[vitest] No "lifecycleAction" export is defined on the mock` (×5)
  - Expected CLI output string drift (init, validate, placeholders, destroy, workspace-setup)
  - `AgentLauncher is not a constructor` (a mocked constructor that no longer exists in the source)
- Wiring the gate while red (Q4 = C) forces day-one exclusions — the exact pattern this issue is removing.

**Alternatives rejected**:
- **Q4 = A (suite already green)** — falsified by the baseline run.
- **Q4 = C (fix in follow-up)** — the CI gate cannot flip green without also fixing these; deferring means either (i) the merge gate stays broken (regression) or (ii) generacy gets a "temporary" exclusion that lives forever.
- **Q4 = D (unknown — treat as explicit task)** — resolved during clarify. State was measured.

**Escape hatch**: If any of the 36 turn out to be genuinely infra-bound (unexpected — none appeared in the baseline analysis), that specific file moves behind the `*.integration.test.ts` convention rather than blocking this issue.

## Decision 5 — CI wiring shape: drop exclusions in existing step + new blocking integration job

**Choice** (Q5 answer A + C combined):
1. Drop the two `--filter '!@generacy-ai/orchestrator' --filter '!@generacy-ai/generacy'` exclusions from `.github/workflows/ci.yml`'s existing `Test (packages)` step. The two unit suites are green after Decisions 1–4 land and need no services.
2. Add a new **blocking** `integration` job with `services: redis:` that runs the `*.integration.test.ts` glob via `vitest.integration.config.ts`.

**Rationale**:
- Don't give the core packages their own special unit step (Q5 = B). Special-casing is exactly how the exclusion crept in in the first place. One honest gate for all packages, one explicit integration job for tests that need infra.
- Don't defer to the implementer (Q5 = D). The shape is exactly determined by Q1–Q4 answers.

**Alternatives rejected**:
- **Q5 = A alone (no integration job)** — Group A tests remain broken; there is nowhere for them to run.
- **Q5 = B (dedicated `Test (orchestrator + generacy)` step)** — special-cases the two packages instead of un-special-casing them; keeps the "these two are different" pattern alive.
- **Q5 = C alone (dedicated `test-core` job)** — asymmetric treatment; the whole point is symmetry.

## Implementation Patterns

- **`vitest.config.ts` exclude glob**: The default config gains `exclude: ['**/*.integration.test.ts']` alongside its existing `include`. This is layered on top of vitest's default excludes (`node_modules`, `dist`, `.idea`, `.git`, `.cache`).
- **`vitest.integration.config.ts`**: A sibling config with `include: ['**/*.integration.test.ts']` and the same `environment: 'node'` / `testTimeout` as the unit configs. Kept at repo root (root config) and referenced by each package via `--config`.
- **Package `test:integration` script**: Each package adds `"test:integration": "vitest --config ../../vitest.integration.config.ts run"` (or a package-local variant if that package has integration tests). `pnpm -r --if-present run test:integration` iterates packages, skipping those without the script.
- **CI `services: redis:` block**:
  ```yaml
  services:
    redis:
      image: redis:7
      ports: ['6379:6379']
      options: >-
        --health-cmd "redis-cli ping"
        --health-interval 10s
        --health-timeout 5s
        --health-retries 5
  ```
- **Test-side Redis URL**: Existing orchestrator code already reads from `REDIS_URL` (or default `redis://127.0.0.1:6379`). Group A tests connect to the default; no env-var wiring changes required in test code.

## Key References

- **Q1–Q5 clarifications**: [`specs/871-summary-generacy-ai/clarifications.md`](./clarifications.md)
- **CI file to modify**: `.github/workflows/ci.yml` (current: `Test (packages)` step on line ~52-53)
- **Root vitest config to modify**: `vitest.config.ts` (repo root)
- **New root vitest config**: `vitest.integration.config.ts` (repo root)
- **Prior art on `*.integration.test.ts` in this repo**: none — this is the introducing PR. Convention documented in `contracts/ci-jobs.md`.
- **#517 (cloud_url schema)**: the schema drift that produces Group C failures — approved-response fixtures need `cloud_url` added.
- **#586 (code-server route wiring)**: producer of some Group A test fixtures — no code change needed here, only the rename.
- **`services: redis:` GitHub Actions docs**: <https://docs.github.com/en/actions/using-containerized-services/creating-redis-service-containers>

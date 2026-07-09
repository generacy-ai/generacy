# Feature Specification: Close the orchestrator + generacy CI test-coverage blind spot

**Branch**: `871-summary-generacy-ai` | **Date**: 2026-07-09 | **Status**: Clarified

## Summary

The `@generacy-ai/orchestrator` test suite (~1980 tests) **never runs in CI**, and as a
result 18 tests across 7 files are currently red on `develop` with nobody noticing.
`@generacy-ai/generacy` is excluded from CI test runs the same way. This is two problems —
a CI coverage blind spot (the root cause) and the accumulated red tests it has been hiding.

Surfaced while remediating PR #870 (fix #869): the PR's own new regression test
(`M1: enqueues when unresolved thread has a cluster-identity comment`) was also failing
locally, but that turned out to be a stale `packages/workflow-engine/dist` (fixed by a
rebuild) — unrelated to the 18 below, which are pre-existing.

## 1. Root cause — orchestrator + generacy test suites are excluded from CI

`.github/workflows/ci.yml` runs tests in two steps:

```yaml
- name: Test (root)
  run: pnpm test            # root vitest — vitest.config.ts include: ['tests/**/*.test.ts']

- name: Test (packages)
  run: pnpm -r --filter '!@generacy-ai/orchestrator' --filter '!@generacy-ai/generacy' run --if-present test
```

- `Test (root)` (`vitest run` at repo root) only globs `tests/**/*.test.ts`, so it never
  picks up package `src/**/*.test.ts`.
- `Test (packages)` **explicitly excludes** `@generacy-ai/orchestrator` and
  `@generacy-ai/generacy`.

Net effect: `pnpm --filter @generacy-ai/orchestrator test` (1980 tests) and the
`@generacy-ai/generacy` suite are never executed by the merge gate. Any regression in
these two core packages is invisible to CI and can rot indefinitely. (This is exactly why
the #869/#870 regression only showed up in a local run.)

## 2. Symptom — 18 currently-failing orchestrator tests (develop @ 33c9f11)

Repro (rebuild workflow-engine first so its dist isn't stale, then run the suite):

```bash
pnpm --filter @generacy-ai/workflow-engine build
pnpm --filter @generacy-ai/orchestrator test
# => Test Files 7 failed | 125 passed (132)
#         Tests 18 failed | 1960 passed | 2 skipped (1980)
```

Grouped by apparent root cause — all read as integration tests running without their
dependencies wired up (no Redis, no code-server, no HTTP/cloud endpoints), or with mocks
that have drifted:

**A. No Redis available — `[ioredis] Error: connect ECONNREFUSED 127.0.0.1:1`**
- `src/services/__tests__/relay-bridge.test.ts` (4): decorate sseManager.broadcast to forward events on connect; send metadata on connect; send metadata periodically; handle metadata collection errors gracefully
- `src/__tests__/relay-integration.test.ts` (1): should forward SSE broadcast events through relay
- `src/__tests__/server-relay-routes.test.ts` (2): passes /control-plane and /code-server routes to relay client; wires onStatusChange to trigger sendMetadata on running (#586)

**B. Missing/invalid config — `ZodError: [ "auth" ] Required`**
- `src/__tests__/health-code-server.test.ts` (suite): `GET /health — codeServerReady` (throws during suite setup while parsing config)

**C. Activation client — `ActivationError: Invalid poll response: [ "cloud_url" ] Required`**
- `src/activation/__tests__/poller.test.ts` (3): returns approved response after pending; increases interval by 5s on slow_down; caps interval at 60s maximum
- `src/activation/__tests__/activate.test.ts` (4): full happy path: device-code -> poll -> approved -> persisted; slow_down path increases poll interval; expired + auto-retry path; API key never appears in log output

**D. Webhook HTTP mocks**
- `src/services/__tests__/webhook-setup-service.test.ts` (4): list webhooks for a repository successfully; reactivate inactive webhooks and merge events; reactivate inactive webhook without changing events when issues already included; build correct PATCH request with active flag and merged events

None of these 7 files were modified by #870, and none exercise the #869 PR-feedback/trust
code paths — they are pre-existing, not a regression from that PR.

## Resolution (post-clarification)

Per Q1–Q5 in `clarifications.md`:

1. **CI wiring** — remove the two `--filter '!'` exclusions from the existing
   `Test (packages)` step in `.github/workflows/ci.yml` so orchestrator + generacy run
   on the same footing as every other package. Add a new **blocking** `integration` job
   with `services: redis` that runs the `*.integration.test.ts` glob via a new
   `vitest.integration.config.ts`.
2. **Group A (Redis-dependent relay tests, 7 tests across 3 files)** — rename the
   affected files to `*.integration.test.ts` and run them against a real Redis in the
   new integration job. Do not hand-mock ioredis.
3. **Groups B / C / D (11 tests across 4 files)** — fix in place. All three are
   mock/schema/HTTP-mock drift (Zod `auth` required, activation-poll `cloud_url`
   required, webhook HTTP-mock drift). No ambient-infra dependency.
4. **`@generacy-ai/generacy` suite baseline (36 failed / 15 files)** — measured on
   develop @ 33c9f11 after fresh dependency-graph build. All failures are mock/CLI
   assertion drift; fix in place before enabling the CI gate for that package.

## User Stories

### US1: Merge-gate visibility for orchestrator + generacy regressions

**As a** contributor merging PRs against `develop`,
**I want** the orchestrator + generacy unit test suites to run on every PR the same way
every other package's suite does,
**So that** regressions in the two largest core packages are caught before merge instead
of rotting silently on `develop`.

**Acceptance Criteria**:
- [ ] `.github/workflows/ci.yml`'s `Test (packages)` step no longer contains
      `--filter '!@generacy-ai/orchestrator'` or `--filter '!@generacy-ai/generacy'`.
- [ ] A red test in either package fails the PR check.
- [ ] `pnpm --filter @generacy-ai/orchestrator test` and
      `pnpm --filter @generacy-ai/generacy test` both exit 0 on a clean checkout after
      `pnpm -r build`, with no ambient infrastructure.

### US2: Infra-dependent tests keep gating merges without lying green

**As a** contributor,
**I want** the Redis-dependent relay tests to run against a real Redis in CI on every
PR,
**So that** we don't rebuild the same "invisible green" blind spot with `continue-on-error`
or a nightly cron that only reports rot after the fact.

**Acceptance Criteria**:
- [ ] Group A tests are renamed to `*.integration.test.ts`; the default vitest include
      glob excludes that suffix.
- [ ] A new `vitest.integration.config.ts` includes only `**/*.integration.test.ts`.
- [ ] A new CI job with `services: redis:` runs `pnpm -r --if-present run test:integration`
      (or equivalent), blocks merge on failure, and is visible on every PR.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `@generacy-ai/orchestrator` unit suite runs on every PR via the existing `Test (packages)` step | P1 | Drop `--filter '!@generacy-ai/orchestrator'` from `.github/workflows/ci.yml` |
| FR-002 | `@generacy-ai/generacy` unit suite runs on every PR via the existing `Test (packages)` step | P1 | Drop `--filter '!@generacy-ai/generacy'` from `.github/workflows/ci.yml` |
| FR-003 | Group A (4 relay-bridge + 1 relay-integration + 2 server-relay-routes tests) moved behind the `*.integration.test.ts` naming convention | P1 | Files: `src/services/__tests__/relay-bridge.test.ts`, `src/__tests__/relay-integration.test.ts`, `src/__tests__/server-relay-routes.test.ts` |
| FR-004 | Group B (`health-code-server` suite, ZodError `auth` required) fixed in place with a valid test config | P1 | Provide the missing `auth` block in the test's config fixture |
| FR-005 | Group C (activation poller + activate tests, `cloud_url` required) fixed in place with an updated `PollResponse` fixture | P1 | Add `cloud_url` to approved-response fixtures; matches #517 schema |
| FR-006 | Group D (4 webhook-setup-service tests) fixed in place by refreshing the HTTP mock expectations | P1 | Files: `src/services/__tests__/webhook-setup-service.test.ts` |
| FR-007 | New `vitest.integration.config.ts` includes only `**/*.integration.test.ts`; the default `vitest.config.ts` excludes that glob | P1 | File-naming convention (Q2 = C). One convention, greppable. |
| FR-008 | New CI job `integration` with `services: redis:` runs the integration suite; **blocks merge on failure** | P1 | Q3 = C. No `continue-on-error: true`, no nightly cron. |
| FR-009 | 36 pre-existing failures in `@generacy-ai/generacy` (mock/CLI-assertion drift, 15 files) fixed in place before FR-002 lands | P1 | Q4 = B. Same treatment as orchestrator groups B–D. |
| FR-010 | Any generacy test that turns out to be genuinely infra-bound is moved behind FR-007's convention rather than blocking this issue | P2 | Escape hatch, expected to be near-empty |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `.github/workflows/ci.yml` contains zero `--filter '!'` exclusions for orchestrator + generacy | 0 references | `grep '--filter .!@generacy-ai/(orchestrator\|generacy)' .github/workflows/ci.yml` returns nothing |
| SC-002 | Orchestrator unit suite green on `develop` HEAD | 0 failed | `pnpm --filter @generacy-ai/workflow-engine build && pnpm --filter @generacy-ai/orchestrator test` |
| SC-003 | Generacy unit suite green on `develop` HEAD | 0 failed | `pnpm --filter '@generacy-ai/generacy...' build && pnpm --filter @generacy-ai/generacy test` |
| SC-004 | Integration suite green on `develop` HEAD with a fresh Redis service | 0 failed | Integration job in CI + local reproduction via `docker run --rm -p 6379:6379 redis` + `pnpm -r --if-present run test:integration` |
| SC-005 | Both packages' failures are visible on subsequent PRs | Failing test → red check | Introduce a deliberate regression on a scratch branch; PR check turns red |

## Assumptions

- Redis is the only ambient-infra dependency required by any of the 18 orchestrator
  failures (no code-server / cloud endpoint dependency remains after groups B–D land as
  in-place fixes).
- `services: redis:` on GitHub-hosted runners is sufficiently deterministic for the
  group-A tests; no flake budget is needed at issue-land time. If a specific test proves
  flaky post-merge, it is quarantined individually (skipped with an explicit `it.skip`
  + issue link) rather than un-blocking the whole integration job.
- The 36 generacy failures counted at Q4 are fully mock/assertion drift; if any turn out
  to be genuinely infra-bound during implementation, FR-010 covers them.

## Out of Scope

- Sharding the unit suite for runtime — treated as a follow-up if wall-clock becomes a
  problem after FR-001/FR-002 land.
- Refactoring the existing 1960 passing orchestrator tests or the 1692 passing generacy
  tests.
- Introducing an env-var integration gate (`RUN_INTEGRATION=1`) or a scheduled/nightly
  integration runner — explicitly rejected in Q2 and Q3.
- Cross-package test consolidation (moving tests between packages).

---

*Generated by speckit*

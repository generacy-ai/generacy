# Feature Specification: Wire orchestrator + generacy test suites into CI, unstick 18 red tests on develop

**Branch**: `871-summary-generacy-ai` | **Date**: 2026-07-09 | **Status**: Draft | **Issue**: [#871](https://github.com/generacy-ai/generacy/issues/871)

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

## Suggested resolution

1. **Decide the intent of the CI exclusion.** Either:
   - wire the orchestrator + generacy suites into CI (provide the required service
     containers — Redis at minimum — or split infra-dependent tests behind an
     integration tag so the unit tests can gate merges), or
   - if the exclusion is deliberate, document *why* in `ci.yml` and add a separate
     (scheduled / integration) job so the suites still run somewhere.
2. **Triage the 18 failing tests:** fix them to properly stub their dependencies (Redis,
   code-server, cloud/activation endpoints, webhook HTTP), or quarantine them behind an
   integration-only tag — so the default `pnpm --filter @generacy-ai/orchestrator test`
   is green.

## User Stories

### US1: Merge gate catches orchestrator/generacy regressions

**As a** contributor merging a PR that touches `@generacy-ai/orchestrator` or
`@generacy-ai/generacy`,
**I want** the merge gate to run those packages' test suites,
**So that** regressions surface on my PR instead of rotting on `develop` and being
discovered later by someone else running tests locally.

**Acceptance Criteria**:
- [ ] A CI job runs the orchestrator test suite on every PR (or a documented subset;
      integration-tagged tests may be split off), and its failure blocks merge.
- [ ] A CI job runs the generacy test suite on every PR, and its failure blocks merge.
- [ ] Introducing a deliberately-failing test in either package makes the PR check red.

### US2: Green baseline on develop

**As a** contributor pulling `develop` and running the orchestrator suite,
**I want** `pnpm --filter @generacy-ai/orchestrator test` (after a clean
`pnpm -r build`) to be green with no ambient infrastructure,
**So that** I can trust local test results and identify real regressions from my
changes rather than sifting through pre-existing red tests.

**Acceptance Criteria**:
- [ ] All 18 currently-failing tests either pass without ambient infrastructure, or
      are moved behind an integration-only tag and excluded from the default run.
- [ ] The default `pnpm --filter @generacy-ai/orchestrator test` invocation on
      `develop` exits 0.

### US3: Intent is documented, not implicit

**As a** future contributor reading `.github/workflows/ci.yml`,
**I want** any deliberate test exclusion to state *why* and *where the tests do run*,
**So that** the exclusion doesn't quietly regress into "nobody knows this suite exists".

**Acceptance Criteria**:
- [ ] `ci.yml` either includes the suites or contains a comment stating the rationale
      and pointing at the alternate job (scheduled / integration) that runs them.

## Functional Requirements

| ID     | Requirement                                                                                                                                                   | Priority | Notes                                                                                    |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|------------------------------------------------------------------------------------------|
| FR-001 | The CI pipeline MUST execute the `@generacy-ai/orchestrator` test suite (or a documented unit-only subset) on every PR to `develop`.                          | P1       | Root cause fix. Failure blocks merge.                                                    |
| FR-002 | The CI pipeline MUST execute the `@generacy-ai/generacy` test suite on every PR to `develop`.                                                                 | P1       | Same coverage gap as orchestrator.                                                       |
| FR-003 | The 4 Redis-dependent tests (group A) MUST either mock/stub the Redis client so they pass without a live Redis, or be gated behind an integration-only tag.   | P1       | `relay-bridge.test.ts` (4), `relay-integration.test.ts` (1), `server-relay-routes.test.ts` (2). |
| FR-004 | The config-parsing test (group B, `health-code-server.test.ts`) MUST provide a valid config fixture so suite setup succeeds.                                  | P1       | ZodError on `auth`.                                                                      |
| FR-005 | The 7 activation-client tests (group C) MUST include `cloud_url` in their poll-response fixtures (or update the schema/fixture together).                     | P1       | Schema drift — `PollResponseSchema` approved variant requires `cloud_url` per #517.      |
| FR-006 | The 4 webhook-setup tests (group D) MUST update their HTTP mocks to match the current `WebhookSetupService` request/response shape.                           | P1       | Drifted mocks.                                                                           |
| FR-007 | If any tests are moved behind an integration-only tag (rather than fixed), the tag mechanism MUST be documented and there MUST be an alternate job (scheduled or integration) that runs them. | P2       | Prevents future "nobody knows this suite exists" regressions.                            |
| FR-008 | The default `pnpm --filter @generacy-ai/orchestrator test` invocation MUST exit 0 on a clean checkout after `pnpm -r build`, with no ambient infrastructure required. | P1       | Local-dev baseline.                                                                      |
| FR-009 | Any deliberate CI-exclusion decision MUST be documented in `.github/workflows/ci.yml` (comment or referenced doc).                                            | P2       | Intent-preservation.                                                                     |

## Success Criteria

| ID     | Metric                                                                                             | Target                          | Measurement                                                                                     |
|--------|----------------------------------------------------------------------------------------------------|---------------------------------|-------------------------------------------------------------------------------------------------|
| SC-001 | Orchestrator test suite runs on PRs to `develop`.                                                  | Runs on 100% of PRs             | Observe the check on this PR (and any subsequent PR) in GitHub Actions.                         |
| SC-002 | Generacy test suite runs on PRs to `develop`.                                                      | Runs on 100% of PRs             | Same as above.                                                                                  |
| SC-003 | Currently-failing tests, on `develop` HEAD after this change lands.                                | 0 failing in the default run    | `pnpm --filter @generacy-ai/workflow-engine build && pnpm --filter @generacy-ai/orchestrator test` exits 0. |
| SC-004 | Regression detection: a deliberate-failure probe PR (test that always fails) is caught by CI.      | 100% caught pre-merge           | Open a throwaway PR that adds a failing test; verify CI is red before merge; close without merging. |
| SC-005 | Intent of any residual exclusion is documented.                                                    | Comment present in `ci.yml`     | Grep `ci.yml` for the rationale comment or referenced doc link.                                 |

## Assumptions

- The 18 failing tests represent test-hygiene issues (drifted mocks, missing fixtures,
  ambient-infra dependencies), **not** live product bugs. Confirmed spot-check for
  groups B and C (schema/fixture mismatches); groups A and D likely similar.
- Redis is not required in CI for the base suite. Redis-dependent tests can be
  stubbed or tagged.
- Splitting tests behind an integration-only tag (e.g., a `describe.skipIf` env-var
  gate or a separate vitest config) is acceptable — the goal is a green default run,
  not that every existing test must run in the default job.
- The `Test (packages)` step in `ci.yml` is the correct home for the orchestrator +
  generacy suites (as opposed to inventing a third job), unless service containers
  push us toward a dedicated job.

## Out of Scope

- Rewriting orchestrator or generacy tests beyond what is needed to make them green
  or cleanly gated.
- Refactoring the underlying services (relay-bridge, config loader, activation
  client, webhook-setup-service) beyond what the failing tests require.
- Adding new test coverage for uncovered code paths.
- Investigating or fixing the pre-existing 2 skipped tests (out of 1980).
- Any changes to `@generacy-ai/workflow-engine` beyond documenting the
  `pnpm --filter @generacy-ai/workflow-engine build` prerequisite if needed.
- CI performance tuning (parallelism, caching) — only correctness is in scope.

---

*Generated by speckit — enhanced from GitHub issue #871.*

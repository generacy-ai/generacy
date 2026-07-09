# Clarifications

## Batch 1 — 2026-07-09

### Q1: Test-Fix Strategy
**Context**: FR-003/FR-004/FR-005/FR-006 each offer two paths — fix the mocks/stubs so the tests run without ambient infra, or hide the tests behind an integration-only tag. The choice governs how much test code is rewritten in this issue versus how many tests move to a separate runner.
**Question**: For the 18 currently-failing tests, what is the preferred default treatment?
**Options**:
- A: Fix all 18 in-place (add proper mocks/stubs for Redis, config, cloud endpoints, webhook HTTP) so they run in the default unit suite. No integration tag introduced.
- B: Fix easy groups in-place (B/C/D — config, activation-client, webhook mocks — schema/mock drift), split group A (the 4 Redis-dependent tests) behind an integration tag.
- C: Split all 18 behind an integration tag; keep the default suite green by exclusion; fix the tests when the integration runner is stood up.
- D: Case-by-case per group — recommend the cheapest option per group and land as separate PRs under this epic.

**Answer**: B — fix groups B/C/D in place (they're schema/mock drift, i.e. plain unit-test rot), move group A (the Redis-dependent relay tests) behind the integration convention — paired with Q3 = C so they still gate PRs against a *real* Redis. Rationale for not forcing group A into the unit suite with deep ioredis mocks (option A): the single most recurrent defect class found during the cockpit smoke test has been "tests encode the code's assumptions" (#800, #826, #836, #853, #855, #861) — hand-mocked pub/sub that mirrors what the code expects is how that class breeds. A service-container Redis is cheap and deterministic; use the real thing.

### Q2: Integration Tag Mechanism
**Context**: If any tests move behind an integration tag (Q1 options B/C/D), the mechanism needs to be one thing so future contributors don't invent a second convention. Ambient repo pattern check: no existing `*.integration.test.ts` files or `INTEGRATION` env-var gates were found. This picks the convention.
**Question**: If integration tagging is used, which mechanism should the repo adopt?
**Options**:
- A: Env-var gate inside the test file — `describe.skipIf(!process.env.RUN_INTEGRATION)(...)`. Zero config changes, per-suite opt-in.
- B: Separate vitest config — `vitest.integration.config.ts` selects files by glob, default `vitest.config.ts` excludes them.
- C: File-naming convention — `*.integration.test.ts` excluded by the default `include` glob, integration runner uses its own glob.
- D: Not applicable — Q1 answer is (A), no tagging needed.

**Answer**: C — `*.integration.test.ts` file-naming convention: the default `vitest.config.ts` excludes the glob, a `vitest.integration.config.ts` includes only it. The convention is visible in the filename and greppable. Not A: an env-var `skipIf` inside the file renders as green/skipped in every default run — an invisible convention, quiet forever — and this issue is specifically about invisible test states.

### Q3: Integration Runner Home
**Context**: FR-007 requires that any tagged-off tests still run *somewhere* and that "somewhere" is documented. The choice is between a scheduled cron job (runs periodically on `develop`, no PR feedback) and a PR-triggered non-blocking job (runs on every PR but can't gate merge). Only matters if Q1 is B/C/D.
**Question**: Where should any integration-tagged tests run, if we adopt a tag?
**Options**:
- A: Scheduled workflow (e.g., nightly cron on `develop`); failures open issues but do not block PRs.
- B: PR-triggered CI job with service containers (Redis at minimum); non-blocking (`continue-on-error: true`), visible on the PR.
- C: PR-triggered CI job with service containers; blocking (a red integration job blocks merge).
- D: Not applicable — Q1 answer is (A), no alternate runner needed.

**Answer**: C — PR-triggered job with `services: redis`, **blocking**. Non-blocking (B) is sanctioned invisibility: this very issue exists because red-that-doesn't-block rots, and `continue-on-error: true` rebuilds the blind spot with a green checkmark on top. Nightly (A) is the same rot on a delay, discovered only after the regression already landed on develop. Service-container Redis is localhost-deterministic, so there is no flake argument; if an individual test proves flaky later, quarantine that test explicitly rather than unblocking the job.

### Q4: Generacy Suite Baseline
**Context**: FR-002 requires the `@generacy-ai/generacy` test suite to run on every PR, but the spec only enumerates the 18 orchestrator failures. If generacy also has red tests, they need to be triaged as part of this issue or the CI wiring will introduce a red baseline on day one. This scopes the work.
**Question**: What is the current state of the `@generacy-ai/generacy` test suite on `develop` (after `pnpm -r build`), and are any failing tests there in scope for this issue?
**Options**:
- A: Suite is already green — FR-002 is purely a CI-wiring change, no test fixes needed for that package.
- B: Suite has failing tests — they are in scope; fix or tag them alongside the orchestrator triage before enabling the CI gate.
- C: Suite has failing tests — they are NOT in scope; wire generacy into CI in a follow-up issue after this one lands (US1 acceptance for generacy defers).
- D: Unknown — treat "confirm state and triage if needed" as an explicit task in `tasks.md`.

**Answer**: B, with measured data — ran on develop @ 33c9f11 after building the package's dependency graph fresh (`pnpm --filter '@generacy-ai/generacy...' build && pnpm --filter @generacy-ai/generacy test`): **36 failed | 1692 passed | 4 skipped (1732), 15 failing files**. Every failure is mock/assertion drift — `[vitest] No "lifecycleAction" export is defined on the mock` (×5), expected-CLI-output string drift (init, validate, placeholders, destroy, workspace-setup), a mocked constructor that no longer exists (`AgentLauncher is not a constructor`) — none are ambient-infra (no Redis/network class in this package). They are in scope: same per-group treatment as the orchestrator's groups B–D, mostly mechanical. Wiring the gate while red (C) forces day-one exclusions — the exact blind spot this issue removes. Escape hatch: any test that turns out genuinely infra-bound moves behind the Q2 convention rather than blocking the issue.

### Q5: CI Wiring Shape
**Context**: The existing `Test (packages)` step (`ci.yml:52-53`) currently `--filter '!'`s both packages. Simplest fix is to drop those filters. But if any group-A tests stay Redis-dependent (Q1 B/C), the orchestrator suite may need a `services: redis:` block, which is cleaner as a separate job. This affects PR structure.
**Question**: How should orchestrator + generacy be added to the CI pipeline?
**Options**:
- A: Remove the two `--filter '!'` exclusions from the existing `Test (packages)` step. No new job. Assumes the default suite has no ambient-infra dependency (aligns with Q1 = A, or B/C/D + integration split).
- B: Add a dedicated `Test (orchestrator + generacy)` step in the same `ci` job, run after `Test (packages)`. Same runner, isolated failure signal.
- C: Add a dedicated job (`test-core`) with `services: redis:` for the Redis-dependent tests; keep integration-tagged tests in an even further split.
- D: Defer to the implementer based on Q1–Q3 answers.

**Answer**: A + C combined, stated precisely — (1) drop both `--filter '!'` exclusions from the existing `Test (packages)` step so the two unit suites run where every other package's suite runs (they are green after Q1/Q4 remediation and need no services); (2) add a new **blocking** `integration` job with `services: redis` that runs the `*.integration.test.ts` glob via `vitest.integration.config.ts`. Don't give the core packages their own special unit step (B) — special-casing is exactly how the exclusion crept in; one honest gate for all packages, one explicit integration job for tests that need infra. If suite runtime becomes a problem, shard later; don't re-exclude.

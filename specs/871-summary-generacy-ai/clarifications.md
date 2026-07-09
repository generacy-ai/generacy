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

**Answer**: *Pending*

### Q2: Integration Tag Mechanism
**Context**: If any tests move behind an integration tag (Q1 options B/C/D), the mechanism needs to be one thing so future contributors don't invent a second convention. Ambient repo pattern check: no existing `*.integration.test.ts` files or `INTEGRATION` env-var gates were found. This picks the convention.
**Question**: If integration tagging is used, which mechanism should the repo adopt?
**Options**:
- A: Env-var gate inside the test file — `describe.skipIf(!process.env.RUN_INTEGRATION)(...)`. Zero config changes, per-suite opt-in.
- B: Separate vitest config — `vitest.integration.config.ts` selects files by glob, default `vitest.config.ts` excludes them.
- C: File-naming convention — `*.integration.test.ts` excluded by the default `include` glob, integration runner uses its own glob.
- D: Not applicable — Q1 answer is (A), no tagging needed.

**Answer**: *Pending*

### Q3: Integration Runner Home
**Context**: FR-007 requires that any tagged-off tests still run *somewhere* and that "somewhere" is documented. The choice is between a scheduled cron job (runs periodically on `develop`, no PR feedback) and a PR-triggered non-blocking job (runs on every PR but can't gate merge). Only matters if Q1 is B/C/D.
**Question**: Where should any integration-tagged tests run, if we adopt a tag?
**Options**:
- A: Scheduled workflow (e.g., nightly cron on `develop`); failures open issues but do not block PRs.
- B: PR-triggered CI job with service containers (Redis at minimum); non-blocking (`continue-on-error: true`), visible on the PR.
- C: PR-triggered CI job with service containers; blocking (a red integration job blocks merge).
- D: Not applicable — Q1 answer is (A), no alternate runner needed.

**Answer**: *Pending*

### Q4: Generacy Suite Baseline
**Context**: FR-002 requires the `@generacy-ai/generacy` test suite to run on every PR, but the spec only enumerates the 18 orchestrator failures. If generacy also has red tests, they need to be triaged as part of this issue or the CI wiring will introduce a red baseline on day one. This scopes the work.
**Question**: What is the current state of the `@generacy-ai/generacy` test suite on `develop` (after `pnpm -r build`), and are any failing tests there in scope for this issue?
**Options**:
- A: Suite is already green — FR-002 is purely a CI-wiring change, no test fixes needed for that package.
- B: Suite has failing tests — they are in scope; fix or tag them alongside the orchestrator triage before enabling the CI gate.
- C: Suite has failing tests — they are NOT in scope; wire generacy into CI in a follow-up issue after this one lands (US1 acceptance for generacy defers).
- D: Unknown — treat "confirm state and triage if needed" as an explicit task in `tasks.md`.

**Answer**: *Pending*

### Q5: CI Wiring Shape
**Context**: The existing `Test (packages)` step (`ci.yml:52-53`) currently `--filter '!'`s both packages. Simplest fix is to drop those filters. But if any group-A tests stay Redis-dependent (Q1 B/C), the orchestrator suite may need a `services: redis:` block, which is cleaner as a separate job. This affects PR structure.
**Question**: How should orchestrator + generacy be added to the CI pipeline?
**Options**:
- A: Remove the two `--filter '!'` exclusions from the existing `Test (packages)` step. No new job. Assumes the default suite has no ambient-infra dependency (aligns with Q1 = A, or B/C/D + integration split).
- B: Add a dedicated `Test (orchestrator + generacy)` step in the same `ci` job, run after `Test (packages)`. Same runner, isolated failure signal.
- C: Add a dedicated job (`test-core`) with `services: redis:` for the Redis-dependent tests; keep integration-tagged tests in an even further split.
- D: Defer to the implementer based on Q1–Q3 answers.

**Answer**: *Pending*

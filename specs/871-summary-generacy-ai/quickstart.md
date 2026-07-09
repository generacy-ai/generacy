# Quickstart: Close the orchestrator + generacy CI test-coverage blind spot

**Feature**: 871 | **Date**: 2026-07-09

Reproduce, verify, and troubleshoot the CI-wiring + test-remediation change locally.

## Prerequisites

- Node.js ≥22 (workspace requirement).
- pnpm (via `corepack enable` or `npm install -g pnpm`).
- Docker (for a local Redis service container matching the CI shape).

## Reproduce the pre-fix baseline

To see the state this issue is closing:

```bash
# Fresh build so no stale dist masks failures (this is what tripped #870 discovery)
pnpm install --frozen-lockfile
pnpm --filter @generacy-ai/workflow-engine build

# 18 failures across 7 files (orchestrator)
pnpm --filter @generacy-ai/orchestrator test
# => Test Files 7 failed | 125 passed (132)
# =>       Tests 18 failed | 1960 passed | 2 skipped (1980)

# 36 failures across 15 files (generacy)
pnpm --filter '@generacy-ai/generacy...' build
pnpm --filter @generacy-ai/generacy test
# => 36 failed | 1692 passed | 4 skipped (1732)
```

## Verify the fix locally

### 1. Unit suites — no ambient infra required

After landing all the in-place fixes:

```bash
# Orchestrator unit suite (Group A files renamed → skipped by the default include glob)
pnpm --filter @generacy-ai/workflow-engine build
pnpm --filter @generacy-ai/orchestrator test
# Expected: 0 failed

# Generacy unit suite
pnpm --filter '@generacy-ai/generacy...' build
pnpm --filter @generacy-ai/generacy test
# Expected: 0 failed

# Root unit suite (unchanged behavior; runs tests/**/*.test.ts only)
pnpm test
```

Both must exit 0 with no ambient services running.

### 2. Integration suite — real Redis required

```bash
# Start a Redis container matching the CI service-container shape
docker run --rm -d --name generacy-redis-test -p 6379:6379 redis:7

# Run the integration suite (renamed Group A tests)
pnpm -r --if-present run test:integration

# Expected: 0 failed. The 7 Group A tests run against real Redis on localhost:6379.

# Tear down
docker stop generacy-redis-test
```

If your `REDIS_URL` env var is set to something non-default, the tests honor it. Unset it to hit the default `redis://127.0.0.1:6379`.

### 3. Verify the CI YAML shape

```bash
# SC-001: zero remaining `--filter '!'` exclusions for the two packages
grep -E "--filter '!@generacy-ai/(orchestrator|generacy)'" .github/workflows/ci.yml
# Expected: no output (grep exit code 1)

# The new integration job exists
grep -A2 "^  integration:" .github/workflows/ci.yml
# Expected: shows the job header + runs-on line
```

### 4. Verify a deliberate regression turns the check red

Sanity check for SC-005 — introduce a fake regression on a scratch branch:

```bash
git checkout -b regression-canary
# Edit any orchestrator test to assert something impossible (e.g., expect(1).toBe(2))
pnpm --filter @generacy-ai/orchestrator test
# Expected locally: 1 failed
# Push, open a PR: expected in CI: `ci` job red, PR merge blocked
```

## Commands introduced by this feature

| Command | Where | What it does |
|---------|-------|--------------|
| `pnpm -r --if-present run test:integration` | Any workspace root | Runs every package's `test:integration` script (skips packages without one). Requires Redis running on `localhost:6379`. |
| `pnpm --filter @generacy-ai/orchestrator run test:integration` | Any workspace root | Runs orchestrator's Group A tests only. Requires Redis. |
| `vitest --config vitest.integration.config.ts run` | Any package with the script | The underlying command a package's `test:integration` script invokes. Runs the `*.integration.test.ts` glob. |

Nothing in this feature changes `pnpm test` or `pnpm --filter <pkg> test` semantics — they still run the same globs they always ran, minus files whose name now ends in `.integration.test.ts`.

## Troubleshooting

### "0 tests found" from `pnpm -r --if-present run test:integration`

You may not have any integration tests in the workspace root you're in. `--if-present` means the script is silently skipped for packages that don't declare it — check the packages that should:

```bash
grep -l '"test:integration"' packages/*/package.json
# Expected: at least packages/orchestrator/package.json (and packages/generacy/package.json — script present, currently zero files)
```

### `ECONNREFUSED 127.0.0.1:6379` in the integration job

The integration suite needs Redis. Locally: `docker run --rm -d -p 6379:6379 redis:7`. In CI: verify the `services: redis:` block is on the `integration` job. If a specific test breaks because it doesn't clean up its keys, add `beforeEach`/`afterEach` `flushdb()` to that test's setup — do not mock ioredis.

### A test I renamed to `*.integration.test.ts` still runs in `pnpm test`

Check `packages/<pkg>/vitest.config.ts` includes an `exclude: ['**/*.integration.test.ts']`. Vitest layers this on top of its built-in excludes (`node_modules`, `dist`, etc.); if the exclude line is missing the file is picked up by the default `include` glob.

### A test I did not intend to move ran in the integration job

Check the filename — the convention is exact. `foo.integration.test.ts` runs in the integration job. `foo-integration.test.ts` or `foo.spec.ts` does not. If in doubt, `git grep '\.integration\.test\.ts'` enumerates every file under the convention.

### A group-A test flakes in CI post-merge

**Do not** flip the integration job to `continue-on-error: true` — that reintroduces the exact blind spot this issue is closing. Instead, quarantine the specific flaky test with `it.skip('should X', () => { /* … */ })` and a comment linking a follow-up issue. Fix the flake in the follow-up, then un-skip.

## Success criteria checklist (from spec.md)

- [ ] **SC-001**: `grep '--filter .!@generacy-ai/(orchestrator\|generacy)' .github/workflows/ci.yml` returns nothing.
- [ ] **SC-002**: `pnpm --filter @generacy-ai/workflow-engine build && pnpm --filter @generacy-ai/orchestrator test` — 0 failed.
- [ ] **SC-003**: `pnpm --filter '@generacy-ai/generacy...' build && pnpm --filter @generacy-ai/generacy test` — 0 failed.
- [ ] **SC-004**: With Redis running (`docker run --rm -p 6379:6379 redis`), `pnpm -r --if-present run test:integration` — 0 failed.
- [ ] **SC-005**: Deliberate regression on a scratch branch → red PR check on the `ci` job.

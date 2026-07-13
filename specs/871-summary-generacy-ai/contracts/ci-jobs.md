# Contracts: CI job shape

**Feature**: 871 | **Date**: 2026-07-09

This feature has no HTTP/gRPC API contracts. Its only "interface contract" is the shape
of the CI jobs after the change lands. This doc freezes the expected shape so
`/speckit.tasks` decomposition and later review can reference a canonical target.

## Existing `ci` job — modified in place

**File**: `.github/workflows/ci.yml`

### Contract

- **Trigger**: unchanged (`pull_request` on `develop`/`main`, `push` on `develop`/`main`).
- **Runner**: `ubuntu-latest`.
- **Services**: **none** — the unit suites are green after Decisions 1–4 land and need no ambient infra.
- **`Test (packages)` step command**: **drop** both `--filter '!'` exclusions.

**Before** (`ci.yml:52-53`):

```yaml
- name: Test (packages)
  run: pnpm -r --filter '!@generacy-ai/orchestrator' --filter '!@generacy-ai/generacy' run --if-present test
```

**After**:

```yaml
- name: Test (packages)
  run: pnpm -r run --if-present test
```

**Merge-blocking**: yes (unchanged — this is an existing required check).

## New `integration` job — added alongside `ci`

**File**: `.github/workflows/ci.yml`

### Contract

- **Trigger**: same as `ci` (`pull_request` on `develop`/`main`, `push` on `develop`/`main`).
- **Runner**: `ubuntu-latest`.
- **Services**: `redis` — one health-checked container on `localhost:6379`.
- **Steps**: standard setup (checkout, pnpm, node 22, install), then a package build (integration tests depend on package dist), then `pnpm -r --if-present run test:integration`.
- **Merge-blocking**: **yes**. No `continue-on-error: true`. Required check on `pull_request` events.

### Reference YAML shape

```yaml
integration:
  runs-on: ubuntu-latest
  if: github.event_name != 'pull_request' || github.event.pull_request.draft == false
  services:
    redis:
      image: redis:7
      ports:
        - 6379:6379
      options: >-
        --health-cmd "redis-cli ping"
        --health-interval 10s
        --health-timeout 5s
        --health-retries 5
  steps:
    - uses: actions/checkout@v6
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v4
      with:
        node-version: '22'
        cache: 'pnpm'
    - name: Install dependencies
      run: pnpm install --frozen-lockfile
    - name: Build (packages)
      run: pnpm -r run --if-present build
    - name: Test (integration)
      run: pnpm -r --if-present run test:integration
```

**Environment**: default `REDIS_URL=redis://127.0.0.1:6379` is assumed by orchestrator test code today; no env-var wiring required in this job. If a future test needs a non-default URL, add it to that test's setup, not to this job block.

## Vitest config contracts

### Default unit config (root and per-package)

- **`vitest.config.ts` (root)**: `include: ['tests/**/*.test.ts']` unchanged; add `exclude: ['**/*.integration.test.ts']`.
- **`packages/orchestrator/vitest.config.ts`**: `include: ['tests/**/*.test.ts', 'src/**/*.test.ts']` unchanged; add `exclude: ['**/*.integration.test.ts']`.
- **`packages/generacy/vitest.config.ts`**: `include: ['src/**/__tests__/**/*.test.ts', '__tests__/**/*.test.ts', 'tests/**/*.test.ts']` unchanged; add `exclude: ['**/*.integration.test.ts']`.

### New integration config (root)

**`vitest.integration.config.ts`** (root):

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.integration.test.ts'],
    testTimeout: 30000,
  },
});
```

- **Include glob**: `**/*.integration.test.ts` — matches any depth, any package.
- **Timeout**: 30s (longer than unit's 15s to absorb service-container startup jitter).

### Package `test:integration` scripts

Each package that has integration tests adds:

```json
{
  "scripts": {
    "test:integration": "vitest --config ../../vitest.integration.config.ts run"
  }
}
```

For this issue that means `packages/orchestrator/package.json` gets the script. `packages/generacy/package.json` gets it too so `pnpm -r --if-present run test:integration` is symmetric (script exists, resolves zero test files today, exits 0). Packages without integration tests can omit the script — `--if-present` skips them.

## Filename convention contract

- **Suffix**: `.integration.test.ts` (exactly — no `.integration.spec.ts`, no `-integration.test.ts`).
- **Location**: anywhere the normal test glob would already find it (co-located `__tests__/` or a top-level `tests/` folder).
- **Runs in**: the `integration` CI job only.
- **Runs against**: real Redis at `redis://127.0.0.1:6379` (or whatever `REDIS_URL` is set to locally).
- **Does NOT run in**: `pnpm test`, `pnpm -r --if-present run test`, `pnpm --filter <pkg> test`, or the existing `ci` job's `Test (packages)` step.

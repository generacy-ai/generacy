# Quickstart: P1 route plumbing end-to-end verification

## Prerequisites (dependency gate — Q3=A)

All three siblings MUST be merged to `develop` and this branch rebased on them before the
tests can go green:

- #1198 — `resolveRoute`, per-launch `CLAUDE_CONFIG_DIR`, `GatewayRouteUnavailableError`
- #1199 — route-aware session invalidation + `agent.route.transition` log
- #1200 — `generacy validate` / `generacy doctor` surfaces

Check: `grep -rn "resolveRoute\|GatewayRouteUnavailableError\|agent.route.transition" packages/`
must return production hits. If it returns none, **dependency-block** (skip and requeue).

## Running the tests

```bash
pnpm install && pnpm -r build

# All new suites
pnpm --filter @generacy-ai/orchestrator vitest run \
  route-launch-env golden-subscription-spawns no-settings-flag phase-loop.route-transition
```

Individual suites:

| Suite | Covers |
|---|---|
| `route-launch-env.test.ts` | US1/FR-001..003 — gateway vs subscription env, wrapper preservation |
| `golden-subscription-spawns.test.ts` | US2/FR-004..005 — byte identity vs fixture |
| `no-settings-flag.test.ts` | FR-009 — zero `--settings` in launch-path sources |
| `phase-loop.route-transition.test.ts` | US3/FR-006..007 — 2 drops + transition logs |

## Capturing the golden baseline (one-time, pre-P1 merge-base — Q1=C)

```bash
# 1. Find the develop commit immediately before #1198's merge
git log --first-parent --merges develop   # note <PRE_P1_SHA>

# 2. Worktree at that commit
git worktree add ../generacy-pre-p1 <PRE_P1_SHA>
cd ../generacy-pre-p1
pnpm install && pnpm -r build

# 3. Copy the harness (test file + fixtures dir) from this branch into the worktree
cp <branch>/packages/orchestrator/src/launcher/__tests__/golden-subscription-spawns.test.ts \
   packages/orchestrator/src/launcher/__tests__/
mkdir -p packages/orchestrator/src/launcher/__tests__/fixtures

# 4. Capture
GOLDEN_UPDATE=1 pnpm --filter @generacy-ai/orchestrator vitest run golden

# 5. Copy fixture back, record provenance
cp packages/orchestrator/src/launcher/__tests__/fixtures/subscription-baseline.json \
   <branch>/packages/orchestrator/src/launcher/__tests__/fixtures/
# write <PRE_P1_SHA> + date into fixtures/README.md

# 6. Clean up
cd - && git worktree remove ../generacy-pre-p1
```

## Regenerating the fixture (legitimate spawn changes only)

```bash
GOLDEN_UPDATE=1 pnpm --filter @generacy-ai/orchestrator vitest run golden
```

Commit the fixture diff in the same PR as the intentional launch-path change and justify
it in the PR description. A fixture-only diff is a review red flag.

## Changeset (FR-011)

```bash
pnpm changeset --empty   # tests/fixtures/docs-only diff
# → .changeset/1201-p1-route-verification.md
```

If a seam fix under `packages/*/src/` lands, replace the empty changeset with a **patch**
bump for that package.

## Docs build check (US4)

```bash
cd docs && pnpm install && pnpm build   # onBrokenLinks: 'throw' must pass
```

## Troubleshooting

- **Golden test fails only on CI**: a test forgot to stub `process.env` — the base env
  layer is hardcoded in `agent-launcher.ts:105-114`; every golden/env assertion must run
  under the shared `beforeEach` env stub.
- **`Unknown stdio profile "interactive"`**: the launcher was constructed with only the
  `default` spy factory — `conversation-turn` requires both profiles registered.
- **Capture harness import errors in the worktree**: run `pnpm -r build` in the worktree
  first; the harness imports built package seams, not source.
- **Wrapper proof fails on exotic shells**: the FR-003 spawn uses `sh` from PATH; the
  assertion assumes POSIX `.`-sourcing semantics (true for dash/bash). Run in the
  devcontainer.

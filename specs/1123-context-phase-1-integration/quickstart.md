# Quickstart: Review/remediate P1 integration checkpoint (#1123)

This issue ships **tests + a contract note only** — there is nothing to install or run in an app. This quickstart covers preconditions, how to run the new tests, and how to verify the acceptance artifacts.

## Preconditions (Q1=B — blocking)

The implement phase is **blocked** until both dependencies land:

1. **#1121** merged to `develop` — `WorkflowPhase` includes `review`/`remediate`, and every companion enumeration is updated (see plan.md → Companion-table inventory), including the off-sequence loop-control entry mechanism.
2. **#1122** merged to `develop` — `maxRemediations` (feature 3 / bugfix 2) + review profile in `@generacy-ai/config` `OrchestratorSettings`, resolvable via `worker/config.ts`.

Then rebase this branch on `develop`:

```bash
git fetch origin
git rebase origin/develop
```

Verify the union actually expanded before writing/asserting tests:

```bash
grep -n "type WorkflowPhase" packages/orchestrator/src/worker/types.ts
# expect: 'review' and 'remediate' present in the union
```

## Install & build

```bash
pnpm install
pnpm --filter @generacy-ai/orchestrator build
```

## Run the tests

```bash
# Loop traversal + per-workflow config observability (FR-001/002/003/004)
pnpm --filter @generacy-ai/orchestrator test phase-loop.review-remediate.integration

# Pause/resume round-trip for review & remediate (FR-005)
pnpm --filter @generacy-ai/orchestrator test pause-resume.review-remediate

# Phase-union sync audit (FR-006)
pnpm --filter @generacy-ai/orchestrator test types.test

# Or the whole worker suite
pnpm --filter @generacy-ai/orchestrator test worker
```

## What each test proves

| Test | Asserts | SC |
|---|---|---|
| `phase-loop.review-remediate.integration.test.ts` | `review` runs after `implement` (both workflows); `remediate` runs off-sequence and backtracks to `review`; `maxRemediations`/profile readable in-loop (feature 3 / bugfix 2). | SC-002, SC-003 |
| `pause-resume.review-remediate.test.ts` | Pause/resume round-trips `review→review` and `remediate→remediate`; labels apply/clear symmetrically (0 residual). | SC-004 |
| `types.test.ts` (extended) | Every companion enumeration (sequences + both runtime `z.enum`s) covers the full union; dropping a phase from any one turns it red. | SC-005 |

## Verify the shipped contract (FR-007 / SC-006)

```bash
ls specs/1123-context-phase-1-integration/contracts/remediate-review-seam.md
```

The doc pins: off-sequence `{ next: 'remediate' }` entry, the always-`{ next: 'review' }` backtrack, resume targets (Q3=A), and the per-workflow config surface (Q4=B).

## Mutation check (SC-005 — do this during review)

Temporarily drop `remediate` from one companion and confirm the audit fails:

```bash
# e.g. remove 'remediate' from pause-context.ts WorkflowPhaseSchema z.enum, then:
pnpm --filter @generacy-ai/orchestrator test types.test   # expect RED
git checkout -- packages/orchestrator/src/worker/pause-context.ts
```

## Changeset

None required — every `packages/*/src/` change is a `*.test.ts` file (test-only exemption) and the contract lives under `specs/`. Do **not** add a `.changeset/*.md`. (If you add a load-bearing comment to `phase-loop.ts`, that becomes a non-test `src/` change requiring a `patch` changeset for `@generacy-ai/orchestrator` — prefer keeping the contract in `specs/`.)

## Troubleshooting

- **`readPauseContext` returns `null` for `review`/`remediate`** → `pause-context.ts` `WorkflowPhaseSchema` (`:28-35`) was not updated by #1121. File a fast-follow against #1121; do not patch here (Q1=B).
- **Tests reference a `{ next }` outcome the loop ignores** → the off-sequence loop-control mechanism was not delivered by #1121 (Integration Risk 1). Coordinate scope with #1121 before proceeding.
- **`maxRemediations` not readable in-loop** → confirm the #1122 `worker/config.ts` resolver name/signature and read through it, not a re-derived path (Integration Risk 3).

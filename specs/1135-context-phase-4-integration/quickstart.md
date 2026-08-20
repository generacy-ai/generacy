# Quickstart: Bugfix profile end-to-end with targeted validate (Phase-4 integration)

This feature ships an **integration scenario suite**, a **synthetic monorepo fixture**, a **docs config example** (schema-validated), and a **loop-contract pin note**. It ships no product behavior of its own. It **depends on #1133 and #1134** landing on `develop`; the implement phase dependency-blocks until they do (skip → requeue-after-deps), then rebases on them.

## Prerequisites

- `#1134` merged to `develop` — verification charter, targeted validate, diff-classification guards, `failThenPass`.
- `#1133` merged to `develop` — merge-readiness (`skipped`/`neutral`≠passed), validate/CI parallel semantics, post-validate `implementation-review` final gate.
- P1–P3 machinery (#1123/#1127/#1132 + #1124/#1125/#1128) already on `develop`.

## Run the P4 scenario suite

```bash
pnpm install
pnpm --filter @generacy-ai/orchestrator test -- phase-loop.bugfix
```

Individual scenarios:

```bash
# US1 — bugfix happy path + suite count + validate/CI final gate
pnpm --filter @generacy-ai/orchestrator test -- phase-loop.bugfix-happy-path

# US2 — diff-classification guards (root-config fallback + docs-only skip), each with count
pnpm --filter @generacy-ai/orchestrator test -- phase-loop.bugfix-diff-guards

# US3 — failThenPass on/off (base-ref run + counts)
pnpm --filter @generacy-ai/orchestrator test -- phase-loop.bugfix-fail-then-pass

# CI negative states (skipped / neutral → final gate NOT raised)
pnpm --filter @generacy-ai/orchestrator test -- phase-loop.bugfix-ci-negative

# Docs config example validates against the shipped P4 schema
pnpm --filter @generacy-ai/orchestrator test -- bugfix-profile-config-example
```

## What each scenario proves

| Scenario | Proves | Key assertion |
|---|---|---|
| happy-path | verification charter → blocking missing-regression-test → remediate adds test → clean re-review → ready → targeted validate ∥ green CI → final gate | suite count = affected set **<** full-workspace; final gate raised only when validate **and** CI green; cap 2, converges before cap |
| diff-guards | root-config diff → full validate; docs-only diff → skip tests | count = full-workspace / test count = 0 |
| fail-then-pass | `failThenPass` on runs new test against base ref (fail-on-base / pass-on-branch); off does not | base-ref run present/absent; count includes/omits it |
| ci-negative | `skipped` and `neutral` CI ≠ passed | final gate **NOT** raised in each |
| config-example | docs example is valid P4 config | parses against the shipped schema; carries `verification` / `critical` / `maxRemediations: 2` / targeted `validateCommand` / `failThenPass` |

## Fixture

The synthetic monorepo lives at `packages/orchestrator/src/worker/__tests__/fixtures/bugfix-monorepo/`. Its hand-authored graph (`core` leaf with no dependents; `a → core`, `b → a`; independent `util`/`docs`) guarantees `changed + dependents` is a **strict subset** of the workspace, so "fewer suites" is provable. See `data-model.md §1`.

## Suite-execution count — how it's measured

Counts are observed at an **instrumented stub runner** that records each test/build suite spawn it is asked to execute (clarification Q1=C). It is **not** the count of `--filter`-resolved targets, **not** the count of validate-command invocations, and no real 10-minute suites run. Every variant asserts an explicit count.

## Docs config example

The copy-pasteable per-repo bugfix-profile `.generacy/config.yaml` example ships at `docs/docs/reference/bugfix-profile-config.md` (or the chosen package README) and is machine-validated by `bugfix-profile-config-example.test.ts` against the shipped P4 config schema (clarification Q5=A). Copy it into your repo's `.generacy/config.yaml` to enable the profile.

## Troubleshooting

- **Suite suffers "cannot find #1133/#1134 API"** — you're pre-rebase. This branch dependency-blocks until #1133/#1134 land on `develop`; rebase, then bind the harness to the real seams.
- **Count assertion is off by the affected set** — check the fixture graph; a change to a non-leaf package widens the dependent closure. See `data-model.md §1`.
- **Final gate raised on `skipped` CI** — a merge-readiness regression in #1133; the ci-negative scenario is the alarm.
- **Docs example fails schema validation** — the P4 config schema changed; update the docs example (the test exists to catch exactly this drift).

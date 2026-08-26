# Data Model: Bugfix profile end-to-end with targeted validate (Phase-4 integration)

This issue introduces **no production types**. The entities below are test-harness constructs (the fixture graph, the instrumented runner's record, the validate-seam key, the CI-status inputs) plus the shapes it *consumes* from #1133/#1134 (pinned, not defined here).

## 1. Synthetic monorepo fixture (harness — Q2=A)

Checked in at `packages/orchestrator/src/worker/__tests__/fixtures/bugfix-monorepo/`. A minimal pnpm-workspace-shaped graph whose only job is to make `changed + dependents` a **strict subset** of the workspace.

```
bugfix-monorepo/
  pnpm-workspace.yaml            # packages: [ "packages/*" ]
  package.json                   # workspace root
  packages/
    core/     package.json       # leaf: NO dependents
    a/        package.json        # deps: core
    b/        package.json        # deps: a
    util/     package.json        # independent (no deps, no dependents on core-chain)
    docs/     package.json        # docs-only package (used by the docs-only guard variant)
```

**Dependency graph (edges = "depends on"):**

| Package | Depends on | Dependents (closure) |
|---|---|---|
| `core` | — | `a`, `b` |
| `a` | `core` | `b` |
| `b` | `a` | — |
| `util` | — | — |
| `docs` | — | — |

**Strict-subset guarantee**: a change confined to `core` yields affected set `{core, a, b}` — a **strict subset** of the 5-package workspace (`util`, `docs` unaffected). This is the shape SC-003 asserts against.

| Field | Meaning |
|---|---|
| affected-set count | packages in `changed ∪ dependents(changed)` |
| full-workspace count | all packages a full validate would run |
| invariant | affected-set count **<** full-workspace count (D-3) |

## 2. Suite-execution record (harness — Q1=C)

Produced by the instrumented stub runner at the per-suite spawn seam. Not a production type.

| Field | Type | Notes |
|---|---|---|
| `suite` | `string` | package/target name the spawn was for |
| `kind` | `'test' \| 'build'` | which suite kind (docs-only skip ⇒ zero `'test'` records) |
| `ref` | `string` | git ref the suite ran against (`branch` normally; `base` for a `failThenPass` base-ref run) |

**Counting rule** (consistent across every scenario):
- **suite-execution count** = number of records the runner logged for the run.
- **test suite-execution count** = records with `kind === 'test'` (docs-only variant asserts this = 0).
- A `failThenPass`-on run's count **includes** the extra `ref === 'base'` record(s).

## 3. Validate seam key (harness — Q3=A)

The validate seam is stubbed as a map from `(command, ref)` → injected outcome.

| Field | Type | Notes |
|---|---|---|
| `command` | `string` | the resolved validate command (targeted or full) |
| `ref` | `string` | `branch` \| `base` |
| `outcome` | `'pass' \| 'fail'` | injected per invocation |

`failThenPass` variants seed: `(newTestFile, base) → fail`, `(newTestFile, branch) → pass`. The negative variant seeds `(newTestFile, base) → pass` to prove the gate rejects it.

## 4. CI status input (harness — Q4=A, injected via #1133 merge-readiness seam)

| State | Merge-readiness treatment (per #1133) | Final gate raised? |
|---|---|---|
| `success` / green | passed | yes (when validate also green) |
| `skipped` | **NOT** passed | **no** |
| `neutral` | **NOT** passed | **no** |
| `failing` | not passed | no (covered by #1133 unit tests; not re-scenarioed here) |

The `implementation-review` final gate is raised **iff** validate is green **AND** CI is a passing state.

## 5. Consumed config shape (pinned — #1134, `config.ts` / `resolveWorkflowOverrides`)

The bugfix profile the scenarios configure and the docs example encodes. Fields already present on this branch except where noted ABSENT.

| Field | Type | Bugfix value | Status on branch |
|---|---|---|---|
| `review.profile` | `'standard' \| 'verification'` | `verification` | EXISTS |
| `review.blockingSeverity` | `'critical' \| 'major' \| 'minor'` | `critical` | EXISTS |
| `review.failThenPass` | `boolean` | opt-in (`true` in the enabled variant) | flag EXISTS; base-ref execution semantics = #1134 |
| `maxRemediations` | `number` | `2` (bugfix default) | EXISTS |
| `validateCommand` | `string` | targeted template `pnpm --filter "...[origin/<base>]" build && … test` | full-command EXISTS; targeted derivation = #1134 |
| per-workflow `agents.*` | provider/model/effort | cheaper review model/effort | EXISTS (`resolveAgentForPhase`) |

## 6. Findings artifact (pinned — #1124/#1125, cross-ref #1127 contract)

Consumed unchanged. The happy-path scenario seeds a round-1 finding representing a **missing regression test**:

| Field | Value in US1 seed |
|---|---|
| `findings[].severity` | `blocking` (at/above `critical` threshold) |
| `findings[].file` / `.line` | the fixture file whose regression test is missing |
| `findings[].body` | "missing regression test" narrative |
| `round` | increments per re-review |
| `verdict` | `changes-required` round 1 → `clean` after remediate adds the test |

Blocking rule and marker/posting lifecycle are defined in `specs/1127-context-phase-2-integration/contracts/engine-review-integration.md`; not restated here.

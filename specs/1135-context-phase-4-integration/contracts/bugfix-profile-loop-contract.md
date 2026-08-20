# Contract (pin/cross-reference): bugfix-profile loop — verification charter, diff-classification guards, suite-count invariant, validate/CI final gate

**Status**: Pinned by #1135 (P4 integration checkpoint). **Authorship home**: #1134 (verification charter + targeted validate + diff-classification guards + `failThenPass`) and #1133 (merge-readiness `skipped`/`neutral`≠passed, validate/CI parallel semantics, post-validate `implementation-review` final gate). This note **asserts against and cross-references** those; it authors nothing new.
**Owner phase**: worker phase loop (`packages/orchestrator/src/worker/phase-loop.ts`), validate spawn (`cli-spawner.ts`), config resolution (`config.ts` / `resolveWorkflowOverrides`).
**Depends on**: the `remediate → review` loop-control seam (`specs/1123-context-phase-1-integration/contracts/remediate-review-seam.md`) and the marker + findings-artifact pin (`specs/1127-context-phase-2-integration/contracts/engine-review-integration.md`).

This is the durable acceptance artifact for FR-006 / FR-009 / SC-006 / SC-008. It fixes the four boundaries P5 (#1136, docs/migration/rollout) builds against so they are not re-derived from unmerged code.

## 1. Verification review charter (authored by #1134)

| Rule | Value |
|---|---|
| Selection | `review.profile: verification` (vs feature's `standard`); selected via `resolveWorkflowOverrides` for `speckit-bugfix` |
| Bugfix defaults | `blockingSeverity: critical`, `maxRemediations: 2`, cheaper model/effort via per-workflow `agents` config |
| Bugfix risk model | wrong root cause, adjacent regression, **missing proof the bug is fixed** — so the charter flags a **missing regression test** as a blocking finding |
| Verdict source | engine-internal findings artifact + `computeVerdict` (never GitHub review state) — per #1127 §2 |

**Pinned by #1135**: the happy-path scenario asserts the run uses the verification charter (not the feature charter), that a blocking "missing regression test" finding routes into `remediate`, that the remediation adds the test, and that a clean re-review marks the PR ready.

## 2. Diff-classification guard matrix (authored by #1134)

Classification runs **before** validate and selects the validate command.

| Diff class | Resolved validate | Suite-execution count |
|---|---|---|
| **Ordinary source change** (packages) | targeted: `pnpm --filter "...[origin/<base>]" build && … test` | affected set (changed + dependents) — **strictly fewer** than full-workspace |
| **Root-level config** (lockfile / base `tsconfig` / workspace file / CI workflow) | **fall back to the full command** | = full-workspace count |
| **Docs-only** | **skip tests** | test count = **0** |
| **Single-package repo** (pinned, not scenario-tested here) | plain command — `--filter` syntax is meaningless on one package | full/plain — unit-tested by #1134 |

**Pinned by #1135**: US2 exercises the root-config fallback and docs-only skip end-to-end, each asserting its suite-execution count. The single-package guard ships **no integration scenario** here (unit-tested by #1134, mirrors #1132's defer+pin) — cross-referenced above.

## 3. Suite-count invariant (this issue's core efficiency guarantee — FR-002/FR-006)

| Rule | Value |
|---|---|
| Measurement point | an **instrumented stub runner** records each actual test/build suite spawn (Q1=C) — not `--filter`-target count, not command-invocation count, not real suite runs |
| Happy-path invariant | targeted count **= affected-set count** and **< full-workspace count** on the fixture (SC-003) |
| Cross-cutting rule | **every** scenario/variant asserts an explicit suite-execution count; a wrong count fails the variant even when otherwise green (FR-006/SC-006) |
| `failThenPass` cost | an enabled run's count **includes** the base-ref run(s); a disabled run's count omits them (FR-005) |

## 4. Validate / CI final-gate sequencing (authored by #1133)

| Rule | Value |
|---|---|
| Parallelism | targeted validate runs in parallel with CI; asserted as engine sequencing/readiness, **not** wall-clock concurrency |
| CI injection | CI status injected via the **merge-readiness dependency seam** (no real GitHub Actions) |
| `skipped` / `neutral` CI | treated as **NOT passed** |
| Final gate | `implementation-review` is raised **iff** validate is green **AND** CI is a passing state |

**Pinned by #1135**: US1 asserts the green-both-pass positive; dedicated `skipped` and `neutral` scenarios each assert the final gate is **NOT** raised.

## 5. `failThenPass` (authored by #1134)

| Rule | Value |
|---|---|
| Opt-in | `review.failThenPass` (default `false`) |
| On | new/changed test files run against the **base ref**, required to **fail-on-base / pass-on-branch**; a pass-on-base fails the gate |
| Off | no base-ref execution |
| Simulation (harness) | validate seam stubbed on `(command, ref)` returning injected pass/fail (Q3=A) |

## 6. Change control

Changing the verification charter (§1), the guard matrix (§2), the validate/CI sequencing (§4), or `failThenPass` semantics (§5) requires editing the **authoring** issues (#1134/#1133) and updating this pin note's cross-reference. #1135's integration suite is the drift alarm: any change to these boundaries that #1133/#1134 make without updating their contracts will fail the P4 integration suite. The suite-count invariant (§3) is owned by this issue's harness and is the assertion every variant shares.

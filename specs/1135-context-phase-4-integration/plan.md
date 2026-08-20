# Implementation Plan: Bugfix profile end-to-end with targeted validate (Phase-4 integration)

**Feature**: Phase-4 integration checkpoint proving the two P4 product issues — #1134 (verification review charter + targeted validate + diff-classification guards + opt-in `failThenPass`) and #1133 (merge-readiness `skipped`/`neutral`≠passed, validate/CI parallel semantics, post-validate `implementation-review` final gate) — work together end-to-end on the **bugfix profile**, via an integration scenario suite that asserts **suite-execution counts** in every variant, plus per-repo bugfix-profile **config examples in docs** and a durable **loop-contract artifact**.
**Branch**: `1135-context-phase-4-integration`
**Status**: Complete

## Summary

This issue ships **no product behavior of its own** (FR-010). It ships:

1. A **bugfix happy-path integration scenario** (FR-001/FR-002/FR-007 — US1) driving a real worker phase loop on a **synthetic monorepo fixture** through `bugfix issue → implement → verification review (blocking: missing regression test) → remediate (adds test) → clean re-review → ready → targeted validate (affected packages + dependents) in parallel with injected CI → post-validate implementation-review final gate`, for `speckit-bugfix`. It asserts the targeted-validate **suite-execution count equals the affected-set (changed + dependents)** and is **strictly fewer** than the full-workspace suite count on the fixture, and that the final gate is raised only when **both** validate and CI are green.
2. **Diff-classification guard variants** (FR-003/FR-004 — US2): a root-config-touching diff **falls back to the full** validate (count = full-workspace count); a docs-only diff **skips tests** (test count = 0). Each variant asserts its suite-execution count explicitly.
3. **`failThenPass` variants** (FR-005 — US3): with `failThenPass` **on**, the new/changed regression test is executed against the **base ref** and required to **fail-on-base / pass-on-branch** (a pass-on-base fails the gate); with `failThenPass` **off** (default), no base-ref run occurs. Both assert their suite-execution counts.
4. **CI negative-state scenarios** (FR-007, Q4=A): explicit `skipped` and `neutral` CI scenarios, each asserting the `implementation-review` final gate is **NOT** raised.
5. A **docs bugfix-profile config example** (FR-008 — US4) in a repo docs location, **schema-validated by a test** against the shipped P4 config schema so it cannot silently drift.
6. A **loop-contract artifact** (FR-009) documenting the verification-charter shape, the diff-classification guard matrix (incl. the pinned single-package guard), the suite-count invariant, and the validate/CI final-gate sequencing — cross-referencing #1133/#1134 as the authorship home.

Everything the scenarios exercise — the verification charter, targeted-validate command derivation, diff-classification guards, `failThenPass`, merge-readiness evaluation, validate/CI parallelism, and the post-validate final gate — is **consumed, not re-implemented** (FR-010 / Assumptions §99). No test-only double stands in for the profiles themselves; only genuinely external seams (CLI/agent invocation, GitHub calls, CI status, human gate answers, and the suite runner) are mocked/injected through the established phase-loop dependency seams used in #1123/#1127/#1132.

## Dependencies & landing order (rebase-on-develop — mirrors #1123 Q1=B / #1127 Q1=A / #1132)

- **#1134** (verification charter + targeted validate + diff-classification guards + `failThenPass`) merges to `develop` **first**. Authorship home for: `profile: verification` charter selection; the targeted `validateCommand` template (`pnpm --filter "...[origin/<base>]" build && … test`); the **diff-classification guard matrix** (root-config fallback, docs-only skip, single-package plain-command guard); and the `failThenPass` fail-on-base / pass-on-branch semantics.
- **#1133** (merge readiness + validate/CI orchestration) merges to `develop` **first**. Authorship home for: merge-readiness evaluation treating `skipped`/`neutral` CI as **NOT passed**; validate/CI parallel sequencing; and the post-validate `implementation-review` final gate raised only when **both** are green.
- This branch is **rebased** on both (on top of the merged P1–P3 machinery) and ships **only** the six items above. **The implement phase dependency-blocks (skip→requeue-after-deps) until #1133/#1134 land on `develop`.**

## Technical Context

- **Language / runtime**: TypeScript, ESM, Node >= 22.
- **Test framework**: Vitest.
- **Primary package**: `@generacy-ai/orchestrator` (`packages/orchestrator`).
- **Consumed packages**: `@generacy-ai/config` (`OrchestratorSettings`, per-workflow `maxRemediations` + review profile + `validateCommand` via `resolveWorkflowOverrides`), `@generacy-ai/workflow-engine` (`GitHubClient`).
- **Docs**: `docs/` (Docusaurus) for the copy-pasteable config example; a schema-validation test in `packages/orchestrator` (or `packages/config`) parses it against the shipped P4 config schema.
- **No new runtime dependencies.** No product `src/` changes expected — see [Changeset](#changeset).

### Grounding — current code (post-P1/P2/P3, pre-P4-rebase, verified on this branch)

| Concern | Location | Current shape |
|---|---|---|
| Phase loop entry | `phase-loop.ts` `executeLoop` | index-based `for (i = startIndex; i < sequence.length; i++)`; retries + off-sequence backtrack via `i--; continue;` |
| Effective sequence | `phase-loop.ts` `getPhaseSequence(workflow, reviewPhaseEnabled)` | filters `review` out when the flag is false; drives `implement → review ⇄ remediate → validate` |
| Review executor branch | `phase-loop.ts` | `deps.reviewExecutor ? await deps.reviewExecutor.execute(context) : runStubPhase(phase)` — real (#1124) |
| Validate spawn | `cli-spawner.ts` `runValidatePhase(checkoutPath, config.validateCommand, signal)` | launches a single `ShellIntent { kind: 'shell', command: validateCommand }` via `agentLauncher.launch()`; only command string + exit code surfaced |
| Pre-validate install | `cli-spawner.ts` `runPreValidateInstall(checkoutPath, config.preValidateCommand, signal)` | conditional install/build before validate |
| `validateCommand` | `config.ts` (default `'pnpm test && pnpm build'`) | resolved via `resolveWorkflowOverrides` (workflow → repo → cluster) |
| `review.profile` | `config.ts` `'standard' \| 'verification'` | EXISTS |
| `review.blockingSeverity` | `config.ts` `'critical' \| 'major' \| 'minor'` | EXISTS |
| `review.failThenPass` | `config.ts` `boolean` (default `false`) | EXISTS (flag present; targeted base-ref execution semantics are #1134) |
| `maxRemediations` | `config.ts`, `resolveWorkflowOverrides` | feature **3** / bugfix **2** via `defaultMaxRemediations` |
| Cap gate | `config.ts` default `{ phase: 'review', gateLabel: 'waiting-for:remediation-limit', condition: 'on-remediation-limit' }` for feature + bugfix | pauses on `round >= maxRemediations && verdict === 'changes-required'` |
| Per-workflow agents | `.generacy/config.yaml` `orchestrator.agents.workflows.<name>.phases.*`, `resolveAgentForPhase` | cheaper model/effort selectable per phase (used for the verification review agent) |
| P1/P2/P3 harness (template) | `__tests__/phase-loop.review-remediate.integration.test.ts`, `phase-loop.review-clean.integration.test.ts`, `phase-loop.review-remediate-convergence.integration.test.ts` | `createMockDeps()` / `createMockContext()` / `createConfig({ reviewPhaseEnabled: true })` / `getPhaseSequence(workflow, true)` / `phaseStartOrder()` / `fireOnceTrigger()` |

### ABSENT on this branch (delivered by the dependencies, consumed after rebase)

- **Targeted-validate command derivation** — `pnpm --filter "...[origin/<base>]" …` affected-set resolution (#1134). Today `validateCommand` is a static string.
- **Diff-classification guards** — root-config fallback, docs-only skip, single-package plain-command guard (#1134).
- **A per-suite runner seam** — the point at which each individual test/build suite is spawned (the seam this issue **instruments to count executions**, Q1=C). Today `runValidatePhase` spawns one shell; there is no per-suite counting hook.
- **`failThenPass` base-ref execution** — running new/changed test files against the base ref with fail-on-base / pass-on-branch (#1134). The flag exists; the execution does not.
- **Merge-readiness evaluation + CI status handling** — `skipped`/`neutral`≠passed, validate/CI parallel sequencing, the CI-status injection seam, and the post-validate `implementation-review` final gate (#1133). Entirely absent on this branch.

Because these are absent pre-rebase, the exact production API each scenario binds to (the runner seam's shape, the targeted-command derivation entrypoint, the CI-status injection seam, the final-gate raise site) is **resolved at implement time against the merged dependency code**. This plan pins the *behavior* to assert and the *seams* to bind through; it does not guess unmerged signatures.

## Project Structure

```
specs/1135-context-phase-4-integration/
  spec.md                        (read-only)
  clarifications.md              (read-only)
  plan.md                        (this file)
  research.md
  data-model.md
  quickstart.md
  contracts/
    bugfix-profile-loop-contract.md   (verification-charter + guard-matrix + suite-count + validate/CI pin note — FR-009)

packages/orchestrator/src/worker/__tests__/
  fixtures/bugfix-monorepo/                                   (synthetic in-tree fixture — Q2=A; hand-authored dep graph, >=1 package with no dependents)
  phase-loop.bugfix-happy-path.integration.test.ts           (FR-001/FR-002/FR-007 — US1; happy path + suite count + validate/CI final gate)
  phase-loop.bugfix-diff-guards.integration.test.ts          (FR-003/FR-004 — US2; root-config fallback + docs-only skip, each with count)
  phase-loop.bugfix-fail-then-pass.integration.test.ts       (FR-005 — US3; failThenPass on/off, base-ref run + counts)
  phase-loop.bugfix-ci-negative.integration.test.ts          (FR-007 Q4=A — skipped + neutral CI, final gate NOT raised)

docs/docs/reference/                                          (or a package README — Q5=A)
  bugfix-profile-config.md                                   (copy-pasteable per-repo .generacy/config.yaml example — FR-008)

packages/orchestrator/src/**/__tests__/
  bugfix-profile-config-example.test.ts                      (FR-008 Q5=A — parses the docs YAML against the shipped P4 config schema; no drift)
```

## Test design (behavior pinned; API bound at implement time)

All phase-loop scenarios drive `PhaseLoop.executeLoop(context, config, deps, getPhaseSequence('speckit-bugfix', true))` with a **mocked `GitHubClient`** (capturing spy), the **real** review + remediate + validate machinery, per-round verdict steering by **seeding the findings-artifact sidecar** (the mocked launcher pre-writes each round's candidate findings; the real executor recomputes the verdict via `computeVerdict`), and an **instrumented stub runner** at the per-suite seam that records each suite spawn (Q1=C).

### US1 — bugfix happy path + suite count + validate/CI final gate (`phase-loop.bugfix-happy-path.integration.test.ts`)

Config: `profile: verification`, `blockingSeverity: critical`, `maxRemediations: 2`, targeted `validateCommand`, cheaper review agent (per-workflow agents config). Fixture: the synthetic monorepo (data-model §1). Assert:

- The run selects the **verification** charter, not the feature charter (AC1).
- Round-1 review returns a blocking **"missing regression test"** finding → routes off-sequence into `remediate` → the remediation adds the test → a clean re-review calls `markReadyForReview` (AC2).
- The targeted validate resolves to the **affected set (changed packages + dependents)** and the instrumented runner records a suite-execution count **equal to that affected-set count** and **strictly fewer** than the full-workspace count on the fixture (AC3/AC4 / FR-002 / SC-003).
- Validate runs in parallel with **injected green CI**; the `implementation-review` final gate is raised only when **both** validate and CI are green (AC5 / FR-007).
- The remediation counter caps at **2** and the loop converges **before** the cap (AC6).

### US2 — diff-classification guards, each keeps the count honest (`phase-loop.bugfix-diff-guards.integration.test.ts`)

Two variants on the same fixture, driven by seeding the **diff shape** each variant classifies against:

- **Root-config variant** — diff touches a root-level config file (lockfile / base `tsconfig` / workspace file / CI workflow). Assert the resolved validate **falls back to the full command** and the runner records a count **equal to the full-workspace count** (FR-003 / SC-004).
- **Docs-only variant** — diff touches only docs. Assert the classification **skips tests** and the runner records a **test suite-execution count of 0** (FR-004 / SC-004).

Each variant asserts its count explicitly; a wrong count fails the variant even if the run is otherwise green (FR-006 / SC-006).

### US3 — `failThenPass` on/off (`phase-loop.bugfix-fail-then-pass.integration.test.ts`)

The validate seam is **stubbed on (command, ref)** returning injected pass/fail per invocation (Q3=A):

- **`failThenPass` on** — seed **fail** for the base-ref run and **pass** for the branch run. Assert the new/changed regression test **is executed against the base ref**, is required to **fail there and pass on the branch**, and that a variant seeded to **pass on base** fails the gate. The runner count **includes the extra base-ref run** (FR-005 / SC-005).
- **`failThenPass` off (default)** — assert **no base-ref execution** occurs and the count omits it (FR-005 / SC-005).

Both variants assert their suite-execution counts (FR-006).

### CI negative states (`phase-loop.bugfix-ci-negative.integration.test.ts`)

Inject CI status through the **merge-readiness dependency seam** (#1133, Q4=A). With validate green:

- **`skipped` CI** → final gate is **NOT** raised (SC-004 / FR-007).
- **`neutral` CI** → final gate is **NOT** raised (SC-004 / FR-007).

(The green-both-pass positive is asserted in US1.)

### Docs example schema validation (`bugfix-profile-config-example.test.ts`)

Read the shipped docs YAML example, parse it against the **shipped P4 config schema** (`resolveWorkflowOverrides` / the review-profile schema in `config.ts`), and assert it validates and carries `profile: verification`, `blockingSeverity: critical`, `maxRemediations: 2`, a targeted `validateCommand`, and the `failThenPass` toggle (FR-008 / SC-007 / Q5=A).

## Plan decisions

- **D-1 — Rebase-on-develop; consume the real P4 profiles, no doubles.** Only genuinely external seams (CLI/agent invocation, GitHub calls, CI status, human gate answers, and the suite runner) are mocked/injected through the established `PhaseLoopDeps`/`GitHubClient`/`cliSpawner`/merge-readiness seams (Assumption §100). The implement phase dependency-blocks until #1133/#1134 land.
- **D-2 — Suite-execution count observed at an instrumented stub runner seam (Q1=C).** The count is the number of actual test/build suite spawns the runner is asked to execute — **not** the count of `--filter`-resolved package targets (which would double-count nothing the engine actually ran), **not** the count of validate-command invocations, and **not** real 10-minute suite runs. This binds to whatever per-suite spawn seam #1134 exposes; if #1134 spawns a single aggregate shell (as today's `runValidatePhase` does), the implement phase adds the **minimal** per-suite runner injection seam #1134 needs to make suite spawns observable — see [Changeset](#changeset).
- **D-3 — Synthetic in-tree monorepo fixture with a guaranteed strict-subset graph (Q2=A).** A checked-in fixture (`__tests__/fixtures/bugfix-monorepo/`) with a hand-authored dependency graph containing **at least one package with no dependents**, so `changed + dependents` is provably a **strict subset** of the workspace — the only shape on which SC-003's "strictly fewer" comparison is meaningful. Not the live `packages/*` graph (brittle, changes under us) and not a temp-dir generated graph (opaque, harder to reason about).
- **D-4 — `failThenPass` simulated through a (command, ref)-keyed validate seam (Q3=A).** No real suite executes. The seam returns injected pass/fail per invocation; the scenario seeds "fail" for the base-ref run and "pass" for the branch run, and a negative variant seeds "pass on base" to prove the gate rejects it.
- **D-5 — CI status injected via the merge-readiness seam; both positive and explicit negatives (Q4=A).** The green-both-pass positive lives in US1; dedicated `skipped` and `neutral` scenarios each assert the final gate is NOT raised. "Parallelism" is asserted as the engine's sequencing/readiness behavior, not wall-clock concurrency (Assumption §103).
- **D-6 — Docs example lives in `docs/` and is schema-validated (Q5=A).** A copy-pasteable per-repo `.generacy/config.yaml` example ships in a repo docs location and is parsed against the shipped P4 config schema by a test, so it cannot silently drift from the schema.
- **D-7 — Single-package-repo guard deferred + pinned (Assumptions §107).** The plain-command guard (filter syntax meaningless on a one-package repo) is unit-tested by #1134 and **cross-referenced in the loop-contract artifact**; it ships **no dedicated integration scenario** here (mirrors #1132's defer+pin precedent for the merge-conflict entry point).
- **D-8 — Loop-contract artifact is a pin note, not a new authored contract.** `contracts/bugfix-profile-loop-contract.md` cross-references #1133/#1134 as the authorship home and the #1123 seam + #1127 marker/findings pins, recording the verification-charter shape, the diff-classification guard matrix (incl. the pinned single-package guard), the suite-count invariant, and the validate/CI final-gate sequencing so P5 (#1136) builds against a documented boundary (FR-009). It authors no new wire contract.

## Constitution Check

No `.specify/memory/constitution.md` exists in the repo → constitution check skipped.

## Changeset

Per CLAUDE.md's changeset gate: the intended diff is **test-only** under `packages/orchestrator/src/**` (integration scenarios + fixture + docs-example validation test) plus a spec `contracts/` doc and a `docs/` markdown example — so the gate is satisfied by **exemption** and **no `.changeset/*.md` is added** (mirrors #1123/#1127/#1132).

**One caveat (D-2):** if — at implement time — making per-suite spawns observable requires a **minimal non-test seam** under `packages/*/src/` (e.g. an injectable per-suite runner hook that lands in product code because #1134 shipped only an aggregate-shell spawn), that triggers the gate and requires `.changeset/1135-bugfix-profile-integration.md` — `@generacy-ai/orchestrator` **patch** (internal, no new public exports). Decide at implement time; the docs example, contract note, and spec artifacts alone never trigger the gate (the docs markdown is not under `packages/*/src/`).

## Next step

`/speckit:tasks` to generate the dependency-ordered task list.

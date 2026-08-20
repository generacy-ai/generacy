# Research: Bugfix profile end-to-end with targeted validate (Phase-4 integration)

This is a tests-and-docs-only integration checkpoint. "Research" here is (a) resolving the five clarifications into concrete harness decisions and (b) mapping which behavior is consumed-not-built. No new runtime technology is introduced.

## Decision 1 — Suite-execution count is observed at an instrumented stub runner seam (Q1 = C)

**Decision**: The canonical "suite-execution count" is the number of actual test/build suite spawns an **instrumented stub runner** is asked to execute, observed at the runner seam.

**Rationale**: The whole point of the bugfix profile is that fewer suites run. The count must be what the engine *actually spawns*, not a proxy:
- **Rejected A (count `--filter`-resolved package targets)**: measures what the command *would* address, not what ran — decoupled from real execution and can drift from the engine's spawn behavior.
- **Rejected B (count validate-command invocations)**: too coarse — a single targeted command and a single full command both count as "1 invocation," so it cannot express "fewer suites."
- **Rejected D (bind to whatever #1134 exposes)**: correct instinct but under-specified; C names the seam precisely so assertions are consistent across every variant.

**Consequence**: Every scenario reads the same counter. Today `cli-spawner.ts::runValidatePhase` spawns a single aggregate shell; there is no per-suite seam yet. If #1134 ships only an aggregate-shell spawn, the implement phase adds the **minimal** injectable per-suite runner hook needed to make individual suite spawns observable (see plan Changeset caveat). Binding to #1134's real seam (if it ships one) is preferred over adding our own.

## Decision 2 — Synthetic in-tree monorepo fixture, hand-authored graph (Q2 = A)

**Decision**: A self-contained fixture checked into `packages/orchestrator/src/worker/__tests__/fixtures/bugfix-monorepo/`, with N packages and a hand-authored dependency graph that guarantees **≥1 package with no dependents**.

**Rationale**: SC-003's "affected-set count < full-workspace count" is only meaningful when `changed + dependents` is a **strict subset** of the workspace. A leaf package with no dependents guarantees that a change confined to it (or to another package whose dependent-closure excludes the leaf) leaves at least one package unaffected.
- **Rejected B (live `packages/*` graph)**: brittle — the real workspace changes under the test, and its affected-set would drift with unrelated repo edits.
- **Rejected C (temp-dir generated at setup)**: opaque and harder to reason about / debug than a checked-in graph a reviewer can read.

**Shape** (see data-model §1): a small graph such as `core` (leaf, no dependents) plus `a → core`, `b → a`, and an independent `docs`/`util` package, so `changed=core → affected={core, a, b}` is a strict subset of `{core, a, b, util, …}`.

## Decision 3 — `failThenPass` simulated via a (command, ref)-keyed validate seam (Q3 = A)

**Decision**: The validate seam is a stub keyed on `(command, ref)` returning injected pass/fail per invocation. The `failThenPass` scenario seeds **fail** for the base-ref run and **pass** for the branch run; a negative variant seeds **pass-on-base** to prove the gate rejects it.

**Rationale**: Assumptions forbid executing real suites, but FR-005 needs a deterministic fail-on-base / pass-on-branch outcome.
- **Rejected B (real tiny fixture test that genuinely fails without the fix)**: executes real code, adds fixture-maintenance burden, and couples the assertion to a real test runner's behavior.
- **Rejected C (assert issuance only, not outcome)**: under-proves FR-005 — the fail-on-base *guarantee* (not just the issuance) is the point of the profile.

## Decision 4 — CI status injected via the merge-readiness seam; positive + explicit negatives (Q4 = A)

**Decision**: CI status is injected through the merge-readiness dependency seam (#1133). The suite authors a **green-both-pass** positive (in US1) AND explicit **`skipped`** and **`neutral`** negative scenarios, each asserting the `implementation-review` final gate is **NOT** raised.

**Rationale**: FR-007 requires `skipped`/`neutral` to count as NOT passed — a boundary worth a dedicated scenario, not a cross-reference.
- **Rejected B (green only; negatives cross-referenced)**: leaves the "≠passed" boundary unexercised in the integration layer, where regressions in the merge-readiness wiring would surface.
- **Rejected C (single representative negative)**: `skipped` and `neutral` are distinct CI outcomes; asserting both closes the whole "not-green ⇒ not-raised" boundary.

**Note**: "parallelism" is asserted as the engine's sequencing/readiness behavior (validate and CI both gating the final gate), not wall-clock concurrency (Assumptions §103). The harness does not run real GitHub Actions.

## Decision 5 — Docs example in `docs/`, schema-validated (Q5 = A)

**Decision**: The copy-pasteable per-repo bugfix-profile `.generacy/config.yaml` example lives in a repo docs location (`docs/docs/reference/bugfix-profile-config.md` or a package README) AND is asserted valid by a test that parses it against the shipped P4 config schema.

**Rationale**: FR-008/SC-007 want a *known-good* example a repo owner can copy. A schema-validation test guarantees it stays valid as the schema evolves.
- **Rejected B (illustrative YAML in `contracts/` only, no validation)**: not a copy-pasteable *repo docs* example and can silently drift.
- **Rejected C (docs prose + YAML-parses-only test)**: proves it's valid YAML, not valid *config* — the schema conformance is the drift alarm that matters.

## Consumed, not built (FR-010)

| Behavior | Authorship home | This issue |
|---|---|---|
| `profile: verification` charter | #1134 | selects it in config; asserts it drives the run |
| Targeted `validateCommand` (`--filter "...[origin/<base>]"`) | #1134 | asserts the affected-set-vs-full-workspace count |
| Diff-classification guards (root-config fallback, docs-only skip, single-package plain) | #1134 | exercises root-config + docs-only; pins single-package |
| `failThenPass` fail-on-base / pass-on-branch | #1134 | seeds (command, ref) outcomes; asserts base-ref run |
| Merge-readiness `skipped`/`neutral`≠passed, validate/CI parallelism, final gate | #1133 | injects CI status; asserts final-gate raise conditions |
| Verification-charter shape, findings artifact, engine marker | #1124/#1125 (pinned by #1127) | cross-references only |
| `remediate` executor, counter, cap gate | #1128 (pinned by #1132) | consumes; caps at bugfix default 2 |

## Open bindings resolved at implement time (post-rebase)

- The **exact per-suite runner seam** to instrument (Decision 1) — bind to #1134's if it exposes one; otherwise add the minimal hook.
- The **targeted-command derivation entrypoint** and how the diff shape is supplied to it (Decision 2/US2) — bind to #1134.
- The **CI-status injection seam** and the **final-gate raise site** (Decision 4) — bind to #1133.
- The **cheaper review agent** selection for the verification profile — via the existing per-workflow `agents` config (`resolveAgentForPhase`).

## Sources

- `specs/1135-context-phase-4-integration/spec.md`, `clarifications.md`.
- Sibling precedents: `specs/1123-context-phase-1-integration/`, `specs/1127-context-phase-2-integration/`, `specs/1132-context-phase-3-integration/` (rebase-on-develop shape, pin-note contracts).
- Current code: `packages/orchestrator/src/worker/phase-loop.ts`, `cli-spawner.ts`, `config.ts`; `packages/config/src/` (`resolveWorkflowOverrides`).
- Epic: generacy-ai/generacy#1120; dependencies #1133, #1134; docs follow-up #1136.

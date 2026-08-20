# Clarifications: Bugfix profile end-to-end with targeted validate (Phase-4 integration)

## Batch 1 — 2026-08-20

### Q1: Suite-count measurement point
**Context**: FR-002/FR-006 and SC-003/SC-006 require *every* scenario to assert a "suite-execution count," and the whole point of the bugfix profile is that this count is strictly fewer than a full validate. The spec carries an explicit `[NEEDS CLARIFICATION]` here (Assumptions §"Suite-execution count"). The implementer must know exactly what number to count and where to observe it, or the assertions can't be written consistently across variants.
**Question**: What is the canonical measurement point for "suite-execution count"?
**Options**:
- A: Count of `--filter`-resolved package targets the resolved validate command would run against (parse the resolved command / filter expansion).
- B: Count of distinct validate-command invocations the engine issues (one per command the merge-readiness/validate orchestration spawns).
- C: An instrumented stub runner that records each actual test/build suite spawn it is asked to execute (count observed at the runner seam).
- D: Bind at /plan against #1134's shipped targeted-validate implementation, whichever of the above matches its real seam.

**Answer**: *Pending*

### Q2: Monorepo fixture provenance & shape
**Context**: The affected-set-vs-full-workspace comparison (SC-003) is only meaningful on a real multi-package dependency graph where changed-plus-dependents is a strict subset of the workspace. Assumptions say the fixture "is authored as part of the harness," but not whether it is a synthetic in-tree fixture or the real repo graph, nor what shape guarantees the strict-subset property.
**Question**: How should the monorepo fixture be sourced and shaped?
**Options**:
- A: A synthetic, self-contained fixture checked into the test tree (N packages with a hand-authored dependency graph) that guarantees at least one package with no dependents, so changed+dependents is provably a strict subset.
- B: Reuse this repo's actual `packages/*` workspace graph as the fixture (drive `pnpm --filter` against the live graph).
- C: A synthetic fixture generated at test setup time (temp dir + programmatically written package.json graph), torn down after.

**Answer**: *Pending*

### Q3: `failThenPass` base-vs-branch simulation
**Context**: FR-005 requires the `failThenPass` variant to run new/changed test files against the base ref and require fail-on-base / pass-on-branch — but Assumptions forbid executing real suites. The harness needs a defined way to make the same test "fail" on base and "pass" on branch through the validate seam, or the scenario can't be authored deterministically.
**Question**: How does the harness simulate the fail-on-base / pass-on-branch result for `failThenPass`?
**Options**:
- A: The validate seam is a stub keyed on (command, ref) that returns injected pass/fail per invocation; the scenario seeds "fail" for the base-ref run and "pass" for the branch run.
- B: A real minimal test file in the fixture that genuinely fails without the fix and passes with it (real execution of the tiny fixture test only, not the full suite).
- C: Assert only that the engine *issues* the base-ref run with the correct command/ref (issuance, not outcome), leaving outcome semantics to #1134's unit tests.

**Answer**: *Pending*

### Q4: CI-status injection seam & negative-state coverage
**Context**: FR-007 drives #1133's validate/CI final-gate orchestration with injected CI status, and requires that `skipped`/`neutral` CI count as NOT passed. The implementer needs to know the injection seam and which CI states get dedicated scenarios versus only the green happy path.
**Question**: Through what seam is CI status injected, and which CI states require dedicated scenarios?
**Options**:
- A: Inject via the merge-readiness dependency seam; author both a green-both-pass scenario AND explicit negative scenarios for `skipped` and `neutral` (each asserting the final gate is NOT raised).
- B: Inject via the merge-readiness seam; happy path (green) only — negative CI states are covered by #1133's own unit tests and merely cross-referenced in the contract artifact.
- C: Inject green for the happy path plus a single representative negative state (e.g. `skipped`), with `neutral`/`failing` pinned in the contract artifact but not scenario-tested.

**Answer**: *Pending*

### Q5: Docs config-example location & validation
**Context**: FR-008/SC-007 require a copy-pasteable per-repo bugfix-profile `.generacy/config.yaml` example. The implementer needs to know where it lives and whether it must be machine-validated against the real P4 config schema (so it can't silently drift) versus shipped as illustrative prose.
**Question**: Where does the docs example live, and must it be schema-validated?
**Options**:
- A: In a repo docs location (e.g. `docs/` or a package README) AND asserted valid by a test that parses it against the shipped P4 config schema (no drift).
- B: Inside this feature's `contracts/` artifact only, as illustrative YAML (no automated schema validation).
- C: In a docs location as prose/example, plus a lightweight test that only checks the example parses as YAML (not full schema conformance).

**Answer**: *Pending*

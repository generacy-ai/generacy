# Clarifications

## Batch 2026-08-21

### Q1: Base-ref runnability strategy
**Context**: FR-004 offers two mutually-exclusive ways to keep the base-ref run non-vacuous: detect an infrastructure-failure signature and skip, OR make the base run genuinely runnable via a build step. The whole fail-then-pass correctness hinges on which is authoritative.
**Question**: How should the base-ref run be made non-vacuous when the base env cannot resolve `dist`?
**Options**:
- A: Signature-detect infra failure at the base ref and emit a non-blocking `skip` (logged); add no build step.
- B: Add an explicit build step (e.g. `pnpm build`) in the base worktree so `dist` resolves, then run tests normally.
- C: Both — attempt the build; if it fails, fall back to a non-blocking `skip` with reason.

**Answer**: A — Signature-detect an infrastructure failure at the base ref and emit a non-blocking `skip` (logged); add no build step. The spec Assumptions bless conservative infra-signature detection as an acceptable alternative to a build step, and the clarification set adds a wall-clock cap only for test runs (Q5), not a base build.

### Q2: Infra-failure signature scope
**Context**: FR-004/FR-005 and the Assumptions require conservative detection so a genuine base-ref test failure is never masked as "infra" (which would wrongly satisfy the proof). We must define what counts as an infra signature.
**Question**: What signal distinguishes an infrastructure failure (→ `skip`) from a genuine base test outcome (→ `base-passed`/`branch-failed`)?
**Options**:
- A: Only pre-collection failures — vitest exits having collected/run zero tests (e.g. "No test files found", module/dist resolution error before any test runs). Any test that was collected and failed is a genuine outcome.
- B: Broader — also treat known build/dist error substrings anywhere in the output as infra, even if some tests ran.
- C: Any non-zero base run in which zero tests executed is infra; everything else is genuine.

**Answer**: A — Only pre-collection failures (vitest exits having collected/run zero tests, e.g. "No test files found" or a dist-resolution error before any test runs) count as infra; any collected-and-failed test is a genuine outcome. The signature must be conservative so a real base-ref failure is never masked as infra; substring matching (B) risks masking genuine failures when some tests ran.

### Q3: Existence-filter & zero-project guard placement
**Context**: `classifyDiff` is documented as pure / no-I/O, but FR-001 (existence filtering) and FR-003 (zero-project fallback) both require filesystem / pnpm probing. This decides whether the classifier's purity contract is preserved.
**Question**: Where should the existence-filtering and zero-project-fallback logic live?
**Options**:
- A: Keep `classifyDiff` pure — do existence filtering (fs) and the zero-project fallback in the targeted-validate wiring layer; the classifier receives already-existence-filtered paths.
- B: Give the classifier I/O (inject an `exists`/project-probe callback) and move both checks inside `classifyDiff`.

**Answer**: A — Keep `classifyDiff` pure; do existence-filtering (fs) and the zero-project fallback in the targeted-validate wiring layer, passing already-filtered paths to the classifier. `classifyDiff` is contractually documented "Pure, deterministic, no I/O … never throws"; injecting fs/pnpm I/O breaks the #1134 contract its unit-testability depends on.

### Q4: main-based repo doc fix (FR-010)
**Context**: FR-010 offers a `<base>` placeholder in the custom `validateCommand` (code change, mirrors the merge-conflict `<base>` substitution) OR a doc-only fix that stops hardcoding `origin/develop`.
**Question**: How should the `main`-based-repo doc example be fixed?
**Options**:
- A: Add a `<base>` placeholder substituted with the resolved base branch in custom `validateCommand`, and update the doc to use it.
- B: Doc-only — remove the hardcoded `origin/develop`, explain how to adapt per repo; no code substitution.

**Answer**: A — Add a `<base>` placeholder substituted with the resolved base branch in custom `validateCommand`, and update the doc to use it. A direct precedent exists (the merge-conflict `<base>`/`<branch>` substitution); custom commands are returned verbatim today, so a code substitution actually fixes main-based repos rather than only warning in docs.

### Q5: Test-run wall-clock cap (FR-006)
**Context**: The base/branch `pnpm vitest run` invocations have no timeout today; the install step does (`BASE_INSTALL_TIMEOUT_MS`). FR-006 requires a cap that never stalls validate past the cli-spawner cap.
**Question**: How should the test-run wall-clock cap be defined?
**Options**:
- A: A dedicated constant (mirroring `BASE_INSTALL_TIMEOUT_MS`) applied as a per-run `timeout` on each test run, independent of the install cap.
- B: Derive a single shared budget from the cli-spawner phase cap, split across install + base + branch runs.

**Answer**: A — A dedicated constant (mirroring `BASE_INSTALL_TIMEOUT_MS`) applied as a per-run timeout on each test run, independent of the install cap. The install path already uses a dedicated per-operation constant; mirroring it for the test runs is the smallest, most consistent change and is exactly what the Assumptions endorse.

# Clarifications: Validate-origin remediation must consume budget and have a reliable stop

## Batch 1 — 2026-08-21

### Q1: Budget bump location
**Context**: FR-001 offers two implementations — "bump at the seam or route through `RemediateExecutor`". The choice is load-bearing: `RemediateExecutor` already carries the timeout envelope (FR-006), commit/push-on-clean-exit semantics (FR-007), and the `bumpRemediationCount` call in one place, whereas `ValidateFixHandler` is a separate adapter that would need each of those added independently. This decides whether the validate-origin path converges onto the review-origin machinery or stays a parallel adapter with the four fixes bolted on.
**Question**: How should validate-origin remediation consume the budget?
**Options**:
- A: Add a single `bumpRemediationCount` call at the seam (`phase-loop.ts:1718-1746`), keeping `ValidateFixHandler` as the adapter and implementing FR-006/FR-007 inside it.
- B: Route validate-origin remediation through `RemediateExecutor` so it inherits the existing bump, timeout, and commit/push semantics; retire the separate `ValidateFixHandler` spawn path.
- C: Keep `ValidateFixHandler` but have it call the shared `bumpRemediationCount` + the shared timeout/commit helpers `RemediateExecutor` uses, without full routing.

**Answer**: *Pending*

### Q2: Stable fingerprint "reason" derivation
**Context**: FR-004/FR-005 require a `reason` derived from "command + failing-test identity" that is stable across output noise (timings, parallel ordering). "Failing-test identity" is underspecified: extracting test names requires parsing framework-specific output, which is itself a source of fragility. The scope of what goes into the hashed `reason` determines both stability and cross-framework robustness.
**Question**: What should the stable validate-failure `reason` be composed of?
**Options**:
- A: Effective command + a parsed, sorted set of failing-test identifiers extracted from the runner output (framework-aware parsing).
- B: Effective command + a normalized output tail (strip timings/durations/ordering, then hash) — no per-test parsing.
- C: Effective command + exit descriptor only (coarsest stable identity; treats any failure of the same command as the same defect).

**Answer**: *Pending*

### Q3: Timeout-kill vs non-zero-exit interaction
**Context**: US3/FR-006 add a SIGTERM→SIGKILL timeout; FR-007 says a non-zero fixer exit MUST NOT commit or push. A timeout kill produces a non-zero exit, but the fixer may have written partial work. The review-origin `RemediateExecutor` pattern commits partial work on timeout (so the counter is consumed and progress is preserved). These two behaviors conflict on the validate path.
**Question**: When the fixer is killed by the timeout (non-zero exit with partial changes on disk), what happens?
**Options**:
- A: Discard — treat timeout-kill like any non-zero exit: no commit, no push (FR-007 is absolute).
- B: Preserve — commit and push partial work on timeout (mirror `RemediateExecutor`), and reserve FR-007's no-push only for a clean-run non-zero exit.
- C: Discard partial work but still count the attempt against the budget (no push, but `remediationCount` increments).

**Answer**: *Pending*

### Q4: Cap-round escape signal on the validate path
**Context**: The `on-remediation-limit` gate trips on `remediationCount >= maxRemediations` AND `verdict === 'changes-required'` (`phase-loop.ts:1419-1438`). US1 AC3 says a clean landing on the cap round must proceed to `validate` rather than pause. On the validate-origin path the driving signal is validate pass/fail, not a review verdict — so it is unclear what plays the role of "verdict" at the cap.
**Question**: On the validate-origin path, what determines whether the cap round pauses vs proceeds?
**Options**:
- A: Re-run `validate` after the cap-round fix; a passing re-run is the clean escape (proceeds), a still-failing re-run pauses at the gate.
- B: The gate's `verdict` conjunct is satisfied whenever validate is still failing at the cap; a validate pass clears the loop before the gate is evaluated.
- C: On the validate path, pause at the cap unconditionally once `remediationCount >= maxRemediations` (drop the verdict conjunct for this origin).

**Answer**: *Pending*

### Q5: Shared vs separate remediation budget
**Context**: `remediationCount` is a single per-run counter today, bumped by the review-origin `RemediateExecutor`. If validate-origin remediations bump the same counter, a run that does N review remediations then M validate remediations shares one `maxRemediations` budget across both origins. This affects when mixed loops pause.
**Question**: Should review-origin and validate-origin remediations draw from one shared budget or separate budgets?
**Options**:
- A: One shared `remediationCount` / `maxRemediations` across both origins (simplest; a run's total remediation attempts are bounded regardless of origin).
- B: Separate per-origin counters, each bounded by `maxRemediations` independently.
- C: Shared counter, but `maxRemediations` is scaled/raised when both origins can fire in one run.

**Answer**: *Pending*

# Implementation Plan: Validate-origin remediation must consume budget and have a reliable stop

**Feature**: Route validate-origin remediation through `RemediateExecutor` so it consumes the shared `remediationCount` budget, gains a reliable stop (fingerprint + cap gate), enforces a CLI timeout, respects the fixer exit code, and cites the effective validate command.
**Branch**: `1158-severity-major-p1-validate`
**Status**: Complete

## Summary

Four defects on the validate-origin branch of the remediate seam leave the review→remediate loop with **no working stop** when `reviewPhaseEnabled` is on:

1. **Budget never consumed** — the seam dispatches `ValidateFixHandler` then `runStubPhase('remediate')` with no `bumpRemediationCount` (`phase-loop.ts:1718-1746`); the `on-remediation-limit` gate can never fire.
2. **Fingerprint backstop unreliable** — validate evidence sets no `reason` (`phase-loop.ts:988` passes `classifier: undefined`), so the fingerprint hashes the raw, nondeterministic output tail and never repeats.
3. **Adapter has no timeout, ignores exit code** — `ValidateFixHandler.handle` awaits `exitPromise` with no CLI timeout and commits/pushes on any exit (`validate-fix-handler.ts:118-128`).
4. **Evidence cites the wrong command** — `config.validateCommand` instead of the targeted effective command (`phase-loop.ts:988-989, 1035`).

**Fix (per Batch-1 clarifications):** collapse the seam's two branches into one that routes **both** origins through `RemediateExecutor` (Q1=B), retiring the `ValidateFixHandler` dispatch. `RemediateExecutor` already bumps `remediationCount` on every return path, owns the SIGTERM→grace→SIGKILL envelope, and its output is committed/pushed by `commitPushAndEnsurePr('remediate')` — inheriting FR-001/FR-006/FR-007 for free. Give validate evidence a stable `reason` = effective command + `hashValidationEvidence(stdout).hash` (Q2=A) so the fingerprint is deterministic. Thread the resolved `effectiveValidateCommand` into evidence/finding/alert (FR-008). Expose a `timedOut` flag on the executor's `PhaseResult` so the shared seam commits partial work on a timeout-kill but skips commit/push on a clean-run non-zero exit (Q3=B / FR-007). The synthesized `changes-required` critical finding already carries the validate output, so `RemediateExecutor`'s existing charter reads it directly — no new charter section.

Shared budget across both origins (Q5=A) falls out of routing through the single `RemediateExecutor` / single `remediationCount` / single gate. On the cap round, `RemediateExecutor` runs, the loop re-enters `review` (synthetic success), then `validate` re-runs; a passing re-run escapes clean, a still-failing re-run re-synthesizes `changes-required` and pauses at `on-remediation-limit` (Q4=A).

## Technical Context

- **Language/runtime**: TypeScript, Node ≥22, ESM.
- **Package**: `@generacy-ai/orchestrator` (`packages/orchestrator/src/worker/`). No cross-package public surface change; `RemediateExecutor` and the seam are orchestrator-internal.
- **Feature flag**: `reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED` (default OFF). With the flag OFF, `review`/`remediate` are absent from the effective sequence and the validate-routing block at `phase-loop.ts:971` never runs → behavior byte-identical to today (FR-009 / SC-006).
- **Key existing seams reused**:
  - `RemediateExecutor.execute(context)` — `remediate-executor.ts` — bumps `remediationCount` on spawn-fail (`:141`), wait-error (`:195`), normal-exit (`:216`); SIGTERM→SIGKILL timer (`:171-186`).
  - `commitPushAndEnsurePr('remediate')` — commits/pushes remediate output, honors the #1051 `pushRefused` abort.
  - `on-remediation-limit` gate — `phase-loop.ts:1419-1438` — `artifact.remediationCount >= maxRemediations && artifact.verdict === 'changes-required'`.
  - `hashValidationEvidence(stdout)` — `evidence-hash.ts:32-176` — framework-aware parse+sort of failing-test ids with whole-transcript fallback (already imported by `validate-fix-handler.ts`).
  - `computeFailureFingerprint` — `failure-fingerprint.ts:62` — keys on `evidence.reason ?? evidence.outputTail`.
  - `resolveTargetedValidate` / `effectiveValidateCommand` — `phase-loop.ts:696-706, 1815-1904` — already resolved for the bugfix workflow.
- **Dependencies**: `#1128` (RemediateExecutor, gate, `bumpRemediationCount`), `#1129` (validate routing), `#1156` (`markedReadyByEngine` sidecar carry-forward) — all merged to `develop`.

## Project Structure

Files touched (all under `packages/orchestrator/src/worker/`, plus one test dir):

```
remediate-executor.ts        MOD  expose `timedOut` on PhaseResult (track SIGTERM/SIGKILL); no budget-bump change
types.ts                     MOD  add optional `timedOut?: boolean` to PhaseResult (if not already present)
phase-loop.ts                MOD  (1) seam 1717-1769: collapse branches → route both origins through RemediateExecutor,
                                       gate commit/push on `exitCode === 0 || timedOut`, drop ValidateFixHandler dispatch
                                  (2) failure routing 988: pass stable `reason` (effective cmd + hashValidationEvidence hash)
                                       into buildErrorEvidence (new optional explicit-reason arg)
                                  (3) hoist `effectiveValidateCommand` to phase-iteration scope; use it at 988-989, 1035 (FR-008)
                                  (4) buildErrorEvidence: accept an explicit `reason` independent of `classifier`
validate-fix-handler.ts      DEL  retire the file + its ValidateFixHandler/ValidateFixIntent wiring (Q1=B)
                                  (see RISK: sibling-overlap guard loss)
claude-cli-worker.ts         MOD  drop `validateFixHandler` construction + injection into PhaseLoopDeps
__tests__/                   NEW  seam routing, timedOut gating, stable-reason fingerprint, effective-command, flag-OFF
```

`ValidateFixIntent` (in `@generacy-ai/generacy-plugin-claude-code`) and the launch-plugin `case 'validate-fix'` become dead once the handler is retired — remove them as part of the change (verify no other caller via grep before deleting).

## Constitution Check

No `.specify/memory/constitution.md` exists in the repo → constitution check skipped.

## Key Risks

- **RISK-1 (sibling-overlap guard loss).** `ValidateFixHandler` enumerated sibling-owned files and reverted+threw on overlap (`validate-fix-handler.ts:153-215`). `RemediateExecutor` has no equivalent. Retiring the handler drops that protection on the validate-origin path. Mitigation: the generic `commitPushAndEnsurePr` push-guard (#1051) blocks pushes to merged/closed PRs, and the review round re-scopes — but per-file sibling ownership is not re-checked. Documented as an accepted scope reduction (spec Out of Scope names redesign of the loop; the guard is not called out as required). Flag for reviewer sign-off; if unacceptable, port `collectSiblingOwnedFiles` into a `RemediateExecutor` post-commit guard as a follow-up.
- **RISK-2 (shared-seam convergence).** Gating commit/push on `exitCode === 0 || timedOut` changes the **review-origin** path too (today it always commits after the executor). This is the intended Q3=B semantics and a beneficial convergence (a clean-run non-zero remediate exit should not push a broken fix either), but it is a behavior change beyond the validate-origin path — call it out explicitly in the PR description.
- **RISK-3 (scope hoist).** `effectiveValidateCommand` is declared inside the `else if (phase === 'validate')` execution block (`:696`) and is out of scope at the failure-routing block (`:971`). It must be hoisted to the per-iteration scope. Verify no shadowing and that the plain-default path still resolves it for non-bugfix workflows.

## Next Step

`/speckit:tasks` to generate the task list.

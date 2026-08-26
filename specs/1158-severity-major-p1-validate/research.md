# Research: Validate-origin remediation budget + reliable stop

All decisions ground in Batch-1 clarifications (`clarifications.md`) and the code at develop `155b3464`.

## Decision 1 — Route validate-origin remediation through `RemediateExecutor` (Q1=B / FR-001)

**Decision.** Collapse the remediate seam (`phase-loop.ts:1717-1769`) so both origins call `deps.remediateExecutor.execute(context)` (falling back to `runStubPhase('remediate')` when unwired), then `commitPushAndEnsurePr('remediate')`. Delete the `pendingValidateRemediation` dispatch of `ValidateFixHandler`.

**Rationale.** `RemediateExecutor` is the sole `bumpRemediationCount` caller on every return path (`remediate-executor.ts:141,195,216`), owns the SIGTERM→grace→SIGKILL timer (`:171-186`), and its output is committed/pushed by the existing seam. The synthesized validate finding is written as a `changes-required` critical `ReviewFinding` (`phase-loop.ts:1033-1055`) that `RemediateExecutor` already reads via `readReviewArtifact` + open-blocking filter — so the fixer receives the validate output through the charter with **no new charter code**. This inherits FR-001 (budget), FR-006 (timeout), and FR-007 (commit/push semantics) in one move.

**Alternatives rejected.**
- **A (bump at the seam, keep the adapter):** re-implements the timeout + commit/push gating inside `ValidateFixHandler`; duplicates the exact machinery `RemediateExecutor` already ships.
- **C (adapter calls shared helpers):** same duplication risk, plus two spawn code paths to keep in sync.

**What `pendingValidateRemediation` still carries.** After routing through the executor, the only remaining consumer of `pendingValidateRemediation` is the *presence flag* distinguishing the two origins — no longer needed for dispatch. It can be dropped entirely, since the synthesized finding + `remediationCount` on the sidecar already encode the validate-origin state. The `evidence`/`prNumber`/`baseBranch` payload was consumed only by the retired adapter.

## Decision 2 — `timedOut` flag on the executor result gates commit/push (Q3=B / FR-007)

**Decision.** Add `timedOut?: boolean` to `PhaseResult` (`types.ts:179`). In `RemediateExecutor`, set a `timedOut` local `true` inside the SIGTERM timer callback; return it on the normal-exit path (`:225-231`) and the wait-error path (`:200-207`). At the seam, gate commit/push:

```
const shouldPush = remediateResult.exitCode === 0 || remediateResult.timedOut === true;
if (shouldPush) {
  const outcome = await prManager.commitPushAndEnsurePr('remediate');
  if (outcome.pushRefused) return { ...abort... };
  if (outcome.prUrl) context.prUrl = outcome.prUrl;
}
```

**Rationale.** A timeout-kill is a non-zero exit but may have written partial work worth preserving (Q3=B). A clean-run non-zero exit means the fixer ran to completion and failed — pushing its output ships a broken change (FR-007 no-push). The executor already distinguishes these internally (the timer fired vs. the process exited on its own) but currently collapses both into `success: false` at `:227`. `timedOut` surfaces the distinction the seam needs.

**Alternatives rejected.**
- **A (discard on timeout):** strips the only progress a timing-out attempt makes; contradicts `RemediateExecutor`'s design intent (`:11-18`).
- **C (discard work but bump budget):** loses partial fixes for no benefit; budget already bumps regardless.

**Note on the wait-error path.** `child.exitPromise` rejecting after a SIGKILL lands in the `catch` at `:191`. That path must also report `timedOut: true` when the timer fired, so a SIGKILL'd fixer's partial work is still committed. Track `timedOut` in the enclosing scope, not just after the timer.

## Decision 3 — Stable fingerprint `reason` (Q2=A / FR-004 / FR-005)

**Decision.** At `phase-loop.ts:988`, build the validate `reason` explicitly instead of leaving it unset:

```
const { hash } = hashValidationEvidence(validateEvidence.stdout);
const reason = `${effectiveValidateCommand} :: ${hash}`;
const cmdEvidence = this.buildErrorEvidence(effectiveValidateCommand, result, DEFAULT_VALIDATE_TIMEOUT_MS, undefined, reason);
```

and change `buildErrorEvidence` (`:2388`) to accept an optional 5th `explicitReason?: string` that sets `reason` on the returned `CommandExitEvidence` **independent of `classifier`** (today `reason` is set only when `classifier` is passed, `:2415`). `computeFailureFingerprint` keys on `evidence.reason ?? evidence.outputTail` (`failure-fingerprint.ts:62`), so a stable `reason` makes the fingerprint deterministic across output noise.

**Rationale.** `hashValidationEvidence` already parses+sorts failing-test identifiers with a whole-transcript fallback (`evidence-hash.ts:32-176`) — exactly the "command + failing-test identity" the spec wants. No new parser. Two failures for the same defect hash identically even when timings/ordering differ → the `-repeated` backstop escalates at `REPEAT_FAILURE_THRESHOLD` (SC-002/SC-003).

**Alternatives rejected.**
- **B (normalized output tail):** what already fails — normalization is brittle across runners.
- **C (exit descriptor only):** collapses distinct defects to one fingerprint.

## Decision 4 — Thread the effective validate command (FR-008)

**Decision.** Hoist `effectiveValidateCommand` (`phase-loop.ts:696`) out of the `else if (phase === 'validate')` execution block to the per-iteration scope so it is visible at the failure-routing block (`:971-1079`). Use it in place of `config.validateCommand` at the fingerprint/alert evidence (`:988-989`) and the synthesized finding's `file` (`:1035`).

**Rationale.** For speckit-bugfix, `resolveTargetedValidate` narrows the built-in default to a workspace-filter form (`:705`); the alert/finding must reflect what actually ran. `effectiveValidateCommand` already equals `config.validateCommand` for non-bugfix workflows, so hoisting is safe and the non-targeted path is unchanged.

**Scope caveat.** Declare `let effectiveValidateCommand = config.validateCommand;` before the phase-execution if/else; assign the targeted value inside the validate branch. Confirm no shadow re-declaration remains inside the block.

## Decision 5 — Cap-round escape re-runs validate (Q4=A)

**Decision.** No new code. Routing through `RemediateExecutor` + the existing loop gives Q4=A for free: after the executor + commit, the loop `i--; continue;` re-enters `review` (synthetic success for validate-origin), which flows to `validate`. A passing re-run proceeds; a still-failing re-run re-enters the routing block, re-synthesizes `changes-required`, and — with `remediationCount` now at the cap — trips `on-remediation-limit` before another remediate fires.

**Rationale.** The gate is evaluated on the `review` phase using the synthesized stamp; only a fresh validate pass is authoritative (clarifications Q4). The executor's budget bump is what makes the gate reachable (the pre-fix stub never bumped).

## Decision 6 — Retire `ValidateFixHandler` and its intent (Q1=B)

**Decision.** Delete `validate-fix-handler.ts`, drop its construction/injection in `claude-cli-worker.ts`, and remove `ValidateFixIntent` + the `case 'validate-fix'` launch branch in `@generacy-ai/generacy-plugin-claude-code` after grep-confirming no other caller.

**Rationale.** Once the seam routes through `RemediateExecutor`, the adapter has no invocation site. Leaving it in place is dead code that re-invites the four defects.

**Accepted loss (RISK-1).** The adapter's sibling-owned-file overlap guard (`collectSiblingOwnedFiles` + revert-on-overlap, `:153-215`) has no `RemediateExecutor` equivalent. The generic push-guard (#1051) covers merged/closed-PR pushes but not per-file sibling ownership. Documented in `plan.md` for reviewer sign-off; port as a follow-up if required.

## Open verification items (resolve at implement time)

1. Grep `ValidateFixIntent` / `validate-fix` across all packages to confirm the plugin branch and any tests are the only remaining references before deletion.
2. Confirm `child.exitPromise` reject-vs-resolve behavior on SIGKILL in the launcher's `ProcessFactory` so `timedOut` is reported on whichever path fires.
3. Confirm `commitPushAndEnsurePr('remediate')` is a no-op when the executor produced no diff (clean-run non-zero exit with no partial work) so the skip is redundant-safe, not load-bearing.

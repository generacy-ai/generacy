# Data Model: Validate-origin remediation budget + reliable stop

No new persisted schema. This change extends two in-process shapes and reuses the existing `ReviewArtifactSchema` unchanged. No new label vocabulary (`waiting-for:remediation-limit` / `completed:remediation-limit` already ship from #1128).

## Entity 1 — `PhaseResult` (extended)

`packages/orchestrator/src/worker/types.ts:179`

Add one optional field:

```ts
export interface PhaseResult {
  // ...existing fields...
  /**
   * True when the phase process was killed by the executor's timeout
   * (SIGTERM→grace→SIGKILL), as opposed to exiting on its own with a non-zero
   * code. Lets the remediate seam preserve partial work on a timeout-kill
   * (commit/push) while skipping commit/push on a clean-run non-zero exit
   * (#1158 FR-007 / Q3=B). Undefined ⇒ not timed out.
   */
  timedOut?: boolean;
}
```

**Producer.** `RemediateExecutor.execute` sets `timedOut: true` on the normal-exit and wait-error return paths iff the SIGTERM timer fired. All other producers (validate, CLI phases, stub) leave it `undefined`.

**Consumer.** The remediate seam (`phase-loop.ts:~1751`): `exitCode === 0 || timedOut === true` ⇒ commit/push; else skip.

**Validation.** None (plain boolean). Absence is a valid "did not time out" signal.

## Entity 2 — `CommandExitEvidence.reason` (now settable independent of classifier)

`buildErrorEvidence` (`phase-loop.ts:2388`) returns `CommandExitEvidence`. Today `reason` is populated only when a `classifier` string is passed (`:2415`). Add an optional explicit-reason parameter so the validate path can set a stable `reason` without a classifier:

```ts
private buildErrorEvidence(
  command: string,
  result: PhaseResult,
  resolvedTimeoutMs?: number,
  classifier?: string,
  explicitReason?: string,   // NEW
): CommandExitEvidence {
  // ...exitDescriptor unchanged...
  const reason = classifier ? message : explicitReason;
  return {
    command,
    exitDescriptor,
    outputTail,
    ...(reason !== undefined ? { reason } : {}),
  };
}
```

**Invariant.** `classifier` still wins when both are present (classifier is the post-exit failure descriptor; explicit reason is the fingerprint key). No other call site passes `explicitReason`, so all existing evidence is byte-identical.

## Entity 3 — Validate fingerprint `reason` (composed value)

Not a schema — the string written into `CommandExitEvidence.reason` on the validate-origin path:

```
reason = `${effectiveValidateCommand} :: ${hashValidationEvidence(stdout).hash}`
```

- `effectiveValidateCommand` — `TargetedValidateDecision.effectiveCommand` for speckit-bugfix, else `config.validateCommand`.
- `hash` — SHA-256 over the parsed+sorted failing-test identifier set (whole-transcript fallback), from `evidence-hash.ts:32-176`.

**Stability property (FR-005 / SC-002).** Two validate failures for the same underlying defect produce identical `reason` even when raw stdout differs in timings/ordering, because `hashValidationEvidence` normalizes to the failing-test id set. `computeFailureFingerprint` (`failure-fingerprint.ts:62`) then yields a stable fingerprint → the `-repeated` backstop escalates at `REPEAT_FAILURE_THRESHOLD`.

## Entity 4 — `ReviewArtifactSchema` (unchanged, referenced)

`review-artifact.ts`. The validate-routing block already synthesizes a `changes-required` artifact carrying `remediationCount` forward (`phase-loop.ts:1050`). After this change:

- `remediationCount` is **incremented by `RemediateExecutor`** on every validate-origin remediation (was: never), making `on-remediation-limit` reachable.
- The synthesized critical `ReviewFinding.file` becomes `effectiveValidateCommand` (was `config.validateCommand`) — FR-008.

No field additions. The `on-remediation-limit` gate predicate (`remediationCount >= maxRemediations && verdict === 'changes-required'`) is untouched.

## Retired shapes

- `ValidateFixIntent` (`@generacy-ai/generacy-plugin-claude-code`) — removed with the handler.
- `ValidateFailureEvidence` / `ValidateFixContext` (`validate-fix-handler.ts:17-30`) — removed with the file. `pendingValidateRemediation`'s payload (`evidence`, `prNumber`, `baseBranch`) had no consumer after the adapter is retired; the state variable is dropped.

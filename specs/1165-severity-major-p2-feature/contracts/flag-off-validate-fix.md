# Contract: flag-OFF validate-fix fallback (Corner 1)

**File**: `packages/orchestrator/src/worker/phase-loop.ts` (`executeLoopInner`)
**Precondition**: `phase === 'validate'` and the phase result is a failure
(the point where control currently reaches the escalation fall-through at
`:1092-1108`).

## Placement

A new branch inserted **after** the flag-ON validate-fix block
(`:971-1090`, guarded on `config.reviewPhaseEnabled === true`) and **before** the
escalation fall-through (`:1092`). The two branches are mutually exclusive by flag
value.

## Guard

Fire the fallback iff **all** hold:

- `phase === 'validate'`
- `config.reviewPhaseEnabled !== true` (flag OFF — the default)
- `flagOffValidateFixAttempted === false` (block-local; not yet attempted this run)
- `deps.remediateExecutor` is defined

If the guard fails, fall through to the existing escalation
(`buildErrorEvidence` → `escalateAndAlert` → `failed:validate`) unchanged.

## Steps (on fire)

1. Set `flagOffValidateFixAttempted = true` (binds to exactly one attempt).
2. Synthesize a `changes-required` review artifact identical in shape to the
   flag-ON path (`:1038-1075`): one `critical` open `ReviewFinding` citing
   `effectiveValidateCommand` with fenced/bounded validate stdout+stderr, carrying
   `remediationCount` and `markedReadyByEngine` forward from any prior artifact.
   *(Factor the synthesis into a shared private helper called by both the flag-ON
   block and this branch, to prevent divergence.)*
3. Run `remediateResult = await deps.remediateExecutor.execute(context)`.
4. Push-gate (identical to the seam at `:1775-1839`):
   `shouldPush = remediateResult.exitCode === 0 || remediateResult.timedOut === true`.
   - If `shouldPush`: `commitPushAndEnsurePr('remediate')`; honor a `pushRefused`
     abort (`return { results, completed: false, lastPhase: 'remediate', gateHit:
     false }`); persist the post-bump `remediationCount` to the Redis mirror
     (best-effort) as the seam does.
   - Else: revert the working tree via
     `context.github.discardWorkingTreeChanges(['.generacy'])` (preserve the
     sidecar); if the revert throws, abort the loop
     (`return { …, completed: false, lastPhase: 'remediate', gateHit: false }`).
5. `i--` to re-run the `validate` phase.
6. `continue`.

## Termination

- If the re-run `validate` **passes**, the loop proceeds normally to completion.
- If the re-run `validate` **fails again**, the guard's
  `flagOffValidateFixAttempted === false` is now false → the fallback does not fire
  → control falls through to the existing escalation → `failed:validate`.

This yields exactly "one bounded fix attempt before escalation" (D1=A / FR-001).

## Invariants

- **INV-1**: At most one remediate attempt per phase-loop execution on the flag-OFF
  path (block-local boolean; no persisted counter).
- **INV-2**: A non-successful, non-timeout remediate leaves the branch untouched
  (revert-on-non-push), so a failed fixer cannot land partial work.
- **INV-3**: The flag-ON validate-fix path (`:971-1090`) and the review→remediate
  seam (`:1754-1849`) are unchanged. The new branch is dead when
  `reviewPhaseEnabled === true`.
- **INV-4**: The non-failing validate path and all non-validate phases are
  byte-identical to pre-change (FR-009).

## Test assertions (FR-002)

- Flag OFF + validate fails once + remediate succeeds + validate re-run passes ⇒
  loop completes; no `failed:validate`; exactly one `remediateExecutor.execute`
  call.
- Flag OFF + validate fails + remediate runs + validate fails again ⇒ exactly one
  `remediateExecutor.execute` call, then `failed:validate` escalation.
- Flag OFF + validate fails + `deps.remediateExecutor` undefined ⇒ escalates
  immediately (no attempt).
- Flag ON path and non-validate phases unaffected (regression guard).

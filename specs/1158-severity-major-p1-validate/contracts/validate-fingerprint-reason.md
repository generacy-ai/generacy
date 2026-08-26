# Contract: Stable validate-failure fingerprint `reason`

Location: `packages/orchestrator/src/worker/phase-loop.ts` validate-routing block (`:988`) + `buildErrorEvidence` (`:2388`).

## Requirement

Validate-failure evidence MUST carry a `reason` that is stable across test-output nondeterminism (timings, parallel ordering), so `computeFailureFingerprint` (`failure-fingerprint.ts:62`, keys on `reason ?? outputTail`) yields the same fingerprint for the same underlying defect and the `-repeated` backstop escalates at `REPEAT_FAILURE_THRESHOLD`.

## `reason` composition (FR-004 / Q2=A)

```
reason = `${effectiveValidateCommand} :: ${hashValidationEvidence(validateEvidence.stdout).hash}`
```

- `hashValidationEvidence` (`evidence-hash.ts:32-176`) — parses + sorts failing-test identifiers, whole-transcript fallback. Already imported by the (retired) handler; import into `phase-loop.ts`.
- `effectiveValidateCommand` — the hoisted targeted command (see `validate-command-threading` note below), not `config.validateCommand`.

## `buildErrorEvidence` change

Add an optional 5th parameter that sets `reason` independent of `classifier`:

```ts
private buildErrorEvidence(command, result, resolvedTimeoutMs?, classifier?, explicitReason?): CommandExitEvidence {
  // ...
  const reason = classifier ? message : explicitReason;
  return { command, exitDescriptor, outputTail, ...(reason !== undefined ? { reason } : {}) };
}
```

**Compatibility.** No existing call site passes `explicitReason`; every current evidence payload is byte-identical (only the validate-routing call at `:988` opts in).

## FR-008 — effective command threading

At `:988-989` (evidence `command`) and `:1035` (synthesized finding `file`), use `effectiveValidateCommand`, not `config.validateCommand`. Requires hoisting the `effectiveValidateCommand` declaration (`:696`) to the per-iteration scope so it is visible at the failure-routing block.

## Guarantees

| # | Guarantee | Verified by |
|---|-----------|-------------|
| F1 | Two failures for the same defect, differing only in output noise, produce identical fingerprints. | SC-002 |
| F2 | The `-repeated` backstop escalates at threshold on a nondeterministic validate loop. | SC-003 |
| F3 | The fingerprint, alert, and synthesized finding reference the effective command when it differs from `config.validateCommand`. | FR-008 |

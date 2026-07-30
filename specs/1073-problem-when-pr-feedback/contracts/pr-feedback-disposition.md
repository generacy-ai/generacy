# Contract: PR-feedback disposition dispatcher

**Feature**: `1073-problem-when-pr-feedback`
**File**: `packages/orchestrator/src/worker/pr-feedback-handler.ts:487-590`

This is the sole contract that changes. Documents the decision table before and after the fix, plus the retargeted `resolveSuccesses === 0` branch at `:625-633`.

---

## Inputs

| Symbol | Source | Semantics |
|--------|--------|-----------|
| `preFixSha` | `getHeadSha(checkoutPath)` at `:453` (existing) | Branch HEAD before the CLI spawns. `null` on git failure. |
| `postCliSha` | `getHeadSha(checkoutPath)` between spawn and push-guard (NEW) | Branch HEAD after the CLI exits. `null` on git failure. |
| `cliSelfCommitted` | Derived: `postCliSha !== null && preFixSha !== null && postCliSha !== preFixSha` (NEW) | True iff the head advanced during the CLI invocation and both SHA reads succeeded. |
| `success` | `spawnClaudeForFeedback` return field (existing) | `true` iff the CLI exited 0. |
| `timedOut` | `spawnClaudeForFeedback` return field (existing, #1070) | `true` iff the CLI hit `phaseTimeoutMs`. |
| `hasChanges` | `commitAndPushChanges` return value (existing) | `true` iff the handler's own commit step found and pushed diff. |
| `retryAttempt` | `PrFeedbackMetadata.retryAttempt ?? 0` (existing, #1070) | Auto-retries dispatched so far for this trigger, including this dispatch. |
| `resolveSuccesses` | Count of `outcomes.filter(o => o.resolveResult.ok)` at `:622` (existing) | Number of review threads that transitioned to resolved this cycle. |

---

## Decision table — BEFORE this fix (post-#1070)

Evaluated top-to-bottom; first matching row wins.

| # | `timedOut` | `success` | `hasChanges` | Outcome | Label applied | Source |
|---|-----------|-----------|--------------|---------|---------------|--------|
| B4 | `true` | any | `false` | Terminal: `blocked:fixer-timeout-no-progress`. Return. | `blocked:fixer-timeout-no-progress` | `:534-548` |
| B5 | `true` | any | `true`, `retryAttempt < 2` | Retry-eligible: `blocked:fixer-timeout`. Return. | `blocked:fixer-timeout` | `:550-572` |
| B6 | `true` | any | `true`, `retryAttempt >= 2` | Terminal: `blocked:fixer-timeout-repeat`. Return. | `blocked:fixer-timeout-repeat` | `:550-572` |
| B1/B2/B3 | `false` | `false` OR `hasChanges: false` | — | Blocked: `blocked:stuck-feedback-loop`. Return. | `blocked:stuck-feedback-loop` | `:577-590` |
| Happy | `false` | `true` | `true` | Fall through to reply/resolve loop. | — | `:592+` |

**Bug**: row B1/B2/B3 fires on the CLI-self-commit case (CLI committed and pushed → `success: true, hasChanges: false`) and misapplies `blocked:stuck-feedback-loop`.

---

## Decision table — AFTER this fix

New row **B0** inserted between B6 and B1/B2/B3. `cliSelfCommitted` is the sole new discriminator; timeout branches unaffected.

| # | `timedOut` | `success` | `hasChanges` | `cliSelfCommitted` | Outcome | Label applied |
|---|-----------|-----------|--------------|--------------------|---------|---------------|
| B4 | `true` | any | `false` | any | Terminal | `blocked:fixer-timeout-no-progress` |
| B5 | `true` | any | `true`, retry<2 | any | Retry-eligible | `blocked:fixer-timeout` |
| B6 | `true` | any | `true`, retry>=2 | any | Terminal | `blocked:fixer-timeout-repeat` |
| **B0 (NEW)** | `false` | any | `false` | **`true`** | Fall through to reply/resolve loop. Distinct info log. | — |
| B1/B2/B3 | `false` | `false` OR `hasChanges: false` | **`false`** | Blocked | `blocked:stuck-feedback-loop` |
| Happy | `false` | `true` | `true` | any (but typically `false`) | Fall through to reply/resolve loop | — |

**Equivalent code shape** for rows B0 + B1/B2/B3:

```ts
if (!cliSelfCommitted && (!success || !hasChanges)) {
  // existing B1/B2/B3 body — logger.warn + addBlockedStuckFeedbackLoopLabel + return
}
// implicit B0 fall-through — a distinct logger.info fires here on the cliSelfCommitted path
if (cliSelfCommitted && !hasChanges) {
  this.logger.info(
    { prNumber, issueNumber, source: 'cli', disposition: 'cli-self-committed',
      preFixSha, postFixSha: postCliSha },
    'CLI self-committed changes — proceeding to reply/resolve',
  );
}
```

---

## `resolveSuccesses === 0` branch (`:625-633`) — updated decision

Evaluated only after the reply/resolve loop completes on the happy path. Retargeted per FR-013 / clarification Q1→B.

| `cliSelfCommitted` OR `hasChanges` (= "head advanced") | `resolveSuccesses` | Outcome | Label applied |
|--------------------------------------------------------|--------------------|---------|---------------|
| `true` | `0` | Blocked (NEW branch) | `blocked:resolve-failed` |
| `false` | `0` | Blocked (existing branch, unchanged) | `blocked:stuck-feedback-loop` |
| any | `> 0` | Continue to Disposition C body-gate | — |

**Equivalent code shape**:

```ts
if (resolveSuccesses === 0) {
  const headAdvanced = cliSelfCommitted || hasChanges;
  if (headAdvanced) {
    this.logger.warn(
      { prNumber, issueNumber, outcomes, preFixSha, postFixSha: postCliSha },
      'commit pushed but resolve batch had zero successes — entering blocked:resolve-failed disposition (#1073)',
    );
    await this.addBlockedResolveFailedLabel(github, owner, repo, issueNumber);
  } else {
    this.logger.warn(
      { prNumber, issueNumber, outcomes },
      'commit pushed but resolve batch had zero successes — persisting trigger, entering blocked-stuck-feedback-loop disposition',
    );
    await this.addBlockedStuckFeedbackLoopLabel(github, owner, repo, issueNumber);
  }
  return;
}
```

Note the "head advanced" condition here is `cliSelfCommitted || hasChanges`, not just `cliSelfCommitted`. The `hasChanges: true` case (handler-commit path) also represents "head advanced" — those cycles reach this branch too when their commit lands but resolves fail. The original pre-fix code always applied `blocked:stuck-feedback-loop` on both sides; the new split routes both "head-advanced" sources (CLI-committed OR handler-committed) to `blocked:resolve-failed`.

---

## Invariants preserved

- **INV-1** (FR-006): timeout branches B4/B5/B6 fire before any `cliSelfCommitted` check. A CLI that timed out AND pushed a partial commit still lands in B5/B6, not B0. The pre-#1070 dispatcher shape is preserved verbatim for the timeout family.
- **INV-2** (FR-011): monitor-side `blocked:*` short-circuit at `pr-feedback-monitor-service.ts:373-389` is unchanged. Both new labels (`blocked:resolve-failed`) and existing (`blocked:stuck-feedback-loop`) route through the same gate.
- **INV-3** (FR-005): `blocked:stuck-feedback-loop` on the dispatcher-level branch (row B1/B2/B3) is applied on exactly the same input conditions as before, minus the CLI-self-commit case. Genuine no-diff cycles still get the label.
- **INV-4** (Assumption 7): `evaluatePushGuard` at `:474-485` fires between the SHA capture and the `commitAndPushChanges` call. A refused push exits via `handlePushRefused` and never reaches the dispatcher.
- **INV-5** (Assumption 8): #1047 body-gate at `:669-700` runs AFTER the reply/resolve loop. The `cliSelfCommitted` fall-through does NOT bypass Disposition C — a self-commit cycle that leaves body findings unaddressed still lands `blocked:body-finding-unaddressed`.

---

## Rejected alternatives (for reference)

**Alt A**: place the `cliSelfCommitted` check as a fourth guard inside the B1/B2/B3 condition (`!success || (!hasChanges && !cliSelfCommitted)`). Rejected — obscures the decision at the read site; better to make the discriminator explicit at the branch level.

**Alt B**: reset `hasChanges = true` when `cliSelfCommitted && !hasChanges`. Rejected — mutates a name that carries a specific meaning ("did the *handler* push?"), creating a semantic mismatch with the log field. The two facts are separable and should stay so.

**Alt C**: consolidate both `add*BlockedLabel` calls under a single dispatch table keyed by disposition string. Rejected — five existing sibling methods already exist without table-driven dispatch; introducing the abstraction now would touch five extra call sites for a fix that adds exactly one method. Consistent with the "don't refactor beyond what the task requires" rule.

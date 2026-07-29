# Implementation Plan: PR-feedback handler mislabels a successful CLI self-commit cycle as no-diff

**Feature**: Detect fixer-CLI self-commit cycles as successful by comparing branch HEAD SHA across the CLI invocation, so `blocked:stuck-feedback-loop` no longer lands on cycles that actually pushed a commit.
**Branch**: `1073-problem-when-pr-feedback`
**Status**: Complete

## Summary

`PrFeedbackHandler.handle()` in `packages/orchestrator/src/worker/pr-feedback-handler.ts:487-590` derives its `hasChanges` signal exclusively from its own `commitAndPushChanges()` step. When the fixer CLI has already committed and pushed (working tree clean, exit 0), `hasChanges` is `false`, the dispatcher falls through B1/B2/B3 at `:577-590`, and `blocked:stuck-feedback-loop` lands on a cycle that fully succeeded. The label then gates re-dispatch in `PrFeedbackMonitorService` and the pipeline stops until a human clears the label.

Fix: capture `postCliSha` via `getHeadSha()` between `spawnClaudeForFeedback()` and `commitAndPushChanges()`, derive `cliSelfCommitted = postCliSha !== preFixSha`, and gate the B1/B2/B3 branch on `!cliSelfCommitted && (!success || !hasChanges)`. Timeout dispositions (B4/B5/B6 at `:534-573`) run ahead and are unaffected. The `resolveSuccesses === 0` branch at `:625-633` is retargeted: head-advanced-but-resolve-failed applies the new `blocked:resolve-failed` label (per clarification Q1→B); head-unchanged continues to apply `blocked:stuck-feedback-loop`. A distinct log line names the disposition `'cli-self-committed'` and carries both SHAs so the claim is auditable.

Composition: additive to #1070's four-way dispatcher (timeout branches fire before the new SHA check), non-conflicting with #1047's body-finding gate (which runs after the reply/resolve loop), non-conflicting with #1051's push-guard (which fires earlier and short-circuits). No changes to `PrFeedbackMonitorService`, `PrFeedbackMetadata`, `QueueItem`, or the `blocked:*` short-circuit.

## Technical Context

**Language / runtime**: TypeScript (Node.js ≥22), ESM. Same as the surrounding worker code.

**Dependencies (all already present)**:
- `@generacy-ai/workflow-engine` — label vocabulary (`label-definitions.ts`), `GitHubClient` interface.
- `pino` — structured logging (existing `this.logger`).
- `node:child_process` — `git rev-parse HEAD` via existing `executeCommand` helper.
- Vitest — test framework (existing `pr-feedback-handler.test.ts` and siblings).

**Zero new runtime dependencies.** The `getHeadSha()` helper at `pr-feedback-handler.ts:1111-1124` is reused verbatim — same command, same fallback (`null` on git failure → `cliSelfCommitted = false`, safe direction).

**Load-bearing existing invariants**:
- `preFixSha` at `:453` is captured BEFORE `spawnClaudeForFeedback` (documented at `:446-452`). This is the pre-CLI anchor.
- `commitAndPushChanges` at `:939+` is idempotent when the working tree is clean (returns `false` without side effects).
- The `finally` at `:737-746` clears `agent:in-progress` on every terminal exit — the new success path benefits from it automatically.
- `getHeadShortSha` at `:1131-1144` reads HEAD directly, so on the CLI-self-commit path the `shortSha` at `:593` already reflects the CLI's commit — no synthesis needed.
- The `<preFixSha>..HEAD` diff range at `:656-657` already spans the CLI commit, so `commitTouchedFiles` is correct on this path without change.

## Project Structure

Files modified (four production files + two test files + one changeset):

```
packages/
  workflow-engine/src/actions/github/
    label-definitions.ts                              # +1 entry: blocked:resolve-failed
  orchestrator/src/worker/
    pr-feedback-handler.ts                            # dispatcher gate + log lines + new label method
    __tests__/
      pr-feedback-handler.cli-self-commit.test.ts    # NEW — regression tests (FR-009, FR-010, US4)
  cockpit/src/state/
    precedence.ts                                     # +1 entry in WAITING_PIPELINE_ORDER
    __tests__/
      precedence.test.ts (or classifier.test.ts)      # +assertion for blocked:resolve-failed ordering

.changeset/
  1073-cli-self-commit-detection.md                   # NEW — @generacy-ai/workflow-engine minor,
                                                      #        @generacy-ai/orchestrator patch,
                                                      #        @generacy-ai/cockpit patch
```

### `packages/orchestrator/src/worker/pr-feedback-handler.ts` (~5 edits)

1. **`:30-49` label constants** — add `const BLOCKED_RESOLVE_FAILED_LABEL = 'blocked:resolve-failed';` next to the sibling `BLOCKED_*` constants.
2. **`:465-486` between `spawnClaudeForFeedback` and `evaluatePushGuard`** — capture `const postCliSha = await this.getHeadSha(checkoutPath);` and derive `const cliSelfCommitted = postCliSha !== null && preFixSha !== null && postCliSha !== preFixSha;`. **Load-bearing placement**: MUST be after `spawnClaudeForFeedback` returns (otherwise `postCliSha === preFixSha` trivially) AND before `commitAndPushChanges` (otherwise a rare "CLI produced changes but did not commit" case would let the handler's own commit shift HEAD and produce a false-positive `cliSelfCommitted`).
3. **`:502-512` happy-path log line** — split the existing `logger.info` at `:502-506` into two guarded branches with a new `source: 'cli' | 'handler'` field, per FR-007 / clarification Q3→A. Also add `source: 'handler'` to the timeout-partial-push warn at `:508-511` for the taxonomy to be symmetric.
4. **`:577-590` B1/B2/B3 branch** — retarget the gate to `if (!cliSelfCommitted && (!success || !hasChanges))`. Body unchanged. If the gate falls through (i.e., `cliSelfCommitted === true`), emit a distinct `logger.info` line: `{ prNumber, issueNumber, disposition: 'cli-self-committed', source: 'cli', preFixSha, postFixSha: postCliSha }` with message `'CLI self-committed changes — proceeding to reply/resolve'`. Falls through to the happy-path reply/resolve loop at `:592+`.
5. **`:625-633` `resolveSuccesses === 0` branch** — split by `cliSelfCommitted` (equivalently: check `postCliSha !== preFixSha` — same signal). Head-advanced-and-zero-resolves → `blocked:resolve-failed` (new). Head-unchanged (handler-commit path with zero resolves) → `blocked:stuck-feedback-loop` (existing).
6. **After `:1242`** — add `addBlockedResolveFailedLabel(github, owner, repo, issueNumber)` mirroring the shape of `addBlockedFixerTimeoutLabel` at `:1176-1194`.

### `packages/workflow-engine/src/actions/github/label-definitions.ts` (+1 entry)

Add to the `WORKFLOW_LABELS` array after the four existing `blocked:*` labels (`:110-129`):

```ts
  {
    name: 'blocked:resolve-failed',
    color: 'D73A4A',
    description: 'PR-feedback code changes landed but thread reply/resolve failed — check GitHub API responses (#1073).',
  },
```

### `packages/cockpit/src/state/precedence.ts` (+1 entry)

Insert `'blocked:resolve-failed'` into `WAITING_PIPELINE_ORDER` at `:26-51` immediately after `'blocked:fixer-timeout-repeat'` (line 35). Rationale: `blocked:resolve-failed` is a terminal blocked state (like the two fixer-timeout terminals) and MUST outrank `waiting-for:address-pr-feedback` so cockpit surfaces the specific cause. It is NOT retry-eligible (unlike `blocked:fixer-timeout` at `:44`) — no auto-retry path exists for a resolve failure.

### `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.cli-self-commit.test.ts` (NEW)

Follows the sibling-file naming pattern (`pr-feedback-handler.push-guard.test.ts`, `pr-feedback-handler.gate-reassert.test.ts`). Test cases:

- **T-SC-001** (FR-009): `spawn` returns `{ success: true, timedOut: false }`, `commitAndPushChanges` returns `false`, `getHeadSha` returns `'sha-A'` before spawn and `'sha-B'` after → assert zero `add*Blocked*Label` calls AND N reply/resolve calls (one per trusted thread).
- **T-SC-002** (FR-010): same as T-SC-001 but `getHeadSha` returns `'sha-A'` both before AND after → assert `addBlockedStuckFeedbackLoopLabel` is called exactly once.
- **T-SC-003** (SC-003 log audit): capture `logger.info` calls, assert exactly one has `disposition: 'cli-self-committed'` with `preFixSha` and `postFixSha` fields present; assert no `logger.warn` call has message matching `/no-diff cycle/`.
- **T-SC-004** (SC-004 unreachability): assertion combining T-SC-001 test conditions — `msg: "No changes to commit"` and `no-diff cycle` warn MUST NOT co-occur when `postCliSha !== preFixSha`.
- **T-US4-B** (FR-013): head advanced + `resolveSuccesses === 0` → assert `addBlockedResolveFailedLabel` called, `addBlockedStuckFeedbackLoopLabel` NOT called.
- **T-US4-B-inverse** (FR-013 complement): head unchanged + `resolveSuccesses === 0` → assert `addBlockedStuckFeedbackLoopLabel` called, `addBlockedResolveFailedLabel` NOT called. (Guards against over-retargeting.)
- **T-Q4-caveat** (FR-008a): assert both `preFixSha` and `postFixSha` (long form) appear in the CLI-self-commit log payload — required for reader-audit per clarification Q4 caveat.

Test fixture strategy: reuse mock scaffolding from `pr-feedback-handler.test.ts`. Stub `getHeadSha` at the method level (spy) or inject SHAs via a test double. The existing test file already stubs `commitAndPushChanges` and `spawnClaudeForFeedback`.

### `.changeset/1073-cli-self-commit-detection.md` (NEW)

```
---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": patch
"@generacy-ai/cockpit": patch
---

Detect fixer-CLI self-commit cycles in PR-feedback handler by comparing branch HEAD SHA across the CLI invocation, so `blocked:stuck-feedback-loop` no longer lands on cycles that actually pushed a commit (#1073). New `@generacy-ai/workflow-engine` label vocabulary entry `blocked:resolve-failed` for the narrower case where code changes landed but thread reply/resolve failed — separated from `blocked:stuck-feedback-loop` because the two require different operator remediation (check GitHub API responses vs. read fixer transcripts). Orchestrator's `PrFeedbackHandler` disposition dispatcher gains a head-advance check between the CLI spawn and the pre-existing B1/B2/B3 branch; timeout branches (B4/B5/B6 from #1070) are unaffected. Log lines gain a `source: 'cli' | 'handler'` field on both the CLI-self-commit and handler-commit paths, and the CLI-self-commit path carries `preFixSha` + `postFixSha` so the head-advance claim is auditable rather than asserted (clarification Q4 caveat). Cockpit `WAITING_PIPELINE_ORDER` gains `blocked:resolve-failed` ahead of `waiting-for:address-pr-feedback` (mirrors the terminal `blocked:fixer-timeout-*` precedence). No changes to `PrFeedbackMonitorService`, `PrFeedbackMetadata`, `QueueItem`, or the `blocked:*` short-circuit; this is a producer-side fix.
```

## Constitution Check

No `.specify/memory/constitution.md` file present in this repo — skipping formal constitution check. The change respects the CLAUDE.md project rules:

- **Changeset gate** (CLAUDE.md § Changesets): a newly-added `.changeset/1073-cli-self-commit-detection.md` file covers non-test diffs under `packages/workflow-engine/src/`, `packages/orchestrator/src/`, and `packages/cockpit/src/`. Bump levels follow CLAUDE.md's `workflow-engine` label-vocabulary rule (**minor**) and internal-defect rule (**patch** for orchestrator + cockpit).
- **Comments** (CLAUDE.md § Doing tasks): new comments limited to the load-bearing SHA-capture placement rationale (comment 2 above) and the split-branch retargeting rationale in the `resolveSuccesses === 0` branch. All other edits are self-explanatory from the code.
- **No half-finished work**: US4 lands with the fix, not deferred. Test coverage lands with the fix.
- **No speculative abstractions**: `cliSelfCommitted` is a local `const`, not a class field or a strategy object. `addBlockedResolveFailedLabel` mirrors the shape of five existing sibling methods rather than introducing a table-driven label dispatcher.

## Related Artifacts

- `research.md` — technology decisions with rationale (SHA capture placement, label taxonomy choice, cockpit precedence, test file colocation).
- `data-model.md` — type shapes touched (`cliSelfCommitted` local, `PrFeedbackMetadata` unchanged, new label constant).
- `contracts/pr-feedback-disposition.md` — updated dispatcher decision table (the sole contract that changes).
- `quickstart.md` — how to verify the fix locally with a synthetic worker log fixture.

## Success Criteria (from spec)

- SC-001: CLI-self-commit cycle applies zero `blocked:*` labels and runs reply/resolve → asserted by T-SC-001.
- SC-002: Genuine no-diff cycle still applies `blocked:stuck-feedback-loop` → asserted by T-SC-002.
- SC-003: Exactly one `disposition: 'cli-self-committed'` log line per self-commit cycle → asserted by T-SC-003.
- SC-004: Historical contradictory log sequence unreachable → asserted by T-SC-004.
- SC-005: Behavioral parity of reply-and-resolve loop across handler-commit and CLI-self-commit paths → asserted by code-audit + T-SC-001 (same reply/resolve mocks called).
- SC-006 (intentionally breached per Q1→B): `workflow-engine/src/` diff bounded to `label-definitions.ts` — bounded intentional breach.
- SC-007: Existing #1070 timeout-disposition tests pass unmodified → `pnpm --filter @generacy-ai/orchestrator test pr-feedback-handler` green.

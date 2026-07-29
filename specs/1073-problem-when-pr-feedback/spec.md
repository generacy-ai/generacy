# Feature Specification: PR-feedback handler mislabels a successful CLI self-commit cycle as no-diff

**Branch**: `1073-problem-when-pr-feedback` | **Date**: 2026-07-29 | **Status**: Clarified
**Source**: [generacy-ai/generacy#1073](https://github.com/generacy-ai/generacy/issues/1073)

## Summary

`PrFeedbackHandler` at `packages/orchestrator/src/worker/pr-feedback-handler.ts:487-590` derives its `hasChanges` signal exclusively from its own `commitAndPushChanges()` step. When the fixer CLI has already committed and pushed its work (working tree returns clean, exit 0), the handler concludes `hasChanges === false`, falls through the B1/B2/B3 branch at `:577-590`, and applies `blocked:stuck-feedback-loop` — to a cycle that fully succeeded. The `blocked:*` label then gates re-dispatch in `PrFeedbackMonitorService`, so the successful cycle is indistinguishable from a wedged one and the pipeline stops until a human intervenes.

Fix intent: detect success *by the branch HEAD SHA advancing across the CLI invocation*, independent of whether the handler's own commit step found anything to do. `preFixSha` is already captured at `pr-feedback-handler.ts:453` for the `getCommitTouchedFiles` gate — post-CLI HEAD lookup is the same cheap `git rev-parse HEAD` call, already implemented as `getHeadSha()`.

## Observed

generacy#1069 / PR #1071, 2026-07-28. Worker log:

```
20:16:35  (CLI commits 4a006c61 and pushes)
20:16:48  msg: "No changes to commit — skipping commit/push"
20:16:48  msg: "no-diff cycle — persisting trigger, entering blocked-stuck-feedback-loop disposition"
          trigger: "unresolvedThreads>0"   reason: "no-diff"
20:16:50  msg: "Added blocked:stuck-feedback-loop label"
20:16:52  msg: "PR feedback addressing completed"
```

Thirteen seconds before the handler declared "no changes", the CLI had committed and pushed `4a006c61`, which addressed all three review findings across `.github/workflows/ci.yml`, `redis-queue-adapter.script-wiring.test.ts`, and `redis-queue-adapter.test.ts` (~250 LOC). CLI exit code was `0`. Tree was clean *because the work was already committed*. The handler cannot tell that state apart from "the agent did nothing".

Downstream damage on this instance: a follow-up review was posted correcting findings that had already been addressed; an operator cleared the label by hand so the fixer could run again; the fixer then partly reverted its own correct work.

## Relationship to #1070 and #849

Same disposition dispatcher, adjacent cause. #1070 (merged as `63436bff`) split the **timeout** case out of `blocked:stuck-feedback-loop`. This is the **self-commit** case. The same two complaints apply: wrong cause named, no path back without a human.

#1070's disposition dispatcher (`pr-feedback-handler.ts:521-590`) is the natural place to add this branch. #1070's widened `SpawnClaudeResult` shape (`{ success, exitCode, timedOut }`) is the natural place to carry the head-advanced signal — or a sibling parameter alongside it.

`/cockpit:resume` (#891, planning) is unrelated: this bug produces a `blocked:*` label, not a `failed:<phase>` label. Even after resume lands, this defect still requires manual `gh issue edit --remove-label` to unstick.

## User Stories

### US1: Fixer CLI's own commit is treated as a successful cycle (P1)

**As** the orchestrator's PR-feedback pipeline,
**I want** to recognize a CLI-self-commit cycle as successful,
**So that** review threads get replied to and resolved, no `blocked:*` label lands, and the pipeline keeps flowing without operator intervention.

**Acceptance Criteria**:
- [ ] When the branch HEAD SHA at cycle-end differs from `preFixSha`, the handler executes the same reply-and-resolve loop it runs when its own commit step produced changes.
- [ ] No `blocked:*` label is applied on this path.
- [ ] Every thread trusted at cycle start receives a reply and a resolve attempt.

### US2: Genuine no-diff cycle still gets blocked-stuck-feedback-loop (P1)

**As** an operator watching the pipeline,
**I want** the existing `blocked:stuck-feedback-loop` behavior preserved when nothing actually happened,
**So that** the wedge case #1070's sibling label vocabulary was designed for is still surfaced.

**Acceptance Criteria**:
- [ ] When post-CLI HEAD SHA equals `preFixSha` AND the handler's own commit step found no changes AND the CLI exited 0, `blocked:stuck-feedback-loop` is applied unchanged.
- [ ] Timeout dispositions (#1070 B4/B5/B6 at `:534-573`) are unchanged — they run before the head-SHA check.

### US3: A reviewer can distinguish the two cases from logs alone (P2)

**As** a reviewer triaging a stalled PR,
**I want** the log line for a CLI-self-commit cycle to say so explicitly,
**So that** I do not have to run `git log` against the branch to figure out what happened.

**Acceptance Criteria**:
- [ ] The self-commit success log line names the disposition (e.g., `disposition: 'cli-self-committed'`) and includes both `preFixSha` and `postFixSha` (or the short forms).
- [ ] The genuine no-diff log line remains distinguishable (existing `disposition: 'no-diff'` at `:583` preserved).

### US4: Head advanced but thread resolution failed is a distinct failure (P2)

**As** the pipeline,
**I want** a CLI-self-commit cycle where the head advanced but reply-or-resolve failed to surface as its own failure mode,
**So that** the recovery action is scoped to the reply/resolve failure and does not borrow the semantically-wrong `blocked:stuck-feedback-loop` label.

**Acceptance Criteria**:
- [ ] Existing `handleThreadOutcomes` failure paths from the handler-commit success branch (`:606-619+`) apply identically on the CLI-self-commit path, **except** that the head-advanced-but-resolve-failed case applies a new `blocked:resolve-failed` label rather than reusing `blocked:stuck-feedback-loop`.
- [ ] New label `blocked:resolve-failed` is added to `workflow-engine`'s label vocabulary (minor bump) and applied by the `resolveSuccesses === 0` branch when the branch HEAD advanced during the cycle. `blocked:stuck-feedback-loop` continues to apply on that branch only when the head did NOT advance. Resolved per clarification Q1 → B.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Capture the branch HEAD SHA *after* `spawnClaudeForFeedback()` returns (and, load-bearing, *before* `commitAndPushChanges()` runs) so the handler's own subsequent commit does not confound the "did the CLI push?" signal. | P1 | Mirror the existing `getHeadSha(checkoutPath)` call at `:453`. |
| FR-002 | Introduce a `cliSelfCommitted` (or `headAdvanced`) boolean derived from `postCliSha !== preFixSha && postCliSha !== null && preFixSha !== null`. Null on either side → treated as `false` (safe direction, matches `commitTouchedFiles` degradation at `:656`). | P1 | |
| FR-003 | When `cliSelfCommitted === true`, the disposition dispatcher MUST NOT enter the B1/B2/B3 `!success \|\| !hasChanges` branch at `:577-590`. Cycle proceeds to the happy-path reply-and-resolve loop starting at `:592`. | P1 | Preserves timeout dispositions (B4/B5/B6) which fire earlier. |
| FR-004 | When `cliSelfCommitted === true`, `hasChanges` semantics for downstream logic (e.g., `shortSha` derivation at `:593`, `commitTouchedFiles` at `:656-657`) MUST reflect the CLI's commit, not the handler's no-op commit step. | P1 | `getHeadShortSha()` already reads HEAD; the diff range `<preFixSha>..HEAD` already spans the CLI commit. |
| FR-005 | Preserve `blocked:stuck-feedback-loop` behavior verbatim when `cliSelfCommitted === false && !success` OR `cliSelfCommitted === false && !hasChanges`. | P1 | US2. |
| FR-006 | Preserve `blocked:fixer-timeout*` behavior verbatim (branches B4/B5/B6 at `:534-573`). Timeout branches fire before the FR-002 check. | P1 | Composition with #1070. |
| FR-007 | The happy-path log line ("Successfully pushed changes to PR branch" at `:503-506`) MUST emit a **distinct log message** on the CLI-self-commit path (e.g., `'CLI self-committed changes — proceeding to reply/resolve'`) AND both paths MUST include a structured `source: 'cli' \| 'handler'` field. Adding `source: 'handler'` to the existing handler-commit line is load-bearing — a taxonomy that only tags one side of a binary is not queryable. Resolved per clarification Q3 → A. | P2 | US3. |
| FR-008 | The disposition dispatcher's `disposition:` field on the CLI-self-commit branch MUST be the exact string `'cli-self-committed'` (matches SC-003 and existing cause-oriented sibling values `'no-diff'`, `'push-failed'`, `'timeout-no-progress'`, etc.). Resolved per clarification Q4 → A. | P2 | Log grep target for SC-003. |
| FR-008a | The CLI-self-commit log payload MUST include both `preFixSha` and `postFixSha` (or short forms) so a reader can verify the head-advance claim without running `git log`. This is load-bearing: the code *detects* "head advanced" but *infers* "the CLI committed" — those come apart when a human pushes mid-cycle. Making the claim auditable is cheaper than adding an authorship check today. Resolved per clarification Q4 caveat. | P2 | Log audit target. |
| FR-009 | Regression test in `packages/orchestrator/src/worker/__tests__/` (colocated with existing `pr-feedback-handler.test.ts`) covering the CLI-self-commit path: fixture where `spawnClaudeForFeedback` returns `{ success: true, ... }` AND `commitAndPushChanges` returns `false` AND post-CLI HEAD SHA differs from `preFixSha`. Asserts no `blocked:*` label call. | P1 | Explicit issue acceptance criterion. |
| FR-010 | Regression test complement: genuine no-diff cycle (post-CLI HEAD equals `preFixSha`, handler `hasChanges` false, CLI success) still calls `addBlockedStuckFeedbackLoopLabel`. | P1 | Guards US2 against over-relaxation. |
| FR-011 | No changes to `PrFeedbackMonitorService`, the `blocked:*` short-circuit at `pr-feedback-monitor-service.ts:373-389`, `PrFeedbackMetadata`, `QueueItem`, or the retry-counter machinery introduced by #1070. | P1 | This is a producer-side fix; consumer semantics are unchanged. |
| FR-012 | No changes to the fixer prompt, the CLI-side commit policy, or the CLI's default behavior. The CLI-side "should it commit at all" audit is filed as a follow-up (not #1073). Resolved per clarification Q2 → A. | P1 | Out of scope. |
| FR-013 | The head-advanced-but-resolve-failed case (US4) MUST apply a **new** `blocked:resolve-failed` label rather than reusing `blocked:stuck-feedback-loop`. This requires adding the label to `packages/workflow-engine/src/actions/github/label-definitions.ts` and bumping `@generacy-ai/workflow-engine` to **minor** in the changeset. Existing `resolveSuccesses === 0` branch at `pr-feedback-handler.ts:625-633` is retargeted: `head advanced && resolveSuccesses === 0 → blocked:resolve-failed`; `head unchanged && resolveSuccesses === 0 → blocked:stuck-feedback-loop` (existing behavior). Resolved per clarification Q1 → B. This intentionally breaches SC-006. | P1 | See US4. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | A cycle in which `spawnClaudeForFeedback` returns `success: true, timedOut: false` AND `commitAndPushChanges` returns `false` AND `postCliSha !== preFixSha` applies zero `blocked:*` labels and executes the reply-and-resolve loop. | 100% of test invocations | Regression test FR-009 asserts zero `add*BlockedLabel` calls + N reply/resolve calls. |
| SC-002 | A cycle in which `spawnClaudeForFeedback` returns `success: true, timedOut: false` AND `commitAndPushChanges` returns `false` AND `postCliSha === preFixSha` applies `blocked:stuck-feedback-loop`. | 100% of test invocations | Regression test FR-010. |
| SC-003 | `grep 'disposition: 'cli-self-committed'' <worker log>` (or the equivalent field name settled in clarify) yields exactly one line per self-commit cycle. | 1 line/cycle | Log-line audit assertion in FR-009 test. |
| SC-004 | The historically observed contradiction (`msg: "No changes to commit"` + `msg: "no-diff cycle — ... blocked-stuck-feedback-loop disposition"` sequence on a cycle that actually pushed a commit) is unreachable. | Zero occurrences post-fix | Assertion in FR-009 test — the `no-diff cycle` warn line MUST NOT fire when `postCliSha !== preFixSha`. |
| SC-005 | The reply-and-resolve loop at `:606-619+` runs identically on the CLI-self-commit path and the handler-commit path (same inputs, same outputs). | Behavioral parity | FR-009 assertion + code-audit (no divergent branches inside the happy-path loop). |
| SC-006 | Changes under `packages/workflow-engine/src/` are scoped to **label vocabulary only** — adding `blocked:resolve-failed` to `label-definitions.ts` and any minimal type widening required to accept it. No changes to workflow-engine action logic, GitHub client, or schemas. Resolved per clarification Q1 → B (SC-006 breach is intentional and bounded). | Only `label-definitions.ts` (± thin type file) changed in `packages/workflow-engine/src/` | `git diff --stat packages/workflow-engine/src/`. |
| SC-007 | Existing #1070 timeout-disposition test coverage passes unmodified. | 100% pass | `pnpm --filter @generacy-ai/orchestrator test pr-feedback-handler` green. |

## Assumptions

1. `getHeadSha(checkoutPath)` is safe to call after `spawnClaudeForFeedback()` returns and before `commitAndPushChanges()` runs — the CLI process has exited and no other process is mutating the working tree. Verified in `pr-feedback-handler.ts:1111` (implementation is a straight `git rev-parse HEAD`, no locking required).
2. `preFixSha` at `:453` is already the pre-CLI-invocation HEAD (spec `:446-452` comment: "capture HEAD SHA BEFORE spawning the fixer"). No change needed at that seam.
3. The CLI legitimately committing its own work is expected behavior in the current pipeline, not an artifact to be suppressed. FR-012 tracks the "should it?" question as a distinct clarification.
4. `commitAndPushChanges` at `:939+` is idempotent when the working tree is clean — it returns `false` without side effects. Verified by existing `"No changes to commit — skipping commit/push"` log line in the observed trace.
5. The `blocked:stuck-feedback-loop` label vocabulary is unchanged. This spec redirects when the label is applied, not what the label means.
6. Four `blocked:*` sibling labels (`stuck-feedback-loop`, `fixer-timeout`, `fixer-timeout-no-progress`, `fixer-timeout-repeat`) already exist in `workflow-engine` (added by #1070 minor bump). US1/US2/US3 need no new label vocabulary. US4 adds one new label (`blocked:resolve-failed`) per clarification Q1 → B.
7. #1051's `evaluatePushGuard` at `:474-485` runs before the disposition dispatcher and is unaffected — a refused push exits early via `handlePushRefused` and never reaches the SHA-comparison branch. This spec does not touch the guard.
8. Composition with #1047's body-finding gate at `:596-605` and Disposition C at `:566-591` (per the CLAUDE.md pointer): the head-advanced check runs BEFORE Disposition C's marker-comment gate, so a self-commit cycle that also addressed body findings takes the happy path without falling into the Disposition C branch.
9. The handler is called once per queue item (verified by monitor's `enqueueIfAbsent` dedupe from #1060/#1069) — no need to worry about concurrent invocations mutating HEAD between the pre- and post-CLI SHA reads.

## Out of Scope

1. Auditing / changing whether the CLI *should* commit on its own. Flagged by the issue as "worth auditing" but is a policy question requiring separate clarification (FR-012 marker).
2. Any change to `PrFeedbackMonitorService`, the `blocked:*` short-circuit, `PrFeedbackMetadata`, or `QueueItem` (FR-011).
3. Any change to the `blocked:stuck-feedback-loop` label vocabulary or its consumer semantics — this fix redirects the *decision* to apply the label, not the label's meaning. (One new sibling label `blocked:resolve-failed` is added per Q1 → B, but that is additive, not a redefinition of `stuck-feedback-loop`.)
4. Any change to the timeout-disposition branches (B4/B5/B6) introduced by #1070 (FR-006).
5. Any change to #1047's review-body-finding flow, `blocked:body-finding-unaddressed` label, or the ack-parser.
6. Any change to #1051's push guard (`evaluatePushGuard`, `handlePushRefused`, `pushRefused` field on `CommitResult`).
7. Any change to `/cockpit:resume` (#891) — this defect produces `blocked:*` labels, not `failed:<phase>` labels, and is outside cockpit-resume's mapping.
8. Retrospective cleanup of any PRs currently wearing an incorrectly-applied `blocked:stuck-feedback-loop` label — operator-driven, not part of the code fix.
9. Backporting to older worker versions — this is a forward-only fix on `develop`.

## Resolved Clarifications

All four open questions resolved in Batch 1 (see `clarifications.md`, 2026-07-29). Summary:

- **CL-1 → Q1 → B**: Add new label `blocked:resolve-failed` for the head-advanced-but-resolve-failed case. Landed in FR-013 (updated). Intentional SC-006 breach (bounded to `label-definitions.ts`).
- **CL-2 → Q2 → A**: CLI-side commit policy is **out of scope** for #1073. Filed as separate follow-up. FR-012 updated accordingly.
- **CL-3 → Q3 → A**: Distinct log message on CLI-self-commit path (`'CLI self-committed changes — proceeding to reply/resolve'`) AND both paths gain a `source: 'cli' | 'handler'` field. Adding `source: 'handler'` to the existing line is load-bearing. FR-007 updated.
- **CL-4 → Q4 → A**: `disposition:` field value is exactly `'cli-self-committed'`. FR-008 updated. Load-bearing caveat added as new **FR-008a**: log payload MUST include both `preFixSha` and `postFixSha` so the head-advance claim is auditable rather than asserted.

## Provenance

- Issue: [generacy-ai/generacy#1073](https://github.com/generacy-ai/generacy/issues/1073)
- Diagnosed: 2026-07-28 driving generacy#1069 to merge, after #1070 (`63436bff`) merged.
- Related epics: PR-feedback pipeline (#1047, #1051, #1069, #1070).
- Related sibling: `/cockpit:resume` (#891, planning) — different failure class (`failed:<phase>`), no interaction.
- Codepath entry: `packages/orchestrator/src/worker/pr-feedback-handler.ts:487-590`.

---

*Generated by speckit; enhanced from issue #1073.*

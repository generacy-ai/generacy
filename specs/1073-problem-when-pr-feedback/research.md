# Research: PR-feedback handler CLI self-commit detection

**Feature**: `1073-problem-when-pr-feedback`
**Date**: 2026-07-29

Design decisions taken while planning the fix, with the alternatives that were rejected and the specific reason each was rejected. Six decisions, each linked to a spec FR or clarification.

---

## D-1: Where to capture `postCliSha`

**Decision**: Between `spawnClaudeForFeedback()` (`pr-feedback-handler.ts:459-465`) and the pre-existing `evaluatePushGuard()` at `:474-485`. Concretely: one line, `const postCliSha = await this.getHeadSha(checkoutPath);`, placed at the seam.

**Why this is the only correct site**:

- **Before `spawnClaudeForFeedback`** — trivially equals `preFixSha`. Detects nothing.
- **Between spawn and `commitAndPushChanges`** ✓ — `postCliSha` reflects whatever the CLI produced, and nothing else has run.
- **After `commitAndPushChanges`** — subtle false positive path. `commitAndPushChanges` is idempotent when the tree is clean (Assumption 4), but if the CLI produced changes without committing them (rare — the CLI is instructed by the prompt at `:775-787` to let the handler commit), the handler's own commit would shift HEAD. `cliSelfCommitted` would then be `true` even though the CLI itself did not commit. The spec is deliberately about "the CLI pushed" (Assumption 3 phrasing), so this shift matters.

The seam also aligns with the existing `preFixSha` capture at `:453`: both are `getHeadSha()` reads, both surround the CLI invocation, both fail safe (null → `false`).

**Rejected**: adding a Redis or in-memory cache keyed by `<owner>/<repo>#<issue>`. Overkill for a single-value read that's already stateless in the git working tree, and would introduce a cross-invocation invariant we do not need.

---

## D-2: What `cliSelfCommitted` truly proves

**Decision**: The boolean is derived as `postCliSha !== preFixSha && postCliSha !== null && preFixSha !== null`. It detects "the branch HEAD advanced during the CLI invocation" and *infers* "the CLI committed". The two are not the same proposition — they come apart if a human pushes to the PR branch mid-cycle (clarification Q4 caveat).

**Mitigation**: FR-008a — the log payload MUST carry both `preFixSha` and `postFixSha` (or the short forms) so a reader can audit the head-advance claim without running `git log`. This makes the `disposition: 'cli-self-committed'` value **auditable rather than asserted**.

**Why we do not add an authorship check today**: `git log -1 --format='%an %ae'` on `postCliSha` would prove the commit was made by the CLI's git identity, but that costs a spawn per cycle and the human-push race is theoretical, not observed. If the race ever bites, the follow-up is either an authorship check or switching the value to `head-advanced`. Per Q4, neither is worth building speculatively.

**Load-bearing**: the auditability requirement is what makes the naming choice `'cli-self-committed'` (Q4→A) safe to ship without an authorship check. Removing the SHA payload from the log line would make the naming a lie in the rare-but-possible human-push case.

---

## D-3: Label vocabulary for the `resolveSuccesses === 0` split (Q1→B)

**Decision**: Add a new label `blocked:resolve-failed` and split the existing `resolveSuccesses === 0` branch at `pr-feedback-handler.ts:625-633` by the same `cliSelfCommitted` (equivalently: `postCliSha !== preFixSha`) signal:

- Head advanced + zero resolves → `blocked:resolve-failed` (NEW). "The code is fine; the GitHub side didn't take."
- Head unchanged + zero resolves → `blocked:stuck-feedback-loop` (existing). "Handler committed but no thread transitioned" (the pre-existing meaning).

**Why not log-only distinction (Q1→A, C)**: Both A and C leave `blocked:stuck-feedback-loop` on a cycle that is not stuck. That is this issue's own complaint — the label naming the wrong cause — reapplied to a narrower case. The operator remediation *differs*: a stuck-feedback-loop points at fixer transcripts; a resolve-failure points at thread state and GitHub API responses. Different remediation earns a different label. See clarifications.md Q1 answer for the extended argument.

**Vocabulary cost**: this is the fifth `blocked:*` after #1070 added three. The precedent for adding a fifth exists (four were added this week), and the `label-definitions.ts` machinery is one array entry.

**SC-006 breach**: intentional and bounded. The workflow-engine diff is exactly one entry in `WORKFLOW_LABELS`. No action-logic, GitHub-client, or schema change.

---

## D-4: Cockpit precedence placement for `blocked:resolve-failed`

**Decision**: Insert immediately after `'blocked:fixer-timeout-repeat'` in `WAITING_PIPELINE_ORDER` (`packages/cockpit/src/state/precedence.ts:26-51`). Result: sorts ahead of `waiting-for:address-pr-feedback`; sorts after the two terminal fixer-timeout labels.

**Why ahead of `waiting-for:address-pr-feedback`**: `blocked:resolve-failed` is a terminal blocked state (no auto-retry path — a resolve failure is a GitHub API problem, not something a fixer retry can fix). It mirrors the `blocked:fixer-timeout-no-progress` and `blocked:fixer-timeout-repeat` precedence set by #1070 D-3 and the original `blocked:stuck-feedback-loop` precedent set by #883.

**Why NOT below `waiting-for:address-pr-feedback` (mirroring the retry-eligible `blocked:fixer-timeout`)**: that placement is specifically for retry-eligible blocked states — the cluster IS still "waiting-for:address-pr-feedback" during the retry window. There is no retry window for a resolve failure; the cycle is complete and human-actionable.

**Regression risk**: `precedence.test.ts` (or `classifier.test.ts`) already exercises the tie-break logic. One additional assertion — `blocked:resolve-failed` outranks `waiting-for:address-pr-feedback` — pins the intent.

---

## D-5: Test file colocation

**Decision**: NEW file `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.cli-self-commit.test.ts`.

**Why a new file rather than extending `pr-feedback-handler.test.ts`**:

- The colocation pattern is already established: `pr-feedback-handler.push-guard.test.ts` (from #1051), `pr-feedback-handler.gate-reassert.test.ts` (from #941), `pr-feedback-handler.assertion.test.ts`.
- Each feature-specific file is `describe`-scoped to its FR set, keeping intent visible in the test-runner output (`pnpm test pr-feedback-handler.cli-self-commit`).
- The base `pr-feedback-handler.test.ts` is already large; further growth by feature-orthogonal cases makes it harder to navigate.

**Rejected**: adding cases to `pr-feedback-handler.test.ts` directly. Would satisfy the spec's "colocated with" phrasing but breaks the established pattern.

---

## D-6: `source: 'cli' | 'handler'` field placement (Q3→A)

**Decision**: Add the field to **both** happy-path log branches at `pr-feedback-handler.ts:502-512`:

- `:503-506` (info, existing `'Successfully pushed changes to PR branch'`) — gains `source: 'handler'`.
- `:508-511` (warn, existing `'Pushed partial changes before CLI timed out — retry may follow'`) — gains `source: 'handler'`.
- New info line at the fall-through of the retargeted B1/B2/B3 gate — gains `source: 'cli'` and message `'CLI self-committed changes — proceeding to reply/resolve'`.

**Why the timeout-partial line also gets `source: 'handler'`**: the taxonomy is only queryable if BOTH sides of the binary are labeled — otherwise "absence of the field" is not a queryable state once older log lines exist without it. The timeout-partial line is a handler-commit case (the handler pushed after the CLI timed out with uncommitted changes), so `source: 'handler'` is factually correct.

**Rejected**: adding `source` only to the info branch, on the theory that the warn line is already distinct. Same problem — the field becomes a partial taxonomy.

---

## D-7: Does `hasChanges` need synthesis on the CLI-self-commit path?

**Decision**: No. `hasChanges` remains `false` on the CLI-self-commit path (that's what `commitAndPushChanges` returned) and downstream code does NOT branch on it once the retargeted B1/B2/B3 gate passes.

**Verified**:
- `shortSha` at `:593` calls `getHeadShortSha()` which reads HEAD directly — correct on the CLI-self-commit path because HEAD is the CLI's commit.
- `commitTouchedFiles` at `:656-657` uses `<preFixSha>..HEAD` — correct on the CLI-self-commit path for the same reason.
- The reply body at `:608` interpolates `shortSha` — same argument.
- No other reads of `hasChanges` occur after `:590`.

**Why FR-004 mentions this**: to document that the *implicit* semantics remain correct without a synthesized value. The FR guards against a future refactor that introduces a `hasChanges`-branch after the dispatcher.

---

## Implementation patterns

**Mirror the sibling label-add methods**. The five existing `add*BlockedLabel` methods (`:1152-1242`) share an identical shape: try/catch, info-log on success, warn-log on failure with `remedy: null` implied, non-fatal fall-through. `addBlockedResolveFailedLabel` follows the same shape verbatim — no new abstraction.

**Reuse `getHeadSha`, do not duplicate**. Method at `:1111-1124` already returns `Promise<string | null>` with the correct fallback behavior (null on git failure → downstream code degrades safely). Same helper, second call site.

**Structured field additions before message rewrites**. When adding `source` to existing log lines, prefer preserving the existing message text and adding a structured field — Q3 answer was explicit that A's important half is `source: 'handler'` on the *existing* line, not a message rewrite. Message rewrites are a separate concern and would churn dashboards/alerts unnecessarily.

**Test double via constructor injection**. `PrFeedbackHandler` already takes `GitHubClient`, `logger`, and `spawn*` deps via constructor / factory. Extending existing test scaffolding (spy on `getHeadSha` via `vi.spyOn(handler as any, 'getHeadSha')`) mirrors the pattern used by `pr-feedback-handler.push-guard.test.ts` for `evaluatePushGuard` stubbing.

---

## Sources

- `packages/orchestrator/src/worker/pr-feedback-handler.ts:440-746` — handler body, dispatcher, happy path, `finally` block.
- `packages/orchestrator/src/worker/pr-feedback-handler.ts:1111-1144` — `getHeadSha` and `getHeadShortSha` helpers.
- `packages/orchestrator/src/worker/pr-feedback-handler.ts:1152-1242` — five existing `add*BlockedLabel` methods (pattern to mirror).
- `packages/workflow-engine/src/actions/github/label-definitions.ts:110-140` — existing `blocked:*` vocabulary.
- `packages/cockpit/src/state/precedence.ts:26-51` — `WAITING_PIPELINE_ORDER` tie-break table.
- `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.push-guard.test.ts` — colocation and test-double pattern.
- `.changeset/1070-fixer-timeout-disposition.md` — bump-level precedent for the workflow-engine minor + orchestrator/cockpit patch shape.
- `specs/1073-problem-when-pr-feedback/spec.md` — FRs FR-001 through FR-013.
- `specs/1073-problem-when-pr-feedback/clarifications.md` — Q1→B, Q2→A, Q3→A, Q4→A (+ caveat).

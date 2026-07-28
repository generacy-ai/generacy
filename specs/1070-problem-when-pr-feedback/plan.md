# Implementation Plan: Distinguish PR-feedback fixer timeout from stuck-loop, and let it self-recover

**Feature**: Split CLI-timeout disposition off `blocked:stuck-feedback-loop`, correct the contradictory "Successfully pushed" log line, and give timed-out cycles that already pushed a commit up to two bounded automatic re-dispatches per trigger.
**Branch**: `1070-problem-when-pr-feedback`
**Status**: Complete
**Spec**: [spec.md](./spec.md) | **Clarifications**: [clarifications.md](./clarifications.md) | **Issue**: [generacy#1070](https://github.com/generacy-ai/generacy/issues/1070)

## Summary

Three narrowly-scoped fixes on `packages/orchestrator/src/worker/pr-feedback-handler.ts` and `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`, plus new label vocabulary in `packages/workflow-engine/src/actions/github/label-definitions.ts`:

1. **Split the timeout disposition** off from the no-diff / no-progress disposition and give it its own labels (`blocked:fixer-timeout`, `blocked:fixer-timeout-no-progress`, `blocked:fixer-timeout-repeat`) — the collapsed `!success || !hasChanges` branch at `pr-feedback-handler.ts:469-481` becomes four explicit sub-branches.
2. **Correct the log line** at `pr-feedback-handler.ts:451-454` so `'Successfully pushed changes to PR branch'` only fires when `success === true` **and** `hasChanges === true`; on the timeout-with-partial-push path, emit a distinct `warn` line naming the partial push.
3. **Allow up to two bounded automatic re-dispatches per trigger** (Q5=C — max 2 auto-retries), counter-keyed by `stateKey`, resetting only when all review threads are fully resolved.

Handler and monitor communicate the counter through **QueueItem metadata** (a new `retryAttempt` field on `PrFeedbackMetadata`) — NOT a shared in-memory reference. See §D-1 below: `PrFeedbackHandler` is constructed per-job inside a worker process (`claude-cli-worker.ts:299`), while `PrFeedbackMonitorService` is a singleton in the orchestrator process (`server.ts:539`) — the two run in **separate processes** (guarded by `isWorkerMode` at `server.ts:314` and `!isWorkerMode` at `server.ts:508`). Q1=A's "in-memory `Map`" answer specifies the counter's **storage** (monitor-side), not how the value **reaches the handler**.

## Technical Context

**Language/Version**: TypeScript, Node.js >=22 (ESM)
**Primary Dependencies**:
- `@generacy-ai/workflow-engine` (label definitions, `GitHubClient` interface)
- `@generacy-ai/orchestrator` internal (`PrFeedbackHandler`, `PrFeedbackMonitorService`, `QueueManager`)
- No new npm dependencies
**Storage**: In-memory `Map<string, number>` on `PrFeedbackMonitorService` (mirrors sibling `lastUnresolvedThreadCount` at `pr-feedback-monitor-service.ts:79`). Counter travels handler-ward as a `retryAttempt` field on `PrFeedbackMetadata`. Zero new Redis keys, zero new files under `/var/lib/generacy/` (SC-006).
**Testing**: `vitest` (existing `pr-feedback-handler.test.ts`, `pr-feedback-monitor-service.test.ts`, `pr-feedback-integration.test.ts`, `e2e-address-pr-feedback.test.ts`)
**Target Platform**: Node.js server (orchestrator + worker containers)
**Project Type**: Monorepo (pnpm workspaces) — this change touches three packages: `orchestrator`, `workflow-engine`, `cockpit` (see §D-3 for the cockpit-side precedence discovery).
**Performance Goals**: Zero new GitHub API calls per poll (Q1=A load-bearing rationale — a per-poll GraphQL read would recreate `/cockpit:auto` rate-limit exhaustion).
**Constraints**:
- SC-005: existing `e2e-address-pr-feedback.test.ts:119` MUST pass unmodified — `blocked:stuck-feedback-loop` semantics preserved.
- SC-006: no new persisted state outside existing monitor state.
- FR-012: `waiting-for:address-pr-feedback` MUST remain present across the entire retry chain — any window without a `waiting-for:*` / `agent:*` label is a window in which an incoming review is silently dropped.
- FR-011: `spawnClaudeForFeedback` return type widens from `Promise<boolean>` to `Promise<{ success: boolean; exitCode: number | null; timedOut: boolean }>` (Q2=B).
**Scale/Scope**: One handler class, one monitor class, one label-definitions file, one shared type file, one cockpit precedence file (§D-3). Estimated ~250 LOC of production changes + ~400 LOC of test additions.

## Constitution Check

*Repo has no `.specify/memory/constitution.md`.* The relevant governance for this PR is CLAUDE.md's changeset gate:

- **New label vocabulary in `workflow-engine`** → `minor` bump on `@generacy-ai/workflow-engine`. Three new labels (`blocked:fixer-timeout`, `blocked:fixer-timeout-no-progress`, `blocked:fixer-timeout-repeat`) qualify (see [CLAUDE.md § Changesets — Bump level](../../CLAUDE.md)).
- **Orchestrator internal behavior change** with no new public exports → `patch` bump on `@generacy-ai/orchestrator`.
- **Cockpit `WAITING_PIPELINE_ORDER` addition** (§D-3) → `patch` bump on `@generacy-ai/cockpit` — no new public exports, and the two added terminal labels only affect intra-tier tie-break ordering when both a terminal `blocked:fixer-timeout-*` and a `waiting-for:*` label coexist.
- Single changeset file `.changeset/1070-fixer-timeout-disposition.md` covering all three bumps.

Test-only changes are exempt from the changeset gate — but the changes above are all under non-test `src/`, so a changeset IS required.

## Project Structure

### Documentation (this feature)

```text
specs/1070-problem-when-pr-feedback/
├── plan.md                      # This file (/plan command output)
├── spec.md                      # /specify + /clarify output — do not modify
├── clarifications.md            # /clarify batch 1 output — do not modify
├── research.md                  # Phase 0 output (this command)
├── data-model.md                # Phase 1 output (this command)
├── quickstart.md                # Phase 1 output (this command)
├── contracts/                   # Phase 1 output (this command)
│   ├── spawn-claude-result.md   # spawnClaudeForFeedback private return-type change
│   ├── label-vocabulary.md      # Three new blocked:* labels
│   ├── monitor-short-circuit.md # Retry-eligible check ordering
│   ├── handler-counter-seam.md  # QueueItem-borne retryAttempt field
│   └── counter-reset-trigger.md # Case C is the sole reset site
├── checklists/                  # (empty — /clarify batch 1 closed everything)
├── conversation-log.jsonl       # /specify + /clarify audit trail
└── tasks.md                     # Phase 2 output (created by /tasks — NOT this command)
```

### Source Code (repository root)

```text
packages/
├── workflow-engine/
│   └── src/actions/github/
│       └── label-definitions.ts                       # +3 label entries next to line 111 (FR-002, FR-002a, FR-003)
├── orchestrator/
│   └── src/
│       ├── types/
│       │   └── monitor.ts                             # +retryAttempt on PrFeedbackMetadata (line 38-43)
│       ├── worker/
│       │   └── pr-feedback-handler.ts                 # SPLIT :469-481 into 4 branches (FR-001);
│       │                                              # widen spawnClaudeForFeedback :412+:687 return (FR-011);
│       │                                              # fix :453 log (FR-005); read retryAttempt (FR-007);
│       │                                              # new addBlockedFixerTimeout* helpers next to :1035
│       └── services/
│           └── pr-feedback-monitor-service.ts         # +fixerTimeoutRetryCount Map next to :79;
│                                                     # retry-eligible check BEFORE blocked:* short-circuit
│                                                     # at :373-389 (FR-006); attach retryAttempt at :414-428;
│                                                     # reset counter in Case C at :296-317 (FR-013)
└── cockpit/
    └── src/state/
        └── precedence.ts                              # +2 terminal labels to WAITING_PIPELINE_ORDER
                                                     # ahead of waiting-for:address-pr-feedback (§D-3)

.changeset/
└── 1070-fixer-timeout-disposition.md                  # workflow-engine: minor; orchestrator, cockpit: patch

# Tests (co-located, no dedicated tests/ tree)
packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts             # 4-branch disposition matrix
packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts   # SC-002/SC-003/SC-003a/SC-003b
packages/orchestrator/src/__tests__/pr-feedback-integration.test.ts                # end-to-end retry-then-succeed
packages/cockpit/src/__tests__/e2e-address-pr-feedback.test.ts                     # SC-005 unchanged assertion
```

**Structure Decision**: Existing monorepo layout. No new packages, no new top-level directories.

## Load-Bearing Design Decisions

Load-bearing decisions carry a **`D-N`** id so /tasks and reviewers can trace where each one manifests in code and tests.

### D-1: Handler↔monitor counter seam — QueueItem metadata (spec-deferred)

The spec deferred the mechanism explicitly:

> FR-007: […] Handler reads the same in-memory counter the monitor writes (via constructor injection or a shared reference — **mechanism deferred to /plan**).

**Decision**: The counter is transmitted from monitor to handler via a new `retryAttempt: number` field on `PrFeedbackMetadata` (`packages/orchestrator/src/types/monitor.ts:38-43`), populated by the monitor at every enqueue (both the normal path at `pr-feedback-monitor-service.ts:414-428` and the new retry-eligible branch at `:373-389`). The handler reads `item.metadata.retryAttempt ?? 0`. Nothing else changes on the QueueItem shape.

**Rationale**: `PrFeedbackHandler` is constructed per-job inside a worker process (`claude-cli-worker.ts:299`); `PrFeedbackMonitorService` is a singleton in the orchestrator process (`server.ts:539`). The two run in **separate processes** — worker mode (`server.ts:314`) and non-worker mode (`server.ts:508`) are mutually exclusive branches. A shared `Map` reference cannot cross the process boundary. Redis-backed shared state was rejected (SC-006). Q1=A's "in-memory `Map` on `PrFeedbackMonitorService`" answers **where the counter lives** (single owner, monitor side); D-1 answers **how the handler sees the current value at cycle start** (via the Redis queue item's metadata payload, which is already the mechanism the monitor uses to hand `prNumber` and `reviewThreadIds` to the handler — see `PrFeedbackMetadata` at `monitor.ts:38-43`).

**Counter semantic**: `retryAttempt` = *number of auto-retries dispatched so far*, including the current dispatch. Original cycle → `retryAttempt: 0`. First auto-retry → `retryAttempt: 1`. Second auto-retry → `retryAttempt: 2` (last one; a timeout at this level triggers the terminal `blocked:fixer-timeout-repeat`).

### D-2: Handler decision rule under D-1

On the `timedOut === true && hasChanges === true` disposition, the handler applies:

- `retryAttempt < 2` → `blocked:fixer-timeout` (retry-eligible; monitor may still dispatch again).
- `retryAttempt >= 2` → `blocked:fixer-timeout-repeat` (terminal; budget exhausted).

The **handler is stateless w.r.t. the counter** — it reads what the monitor baked in, decides one label. FR-007 as-written asked the handler to "check the current retry counter" — D-1 satisfies that by making the counter's current value part of the QueueItem the handler is already reading. This is neither constructor injection nor a shared reference — it is the natural fit for a Redis-queue-based control plane.

### D-3: Cockpit precedence side-effect (Assumption 6 verification)

Spec §Assumption 6:

> Cockpit consumer semantics: `blocked:fixer-timeout`, `blocked:fixer-timeout-no-progress`, and `blocked:fixer-timeout-repeat` are new blocked-state labels; cockpit's existing "any `blocked:*` outranks address-pr-feedback" logic already handles them correctly by prefix. **No cockpit-side change is expected. (Verify at /plan.)**

**Verification result: partially incorrect — a small cockpit change IS required for the two terminal labels.**

- `packages/cockpit/src/state/label-map.ts:44-48` classifies every `blocked:*` label into the `waiting` tier by **prefix** — this part of Assumption 6 is correct, so no `label-map.ts` change is needed.
- `packages/cockpit/src/state/precedence.ts:26-40` orders the `waiting` tier by **exact-name** membership in `WAITING_PIPELINE_ORDER`. Only the two listed entries (`blocked:stuck-feedback-loop` and `waiting-for:address-pr-feedback`) outrank other `waiting-for:*` gates. The three new labels are unlisted → they sort **after** all listed gates via the `ai === -1 → return 1` branch at `:90`.

**Practical consequence**:
- `blocked:fixer-timeout` (retry-eligible, coexists with `waiting-for:address-pr-feedback` per FR-012) — cockpit surfaces `waiting-for:address-pr-feedback` as the primary state. This is **correct** for this label: the retry is coming; the cluster IS still in "waiting-for:address-pr-feedback" state. No change needed.
- `blocked:fixer-timeout-no-progress` and `blocked:fixer-timeout-repeat` (terminal, coexist with `waiting-for:address-pr-feedback` because the handler retains it) — cockpit currently surfaces `waiting-for:address-pr-feedback`, hiding the terminal state. Operator triage is degraded relative to the sibling `blocked:stuck-feedback-loop` behavior (which explicitly outranks `waiting-for:address-pr-feedback` per the comment at `precedence.ts:27-28`).

**Decision**: Add the two **terminal** labels to `WAITING_PIPELINE_ORDER` **ahead** of `waiting-for:address-pr-feedback` (position matching `blocked:stuck-feedback-loop`):

```typescript
export const WAITING_PIPELINE_ORDER: string[] = [
  'blocked:stuck-feedback-loop',
  'blocked:fixer-timeout-no-progress',   // +1070
  'blocked:fixer-timeout-repeat',        // +1070
  'waiting-for:address-pr-feedback',
  'blocked:fixer-timeout',               // +1070 — retry-eligible, sorts below the active waiting gate
  'waiting-for:spec-review',
  // ...
];
```

Note `blocked:fixer-timeout` (retry-eligible) is placed **below** `waiting-for:address-pr-feedback` — Q4=A's intent is that operators see "still waiting" during the auto-retry window, not "blocked".

**Test coverage**: Extend `packages/cockpit/src/__tests__/classifier.test.ts` (or add `packages/cockpit/src/__tests__/e2e-fixer-timeout.test.ts` alongside the existing e2e-address-pr-feedback shape) with three simulated timelines matching each terminal-label scenario.

### D-4: Monitor short-circuit ordering (Assumption 5)

Spec §Assumption 5 is decisive:

> The retry path in FR-006 is implemented as a **narrower check that fires before the `blocked:*` short-circuit**, not as an allow-list carve-out inside it. This preserves the invariant that any unrecognized `blocked:*` label pauses the monitor.

**Decision**: In `pr-feedback-monitor-service.ts::processPrReviewEvent()`, insert the retry-eligible branch **between** the current `getIssueLabels` fetch (`:363-372`) and the `blockedLabel = issueLabels.find(l => l.startsWith('blocked:'))` skip check (`:373-389`). The retry branch:

1. Checks `issueLabels.includes('blocked:fixer-timeout')` (exact match; not prefix).
2. Reads `counter = this.fixerTimeoutRetryCount.get(stateKey) ?? 0`.
3. If `counter < 2`:
   a. `await client.removeLabels(owner, repo, issueNumber, ['blocked:fixer-timeout'])` (fail-warn, non-fatal).
   b. `counter = counter + 1; this.fixerTimeoutRetryCount.set(stateKey, counter)`.
   c. Continue to the normal enqueue path (which will attach `retryAttempt: counter` per D-1).
4. If `counter >= 2` (defense in depth — handler should have already applied `blocked:fixer-timeout-repeat`):
   a. Log a `warn` naming the exhaustion.
   b. Fall through to the blocked:* short-circuit (no dispatch). Counter left at 2.

The remaining two terminal labels (`blocked:fixer-timeout-no-progress`, `blocked:fixer-timeout-repeat`) fall through to the existing `blocked:*` prefix short-circuit unchanged — this is exactly the behavior Assumption 5 requires.

### D-5: Counter reset — Case C is the only site (FR-013 + Q5=C)

The counter resets **only** when `totalUnresolvedThreads === 0` (Case C at `pr-feedback-monitor-service.ts:296-317`). Add one line to that branch:

```typescript
this.lastUnresolvedThreadCount.set(stateKey, 0);
this.lastZeroTrustedState.set(stateKey, false);
this.fixerTimeoutRetryCount.delete(stateKey);   // +1070 FR-013 — Q5=C progress-only reset
```

The handler does NOT signal the reset. Case C fires naturally on the next monitor poll after all threads are resolved (via Disposition A on the handler side OR manual operator resolution — both are equivalent triggers).

**Explicitly rejected reset conditions** (all would recreate the Q5=C-rejected "runaway" behavior):
- Disposition A completion (partial success without full resolution).
- Any commit push (the SHA-keyed model Q5=C overturned).
- Absence of `blocked:fixer-timeout*` labels on the issue (would let an operator's manual label-clear reset the budget silently).

### D-6: Log-line correction shape (FR-005 + US3)

The line at `pr-feedback-handler.ts:451-454` currently reads `'Successfully pushed changes to PR branch'` inside `if (hasChanges)`. Split into two conditions:

- `hasChanges === true && success === true`: keep the existing message. Drop `success` from the payload (redundant; both branches guard on it).
- `hasChanges === true && success === false` (timeout with partial push): emit `warn` with message `'Pushed partial changes before CLI timed out — retry may follow'`. Payload: `{ prNumber, issueNumber, cliCompleted: false, exitCode }` (per FR-011, `exitCode` is now first-class).

The `success` field name is retired at this specific log site to eliminate the "success: false" + "Successfully" contradiction the bug report targeted. Elsewhere in the handler `success` remains a valid variable name.

## Ordering & Execution Notes

- Land **D-1 (metadata field addition)** and **D-2 (handler decision rule)** together; the field is a wire-format contract and split PRs would create a window where the handler reads `undefined`.
- **D-4 (monitor retry branch)** depends on D-1's metadata field being defined; land in the same PR.
- **D-3 (cockpit precedence)** is decoupled — it depends only on the three label names being defined in `label-definitions.ts`. Can be reviewed as a separate diff hunk but must land in the same PR to satisfy SC-001 operator-triage.
- The changeset file MUST be a **newly added** file per the CLAUDE.md gate — `.changeset/1070-fixer-timeout-disposition.md`, not an edit to an existing changeset.

## Complexity Tracking

No constitution violations. No new abstractions introduced. One net-new `Map` field on the monitor (mirrors existing pattern). One net-new `retryAttempt` field on an existing metadata type. Handler grows from 1 timeout-handling branch to 4 explicit sub-branches — this is the point of the change (per FR-001).

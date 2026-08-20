# Contract: Monitor engine-authored thread exclusion + adapter routing

Governs the two orchestrator-side changes: (1) the monitor's engine-authored exclusion in the
trust loop, and (2) the worker's `address-pr-feedback` branch becoming the thin adapter that seeds
and runs the phase loop.

## Change 1 — `PrFeedbackMonitorService` engine-authored exclusion

**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
**Site**: trust-filter loop (~lines 264-286), where each unresolved thread's comments are iterated
via `isTrustedCommentAuthor` to build `unresolvedThreadIds` / the trusted-unresolved count.

**Contract**:
- A thread is **excluded** from the trusted-unresolved count iff
  `thread.comments.every(c => commentCarriesEngineAuthoredReviewMarker(c.body))` (FR-010 / Q4→A).
- Exclusion uses the marker helper imported from `worker/review-poster.ts`
  (`commentCarriesEngineAuthoredReviewMarker` / `ENGINE_AUTHORED_REVIEW_MARKERS`). The match rule
  (column-0, case-sensitive ASCII, `> `-quoted excluded) is owned by that helper — **do not
  re-implement** (FR-001).
- Human trust stays authorship-based via `isTrustedCommentAuthor` (FR-002) — the exclusion guard
  is applied **in addition to**, not in place of, the trust check. A thread that is trusted AND
  fully engine-authored is excluded; a thread that is trusted with any external comment stays live.
- Marker input is the **raw** comment body string, unmodified.

**Preserved (FR-009 — must not regress)**:
- Case C reset (`fixerTimeoutRetryCount.delete`, ~319-346).
- Case B zero-trusted / untrusted-notice episode (~351-377).
- Case A `blocked:*` skip guard (~388-488) — including any *new* unrecognized `blocked:*` still
  pausing the trigger.
- The enqueue of `command: 'address-pr-feedback'` with `PrFeedbackMetadata` (~518-534) via
  `enqueueIfAbsent` (~543).
- The webhook+polling hybrid and adaptive interval — untouched.

**Behavioral assertions**:
- A thread whose comments are all engine-authored contributes **0** to the trusted-unresolved
  count and causes **no** enqueue (SC-001/SC-003).
- A mixed thread (≥1 external trusted comment) contributes and triggers as today (FR-010).

## Change 2 — Worker `address-pr-feedback` adapter routing

**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`
**Site**: `if (item.command === 'address-pr-feedback')` branch (~line 299) that today constructs
`PrFeedbackHandler` and returns `{ status: 'completed' }` **early**, bypassing the phase loop.

**Contract**:
- The branch no longer returns early into the legacy fixer. It:
  1. Ensures the checkout (as today).
  2. Runs the **retained dual-source parser** (from the reduced `PrFeedbackHandler`) to extract
     trusted findings from inline threads AND review bodies (FR-004).
  3. If extraction yields ≥1 finding:
     - `clearReviewArtifact(checkoutPath, workflowId)` — reset the remediation counter (D-2 /
       FR-006, authorship-based since the trigger is trusted-external).
     - `writeExternalFeedbackSeed(checkoutPath, workflowId, seed)`.
     - Fall through to the normal `phaseLoop.executeLoop(context, effectiveConfig, deps,
       phaseSequence)` where `phaseSequence` starts at `review`.
  4. If extraction yields 0 findings: no seed, no artifact clear; treat as a no-op completion
     (nothing trusted-external to remediate).
- Inject `SeedAwareReviewExecutor` (wrapping the real `ReviewExecutor` built at ~691) as
  `deps.reviewExecutor` for this job.
- `remediateTrigger` wiring is unchanged — it reads the artifact verdict written by the wrapper.

**Guarantees**:
- External trusted feedback enters the shared review/remediate loop (FR-003), not the legacy fixer.
- Remediations count toward the cap; exhaustion lands on `waiting-for:remediation-limit` via the
  existing `on-remediation-limit` gate (FR-005), never `blocked:stuck-feedback-loop`.

## Change 3 — `PrFeedbackHandler` reduced to thin adapter

**File**: `packages/orchestrator/src/worker/pr-feedback-handler.ts`

**Contract**:
- **Retain** the dual-source parser (~218-402) and expose it for the worker branch to call
  (extract + map to `ExternalFeedbackFinding[]`, optionally via a small `writeSeed` helper).
- **Delete** the `blocked:stuck-feedback-loop` apply-site (~611,
  `addBlockedStuckFeedbackLoopLabel`) and its constant (~31) — FR-007/FR-008.
- Remove the divergent disposition/enqueue logic that competed with the shared loop; the handler
  no longer runs a fix CLI itself (one live fix path — Q5→B).

## Change 4 — Label vocabulary removal

**File**: `packages/workflow-engine/src/actions/github/label-definitions.ts`

**Contract**: remove the `blocked:stuck-feedback-loop` definition (FR-008). Grep the monorepo for
remaining references (cockpit label maps/precedence, tests) and migrate/remove them in the same PR.

## Non-goals (Out of Scope)

- No change to `isTrustedCommentAuthor` semantics.
- No change to `review-executor.ts`, `phase-loop.ts`, the findings artifact schema, or the
  adaptive-interval mechanism.
- No cloud-side (generacy-cloud) review consumer changes.

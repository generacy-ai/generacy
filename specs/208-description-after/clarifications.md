# Clarification Questions

## Status: Pending

## Questions

### Q1: Partial Workflow Completion
**Context**: The spec only addresses successful workflow completion (`loopResult.completed === true`), but workflows can also pause at review gates (`loopResult.gateHit`) or fail during a phase. If a workflow resumes after a gate and then completes, should the PR be marked ready at that point?

**Question**: Should the PR be marked ready for review when a workflow completes after resuming from a review gate?

**Options**:
- A) Yes, mark ready on any successful completion: Mark the PR ready whenever `loopResult.completed === true`, regardless of whether the workflow paused at gates previously
- B) No, require manual marking after gate resumes: Only mark ready if the workflow never hit a gate, requiring manual intervention for workflows that paused
- C) Add a flag to control this behavior: Allow configuration to specify whether gate-resumed workflows should auto-mark ready

**Answer**:

---

### Q2: PR Already Marked Ready
**Context**: The spec assumes marking a ready PR is idempotent based on GitHub API behavior, but there's no explicit verification. If someone manually marks the PR ready before workflow completion, or if the workflow runs multiple times on the same branch, we should clarify expected behavior.

**Question**: Should we verify the PR is in draft state before attempting to mark it ready, or rely on the GitHub API's idempotency?

**Options**:
- A) Trust GitHub API idempotency: Call `markPRReady()` regardless of current state and let GitHub handle it
- B) Check draft state first: Query the PR to verify it's in draft state before calling `markPRReady()`, skip if already ready
- C) Log a warning if already ready: Check state, call the API anyway for consistency, but log an informational message if it was already ready

**Answer**:

---

### Q3: Retry Logic for API Failures
**Context**: The spec states that marking ready should be "best-effort" with errors logged as warnings. However, `LabelManager` uses retry logic with exponential backoff for label operations (3 attempts). Should we apply similar retry logic to marking PRs ready, or is a single attempt sufficient?

**Question**: Should marking the PR ready include retry logic similar to label operations, or is a single attempt with error logging sufficient?

**Options**:
- A) Single attempt only: Try once, log warning on failure, move on (as currently specified)
- B) Match label manager retries: Use the same 3-attempt retry with exponential backoff (1s, 2s, 4s delays) as `LabelManager`
- C) Limited retries: Use fewer retries (e.g., 2 attempts with 1s delay) since marking ready is less critical than label management

**Answer**:

---

### Q4: Logging Before vs After Operation
**Context**: FR-008 states that logging the invocation from the worker is "P2: Optional", while FR-004 requires logging success. The proposed implementation only logs after success/failure, not before the attempt.

**Question**: Should we add a log message in `claude-cli-worker.ts` before calling `markReadyForReview()` to indicate we're attempting to mark the PR ready?

**Options**:
- A) No logging before the call: Only log success/failure from within `PrManager.markReadyForReview()` (as currently specified)
- B) Add info-level log before call: Log "Marking PR as ready for review" before calling `prManager.markReadyForReview()` for better traceability
- C) Add debug-level log before call: Use debug level to avoid cluttering production logs, but provide visibility when needed

**Answer**:

---

### Q5: Error Context in Logs
**Context**: The spec shows logging `error: String(error)` which converts the error to a string. This may lose stack traces and structured error information that could be valuable for debugging.

**Question**: How should errors be serialized in the log message when `markReadyForReview()` fails?

**Options**:
- A) Convert to string: Use `String(error)` as shown in the spec for consistency with existing patterns in `PrManager`
- B) Include error object: Pass the error object directly to the logger for better structured logging and stack traces
- C) Extract specific fields: Serialize both message and stack: `{ message: error.message, stack: error.stack }`

**Answer**:

---

### Q6: Success Criteria Verification
**Context**: SC-004 specifies "Time to reviewer notification < 10s from workflow completion to PR ready state", but there's no implementation guidance for measuring or enforcing this. This may be aspirational rather than a hard requirement.

**Question**: Should we implement timing metrics to track and log the duration between workflow completion and PR ready state?

**Options**:
- A) No timing implementation: Treat SC-004 as a target metric to be verified through manual/integration testing, not instrumented in code
- B) Log timing for monitoring: Add timestamp logging before/after `markReadyForReview()` to enable verification through log analysis
- C) Emit timing metrics: Add structured timing metrics (e.g., duration_ms) that can be consumed by monitoring systems

**Answer**:

---

### Q7: PR Body Update on Ready
**Context**: The "Out of Scope" section explicitly states "PR body updates: The PR description is not updated when marked ready", but the current PR body includes text "*Draft PR created by Generacy orchestrator. Updated after each workflow phase.*" which may be misleading once the PR is marked ready.

**Question**: Should we update the PR description to remove or modify the "Draft PR" language when marking it ready, despite this being listed as out of scope?

**Options**:
- A) No change (as specified): Keep the PR body unchanged when marking ready, as stated in "Out of Scope"
- B) Remove draft language only: Update only the "*Draft PR...*" footer to say "*PR created by Generacy orchestrator*" when marking ready
- C) Add completion notice: Append a message like "✅ All workflow phases completed successfully" to the PR body when marking ready

**Answer**:

---

### Q8: Configuration and Override Options
**Context**: The spec states "Conditional ready marking: PR is always marked ready on completion; no configurable conditions" in the "Out of Scope" section. However, some workflows may want to keep PRs in draft state even after completion for additional manual review.

**Question**: Should there be any mechanism to disable or override auto-marking PRs ready, or should it always happen on successful completion?

**Options**:
- A) Always mark ready (as specified): No configuration option; all successful completions automatically mark PR ready
- B) Add issue label override: Allow specific labels (e.g., `keep-draft`) on the issue to prevent auto-marking ready
- C) Add workflow config option: Support a configuration flag in workflow settings to enable/disable auto-marking ready per repository or workflow

**Answer**:

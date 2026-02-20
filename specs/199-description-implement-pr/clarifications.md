# Clarification Questions

## Status: Pending

## Questions

### Q1: PR-to-Issue Linking with Multiple PRs
**Context**: FR-2 mentions PRs with multiple issue references via body keywords, and the Out of Scope section states "only the most recently updated PR with unresolved comments is processed" for multi-PR scenarios. However, it's unclear how to handle when one PR references multiple issues.
**Question**: When a PR body contains multiple closing keywords (e.g., "Closes #123, Fixes #456"), and both issues are orchestrated, should we:
**Options**:
- A) **Process for all linked issues** (Recommended): Add `waiting-for:address-pr-feedback` to all linked orchestrated issues and enqueue multiple queue items
- B) **Process for first issue only**: As stated in FR-2, use only the first linked issue and ignore others
- C) **Process for primary issue via heuristic**: Use the issue linked in the PR title/branch name as primary, or the first if no clear primary
**Answer**:

### Q2: QueueItem Command Type Extension
**Context**: The current `QueueItem` type has `command: 'process' | 'continue'`. FR-5 requires handling `command: 'address-pr-feedback'`, but the type definition in `monitor.ts:14` doesn't include this variant. The spec says to "extend" the worker but doesn't specify whether to extend the QueueItem type itself.
**Question**: Should we extend the `QueueItem.command` type union to include `'address-pr-feedback'`, or handle it as a special case of `'continue'` with metadata?
**Options**:
- A) **Extend QueueItem type union** (Recommended): Change `command: 'process' | 'continue' | 'address-pr-feedback'` in the type definition
- B) **Use 'continue' with metadata**: Keep command as `'continue'` and use metadata field to indicate this is a PR feedback flow
- C) **Create separate queue item type**: Define `PrFeedbackQueueItem` that extends `QueueItem` with additional fields
**Answer**:

### Q3: Label Workflow During PR Feedback
**Context**: FR-4 specifies adding `waiting-for:address-pr-feedback` when feedback is detected, and FR-5 mentions optionally adding `completed:address-pr-feedback` after completion. The label already exists in `WORKFLOW_LABELS`. However, it's unclear whether phase labels (like `phase:implement`) should remain or be updated during feedback addressing.
**Question**: When the agent addresses PR feedback, should we manage phase labels, or only use `waiting-for`/`completed` labels for feedback?
**Options**:
- A) **Keep existing phase labels** (Recommended): Don't change phase labels, only add/remove `waiting-for:address-pr-feedback` and `completed:address-pr-feedback`
- B) **Add temporary phase label**: Add `phase:address-pr-feedback` during processing and remove when done
- C) **Revert to implement phase**: Change phase back to `phase:implement` while addressing feedback, since it's part of implementation
**Answer**:

### Q4: Deduplication for Multiple Review Events
**Context**: FR-4 specifies using `PhaseTrackerService` with key pattern `phase-tracker:{owner}:{repo}:{issue}:address-pr-feedback` for deduplication. However, if a developer adds more review comments while the agent is already addressing previous feedback, it's unclear how to handle the new comments.
**Question**: If new review comments are added to the PR while the agent is already addressing earlier feedback, should we:
**Options**:
- A) **Queue after current completes**: Skip new events until the current feedback-addressing completes, then process fresh comments in next cycle
- B) **Merge into current processing**: Update the queue item metadata to include new thread IDs and let the worker fetch all unresolved threads
- C) **Interrupt and restart** (Not recommended): Cancel the current worker and restart with all unresolved threads combined
**Answer**:

### Q5: Review Comment Reply Strategy
**Context**: FR-5 states "Reply to each review comment thread via GitHub API with the agent's explanation" after Claude completes. It's unclear whether the agent should reply with a single consolidated comment per thread or multiple comments for complex changes.
**Question**: How should the agent structure its replies to review comment threads?
**Options**:
- A) **Single reply per thread** (Recommended): Post one consolidated comment per thread summarizing all changes made in response to that review comment
- B) **Multiple replies if needed**: Allow multiple comments if the agent made changes across multiple commits or files for one review thread
- C) **Single reply per file**: Group all threads in the same file and reply once per file with cross-references to affected threads
**Answer**:

### Q6: Polling PR Selection Criteria
**Context**: FR-6 states the polling loop should "list open PRs" and "check for unresolved review threads" on orchestrated PRs. The Out of Scope mentions "only the most recently updated PR with unresolved comments is processed" for multi-PR per issue. It's unclear how to prioritize when multiple open PRs from different issues all have unresolved comments.
**Question**: When polling detects multiple open PRs with unresolved review threads across different orchestrated issues, how should we prioritize which PR to process first?
**Options**:
- A) **Process all in parallel** (Recommended): Enqueue queue items for all orchestrated PRs with unresolved feedback, let the dispatcher handle concurrency
- B) **Oldest unresolved comment first**: Prioritize the PR with the oldest unresolved review comment timestamp
- C) **Most recently updated PR first**: Prioritize the PR that was most recently updated, as it's likely the most active
**Answer**:

### Q7: Worker Timeout and Partial Feedback Addressing
**Context**: The worker config has `phaseTimeoutMs` (default 600s/10min) per phase. FR-5 requires the agent to address all unresolved comments, but a PR might have many complex review threads that take longer than the timeout to address.
**Question**: If the worker times out while addressing PR feedback (doesn't complete all review threads), what should happen?
**Options**:
- A) **Partial completion with retry** (Recommended): Push whatever changes were made, reply to threads that were addressed, keep `waiting-for:address-pr-feedback` label, and re-enqueue for retry
- B) **Full rollback on timeout**: Discard changes, add `agent:error` label, and require human intervention to address feedback manually
- C) **Extend timeout for feedback**: Use a separate, longer timeout specifically for `address-pr-feedback` command (e.g., 20-30 minutes)
**Answer**:

### Q8: Webhook vs Polling Race Conditions
**Context**: FR-6 specifies both webhook and polling paths process PR feedback using FR-4 logic, and FR-4 uses `PhaseTrackerService` for deduplication. However, there's a timing window where a webhook could be processed while polling is also checking the same PR.
**Question**: How should we handle the race condition where both webhook and polling try to enqueue the same PR feedback event simultaneously?
**Options**:
- A) **Redis deduplication sufficient** (Recommended): Trust the PhaseTrackerService's Redis-based deduplication to handle concurrent checks from both paths
- B) **Add polling exclusion window**: When a webhook is received, skip polling that specific PR for the next N poll cycles to avoid redundant API calls
- C) **Webhook-only mode**: If webhooks are healthy (received event in last N minutes), completely disable polling for PR reviews
**Answer**:

### Q9: Error Handling for Review Comment Posting
**Context**: FR-5 requires replying to review comment threads after Claude completes, but FR-8 doesn't specify what happens if posting a reply fails (e.g., GitHub API rate limit, network error, permissions issue).
**Question**: If the agent successfully makes code changes but fails to post replies to some or all review comment threads, should we:
**Options**:
- A) **Mark as partial success** (Recommended): Remove `waiting-for:address-pr-feedback`, add a warning comment on the PR, and let the reviewer see the changes even without automated replies
- B) **Retry reply posting**: Keep `waiting-for:address-pr-feedback` label, log which threads failed, and retry posting replies on next worker cycle
- C) **Mark as error**: Add `agent:error` label and require human intervention to manually reply to review comments
**Answer**:

### Q10: Multi-Repo Polling Coordination
**Context**: FR-6 states "For each watched repository, list open PRs" and FR-7 has `prMonitor.maxConcurrentPolls` (default 3). The orchestrator already has `repositories` config array. It's unclear if `maxConcurrentPolls` limits concurrent API calls within one repo or across all repos.
**Question**: Does `maxConcurrentPolls` limit concurrent GitHub API calls within a single repository or across all watched repositories?
**Options**:
- A) **Across all repositories** (Recommended): Maximum 3 concurrent GitHub API calls total across all repos during polling (prevents overwhelming GitHub API)
- B) **Per repository**: Maximum 3 concurrent API calls per repository (allows higher throughput for multi-repo setups)
- C) **Per-PR calls**: Maximum 3 concurrent PRs being analyzed for review threads at once, regardless of which repos they belong to
**Answer**:

### Q11: Branch Checkout for Feedback Addressing
**Context**: FR-5 states "Spawn Claude CLI with the prompt and the repository checkout" and assumptions mention "the repository is already cloned/available in the worker's workspace". The ClaudeCliWorker clones the default branch first, then creates feature branches. When addressing feedback, the PR branch already exists remotely.
**Question**: When processing `address-pr-feedback`, should the worker check out the existing PR branch or the default branch?
**Options**:
- A) **Check out PR branch** (Recommended): Fetch and check out the existing PR branch so changes are made on top of current PR state
- B) **Check out default branch first**: Clone default branch, then fetch PR branch and check out, similar to the initial implementation flow
- C) **Use existing checkout**: Reuse the workspace from the original `implement` phase if it still exists, otherwise clone PR branch fresh
**Answer**:

### Q12: Service Architecture and Separation of Concerns
**Context**: The spec requires a new "PR Feedback Monitor" component but doesn't specify whether this should be a new service class (like `LabelMonitorService`), part of the existing label monitor, or split into webhook route + polling service.
**Question**: How should the PR Feedback Monitor be architecturally structured?
**Options**:
- A) **New PrFeedbackMonitorService** (Recommended): Create a separate service class similar to `LabelMonitorService` that handles both webhook processing and polling with its own state management
- B) **Extend LabelMonitorService**: Add PR review webhook handling and polling logic into the existing `LabelMonitorService` class
- C) **Split webhook + polling**: Create a webhook route handler in `/routes` and a separate `PrPollingService` for polling fallback
**Answer**:

### Q13: Workflow Name Preservation
**Context**: FR-4 specifies preserving the existing workflow name when enqueuing (`workflowName` field from the parent issue). However, when the PR monitor detects feedback on a PR linked to an issue, that issue might not have a `process:*` label anymore (it might have been removed after implementation phase started).
**Question**: How should we determine the `workflowName` for the queue item when enqueuing PR feedback?
**Options**:
- A) **Read from issue labels** (Recommended): Query the linked issue's labels and extract workflow from any `process:*` label or historical `completed:*` labels
- B) **Store in PR metadata**: When creating the PR, add a comment or metadata storing the original workflow name for later retrieval
- C) **Default workflow**: Use a configured default workflow name (e.g., `speckit-feature`) if no process label exists
**Answer**:

### Q14: Concurrent Feedback on Multiple PRs for Same Issue
**Context**: The Out of Scope mentions "only the most recently updated PR with unresolved comments is processed" for multi-PR per issue scenarios, but doesn't specify what happens to older PRs with unresolved comments.
**Question**: If an orchestrated issue has multiple open PRs and both receive review comments, should we:
**Options**:
- A) **Process most recent PR only** (Recommended): Only enqueue feedback for the most recently updated PR, ignore unresolved comments on older PRs
- B) **Process all PRs sequentially**: Enqueue feedback items for all PRs but with priority based on update time (newest first)
- C) **Warn and skip**: Log a warning that multiple PRs exist for one issue and skip automatic feedback addressing, require human intervention
**Answer**:

### Q15: Review State Filtering Edge Cases
**Context**: FR-1 filters for reviews with state `changes_requested` or `commented` and ignores `approved` reviews. However, GitHub also has `dismissed` review state, and reviewers can approve after previously requesting changes.
**Question**: How should we handle edge cases in review states?
**Options**:
- A) **Strict unresolved-thread-only** (Recommended): Ignore review state entirely and only check for `resolved: false` threads as described in FR-3, which is more accurate
- B) **Include dismissed reviews**: Process `changes_requested`, `commented`, and `dismissed` reviews, but ignore `approved`
- C) **Track review state transitions**: Only process if the most recent review from each reviewer is `changes_requested` or `commented`
**Answer**:

### Q16: PR Metadata in Queue Item
**Context**: FR-4 specifies storing `{ prNumber, reviewThreadIds: [...] }` in queue item metadata. However, the current `QueueItem` type doesn't have a `metadata` field. The `SerializedQueueItem` extends it with `attemptCount` and `itemKey`, but no generic metadata.
**Question**: How should we store PR-specific metadata (`prNumber`, `reviewThreadIds`) in the queue item?
**Options**:
- A) **Extend QueueItem with metadata field** (Recommended): Add optional `metadata?: Record<string, unknown>` to `QueueItem` type for flexible command-specific data
- B) **Use separate Redis key**: Store metadata in a separate Redis key pattern `pr-feedback-meta:{owner}:{repo}:{issue}` and look it up in the worker
- C) **Encode in priority/command**: Encode PR number in the priority score or as a suffix to command string (not recommended, breaks type safety)
**Answer**:

### Q17: Configuration Grouping
**Context**: FR-7 specifies new config under `prMonitor.*` namespace (enabled, pollIntervalMs, webhookSecret, adaptivePolling, maxConcurrentPolls). The existing `MonitorConfigSchema` already has similar fields for issue label monitoring.
**Question**: Should PR monitor configuration be nested separately or merged with existing monitor config?
**Options**:
- A) **Separate prMonitor config** (Recommended): Add new `prMonitor` field to `OrchestratorConfigSchema` as specified in FR-7 to keep concerns separated
- B) **Merge into existing monitor config**: Extend `MonitorConfigSchema` with PR-specific fields (e.g., `prPollIntervalMs`, `prAdaptivePolling`) to avoid duplication
- C) **Unified monitor config array**: Convert monitor config to array of monitor definitions, each with type (issue/pr) and specific settings
**Answer**:

### Q18: Adaptive Polling Trigger for PR Monitor
**Context**: FR-6 mentions "adaptive polling: increase frequency if webhooks disconnect (same pattern as label monitor)" but doesn't specify the exact triggers or frequency adjustments for the PR monitor specifically.
**Question**: What should trigger adaptive polling frequency changes for the PR monitor?
**Options**:
- A) **Mirror label monitor logic** (Recommended): If no PR review webhook received in 2x pollIntervalMs, decrease interval by 50% (increase frequency), restore when webhook resumes
- B) **Independent webhook health**: Track PR webhook health separately from issue webhooks, as they're different event types with different reliability profiles
- C) **No adaptive polling for PRs**: Keep PR polling at fixed interval since PR reviews are less frequent than issue label changes
**Answer**:

### Q19: Gate Integration with PR Feedback Flow
**Context**: The worker uses `GateChecker` to pause at review checkpoints based on gate definitions. The `waiting-for:address-pr-feedback` label is semantically similar to other waiting gates (like `waiting-for:implementation-review`). It's unclear if PR feedback addressing should integrate with the gate system or bypass it.
**Question**: Should the `address-pr-feedback` flow integrate with the gate checking system used by other workflow phases?
**Options**:
- A) **No gate integration** (Recommended): Treat PR feedback as an interrupt/side-quest that doesn't participate in the normal gate system, return to normal workflow after completion
- B) **Add as a new gate type**: Create gate definition for PR feedback that can be configured in `WorkerConfig.gates` similar to other phase gates
- C) **Map to implementation-review gate**: Consider PR feedback as part of the `waiting-for:implementation-review` gate and reuse existing gate logic
**Answer**:

### Q20: SSE Event Streaming for PR Feedback
**Context**: FR-5 mentions the dashboard streaming uses "existing SSE infrastructure" and the worker emits events like `workflow:started`. It's unclear what specific SSE events should be emitted during PR feedback addressing.
**Question**: What SSE events should be emitted during the PR feedback addressing flow?
**Options**:
- A) **Reuse workflow events** (Recommended): Emit standard `workflow:started`, `workflow:progress`, `workflow:completed` events with command set to `address-pr-feedback`
- B) **New pr-feedback events**: Create new event types like `pr-feedback:started`, `pr-feedback:comment-addressed`, `pr-feedback:completed` for more granular tracking
- C) **Minimal events**: Only emit `workflow:started` and `workflow:completed`, no progress events since feedback addressing is typically quick
**Answer**:

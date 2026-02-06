# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-02-06 21:12

### Q1: Event Handling Architecture
**Context**: The spec mentions listening for workflow events but doesn't specify how the plugin receives these events. This impacts architecture significantly - webhooks require a server endpoint, while polling requires scheduled tasks.
**Question**: How should the plugin receive GitHub workflow events?
**Options**:
- A: Webhook-based: Plugin exposes HTTP endpoint to receive GitHub webhooks
- B: Polling-based: Plugin periodically queries GitHub API for workflow status changes
- C: Hybrid: Use webhooks when available, fall back to polling

**Answer**: *Pending*

### Q2: Authentication Method
**Context**: The config shows token-based auth, but GitHub Apps offer better rate limits and security. This affects how the plugin authenticates with GitHub's API.
**Question**: Should the plugin support GitHub App authentication in addition to personal access tokens?
**Options**:
- A: Token-only: Simple PAT-based authentication
- B: GitHub App only: Requires app installation
- C: Both: Support PAT for simple cases, GitHub App for production

**Answer**: *Pending*

### Q3: Log Streaming Implementation
**Context**: The acceptance criteria mentions 'log streaming works' but the interface shows `getJobLogs()` returning a string. Real-time streaming requires different implementation than fetching complete logs.
**Question**: Should log retrieval be real-time streaming or batch fetching of complete logs?
**Options**:
- A: Batch: Fetch complete logs after job finishes
- B: Streaming: Real-time log output during job execution
- C: Both: Batch by default, optional streaming for active jobs

**Answer**: *Pending*

### Q4: Error Handling Strategy
**Context**: The integration points mention 'Report to agent' when tests fail, but there's no specification of how errors and failures should be communicated or what retry logic should exist.
**Question**: How should workflow failures be reported and should automatic retries be supported?
**Options**:
- A: Event emission only: Emit failure events, let consumers decide action
- B: Callback-based: Execute registered callbacks on failure with retry option
- C: Structured errors: Return detailed error objects with suggested actions

**Answer**: *Pending*

### Q5: GitHub Issues Plugin Integration
**Context**: The spec lists #12 GitHub Issues plugin as a dependency for linking, but doesn't specify what linking functionality is expected or required.
**Question**: What specific integration is needed with the GitHub Issues plugin?
**Options**:
- A: Minimal: Just share authentication/config between plugins
- B: Status linking: Automatically comment on issues when related workflows complete
- C: Full integration: Link workflow runs to issues, update labels, add check statuses

**Answer**: *Pending*


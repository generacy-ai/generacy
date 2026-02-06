# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-02-06 21:12

### Q1: Authentication Method
**Context**: The config shows email/apiToken (Basic Auth). Jira Cloud also supports OAuth 2.0 which is required for some enterprise features and provides better security. This affects the authentication flow and token management.
**Question**: Should the plugin support only Basic Auth (email + API token), or also OAuth 2.0?
**Options**:
- A: Basic Auth only (simpler, covers most use cases)
- B: OAuth 2.0 only (better security, more complex)
- C: Both (maximum flexibility, more implementation work)

**Answer**: *Pending*

### Q2: Error Handling Strategy
**Context**: Jira API can return various errors (rate limits, auth failures, validation errors, network issues). The plugin needs a consistent strategy for surfacing these to consumers.
**Question**: How should API errors be handled - throw exceptions with error details, return Result types with error info, or emit events?
**Options**:
- A: Throw typed exceptions (JiraAuthError, JiraRateLimitError, etc.)
- B: Return Result<T, JiraError> types (functional style)
- C: Emit error events via EventEmitter pattern

**Answer**: *Pending*

### Q3: Pagination Handling
**Context**: Jira's search API returns paginated results (default 50 issues). The plugin needs to decide whether to handle pagination internally or expose it to consumers.
**Question**: Should searchIssues automatically fetch all pages, or return paginated results with a cursor?
**Options**:
- A: Auto-fetch all pages (simpler API, risk of large memory usage)
- B: Return paginated with cursor (more control, more complex consumer code)
- C: Return async iterator (lazy fetching, memory efficient)

**Answer**: *Pending*

### Q4: Comment Format Support
**Context**: Jira Cloud uses Atlassian Document Format (ADF) for rich text. The plugin can accept plain text and convert, accept ADF directly, or support both.
**Question**: Should addComment accept plain text (auto-convert to ADF), raw ADF, or both?
**Options**:
- A: Plain text only (auto-convert to ADF internally)
- B: ADF only (consumers handle formatting)
- C: Both via overloaded signature or union type

**Answer**: *Pending*

### Q5: Webhook Verification
**Context**: Jira webhooks should be verified to ensure they come from Atlassian. This requires validating the request signature.
**Question**: Should the plugin include built-in webhook signature verification, or leave that to the consuming application?
**Options**:
- A: Built-in verification (plugin validates signatures)
- B: External verification (consumer validates before calling plugin)
- C: Optional verification helper (utility function provided but not required)

**Answer**: *Pending*


# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-02-01 22:11

### Q1: Humancy Review Timeout
**Context**: The workflow includes a humancy.request_review checkpoint, but the spec doesn't define what happens if the human reviewer doesn't respond. This affects whether the workflow can auto-proceed or must wait indefinitely.
**Question**: What should happen if the human review checkpoint times out? Should there be a default timeout, and if so, should the workflow auto-approve, auto-reject, or remain pending?
**Options**:
- A: No timeout - workflow waits indefinitely for human approval
- B: Configurable timeout with auto-reject (fail-safe)
- C: Configurable timeout with auto-approve (for low-risk workflows)
- D: Configurable timeout that escalates to another reviewer

**Answer**: *Pending*

### Q2: Error Handling Strategy
**Context**: The workflow has multiple steps that could fail (parse, validate, preview, create). The spec doesn't define how errors should be handled, which affects reliability and user experience.
**Question**: How should the workflow handle errors in individual steps? Should it fail fast, attempt retries, or allow partial completion?
**Options**:
- A: Fail fast - any step failure stops the entire workflow
- B: Retry with backoff - attempt each step up to N times before failing
- C: Partial completion - continue with remaining tasks if some fail

**Answer**: *Pending*

### Q3: Provider Auto-Detection
**Context**: The provider input is optional and can be github, jira, shortcut, or local. The spec doesn't clarify how the provider is determined if not explicitly specified.
**Question**: If the provider input is not specified, how should the workflow determine which backlog system to use?
**Options**:
- A: Detect from repository configuration (e.g., .github presence implies GitHub)
- B: Require explicit provider - make it a required input
- C: Use a global Generacy configuration setting
- D: Default to 'local' if no provider detected

**Answer**: *Pending*

### Q4: Issue Linking
**Context**: The workflow creates issues but doesn't specify how those issues should link back to the source spec or parent epic mentioned in the spec.
**Question**: Should created issues automatically link back to the source feature spec or parent epic? If so, how?
**Options**:
- A: Add feature directory path in issue body
- B: Use GitHub sub-issues or epic links where supported
- C: Both - include path and create relationship links
- D: No automatic linking - keep issues independent

**Answer**: *Pending*

### Q5: Workflow Output Format
**Context**: The outputs section mentions 'created issue details' but doesn't specify the exact format, which affects downstream workflow consumers.
**Question**: What specific fields should be included in the workflow output for each created issue?
**Options**:
- A: Minimal: issue ID and URL only
- B: Standard: ID, URL, title, and provider type
- C: Comprehensive: All fields plus original task mapping
- D: Provider-specific: Different fields based on the backlog system

**Answer**: *Pending*


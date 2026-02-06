# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-02-06 21:12

### Q1: Copilot Workspace API
**Context**: GitHub Copilot Workspace currently has no public API. The plugin interface implies programmatic access to create workspaces and poll status, but this may not be technically feasible.
**Question**: Does GitHub Copilot Workspace have an API we can integrate with, or is this plugin intended to work through browser automation, webhooks, or a future API?
**Options**:
- A: There's a private/partner API we have access to
- B: Use browser automation (Playwright) to interact with the Copilot Workspace UI
- C: Defer this plugin until Copilot releases a public API
- D: Use GitHub's existing APIs (Issues, PRs) and manual Copilot workspace creation

**Answer**: *Pending*

### Q2: Plugin Priority
**Context**: This plugin depends on #2 (Generacy Core Package) and is part of Epic #11. Given the API uncertainty for Copilot Workspace, the implementation order matters.
**Question**: Should this plugin be deprioritized until the Copilot Workspace API situation is clarified, or should we implement a partial solution?
**Options**:
- A: Deprioritize - wait for API clarity
- B: Implement partial solution with existing GitHub APIs only
- C: Proceed with browser automation approach

**Answer**: *Pending*

### Q3: Polling Mechanism
**Context**: The spec mentions 'status polling works' but doesn't define the polling strategy. Continuous polling vs webhooks has significant architectural implications.
**Question**: What polling/notification mechanism should be used for workspace status updates?
**Options**:
- A: Periodic polling (with configurable interval)
- B: GitHub webhooks for PR/issue events
- C: Manual status refresh only
- D: Long-polling or SSE if API supports it

**Answer**: *Pending*

### Q4: Workflow Engine Integration
**Context**: The acceptance criteria mentions 'Integration with workflow engine' but doesn't specify what events should trigger Copilot and what outputs feed back into the workflow.
**Question**: How should the Copilot plugin integrate with the Generacy workflow engine? What events trigger Copilot and what outputs are expected?
**Options**:
- A: Triggered manually by user selecting Copilot as agent
- B: Auto-triggered based on issue labels or workflow rules
- C: Fallback agent when primary agent fails

**Answer**: *Pending*

### Q5: Error Handling Strategy
**Context**: Copilot Workspace may fail silently, produce incomplete results, or time out. The spec doesn't address failure modes.
**Question**: What should happen when Copilot Workspace fails or produces incomplete results?
**Options**:
- A: Retry with exponential backoff
- B: Fall back to alternative agent
- C: Notify user and pause workflow
- D: Mark task as failed and continue with next task

**Answer**: *Pending*


# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-16 16:16

### Q1: Reference Repo Access
**Context**: The spec references the `claude-plugins` repo for templates and CLAUDE.md format, but it's unclear where this repo is located or if I have access to it.
**Question**: Where is the `claude-plugins` repo located? Is it accessible at a specific path, GitHub URL, or should I use a different reference source?
**Options**:
- A: Local path (specify location)
- B: GitHub repo (provide URL)
- C: Skip reference - create from scratch using best practices

**Answer**: The `claude-plugins` repo and other repos are cloned under `/workspaces/`. (Source: @christrudelpw via GitHub)

### Q2: MCP Server Selection
**Context**: The spec mentions Context7 and Playwright as recommended MCP servers, plus 'consider Redis/Docker if available'. This affects the .mcp.json configuration.
**Question**: Should I include ONLY Context7 and Playwright, or also add Redis/Docker MCP servers? Are there specific MCP server package names to use?
**Options**:
- A: Only Context7 and Playwright
- B: Include all available MCP servers (Context7, Playwright, Redis, Docker)
- C: Start minimal (Context7 only) and add others later

**Answer**: Reference `/workspaces/agency/.mcp.json` for an example of MCP server configuration. (Source: @christrudelpw via GitHub)

### Q3: Spec Template Sections
**Context**: The spec.md contains unfilled template sections (User Stories, Functional Requirements, Success Criteria, Assumptions, Out of Scope) which could block implementation clarity.
**Question**: Should I fill in these template sections based on the task description, or remove them since this is a simple infrastructure setup task?
**Options**:
- A: Fill in all sections with appropriate content
- B: Remove empty template sections - tasks and acceptance criteria are sufficient
- C: Keep as placeholders for future use

**Answer**: Remove the empty template sections - this is a simple infrastructure setup task, so tasks and acceptance criteria are sufficient. (Source: @christrudelpw via GitHub)


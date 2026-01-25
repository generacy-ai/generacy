# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-25 22:01

### Q1: Code Reuse Strategy
**Context**: The VS Code extension already has a workflow runner in `packages/generacy-extension/src/views/local/runner/` with executor, actions, interpolation, and retry logic. The spec proposes creating new `src/engine/` and `src/actions/` directories from scratch.
**Question**: Should the headless package extract and reuse the existing workflow runner code from the VS Code extension, or implement a clean-room version? If reusing, should we refactor to a shared package first?
**Options**:
- A: Extract existing runner to a shared `@generacy-ai/workflow-engine` package, then depend on it from both extension and headless CLI
- B: Copy and adapt the extension runner code into the new package (faster, but creates duplication)
- C: Implement clean-room version (spec-driven, may diverge from extension behavior)

**Answer**: *Pending*

### Q2: Package Location
**Context**: The monorepo has `packages/` for publishable npm packages (orchestrator, github-issues, generacy-plugin-claude-code) and `src/` for core library code.
**Question**: Where should the `@generacy-ai/generacy` package be created? As `packages/generacy/` or a new top-level directory?
**Options**:
- A: Create in `packages/generacy/` following existing package conventions
- B: Create as `generacy-cli/` at repo root (separate from library packages)

**Answer**: *Pending*

### Q3: Orchestrator Protocol
**Context**: The spec mentions connecting to orchestrator for job dispatch, but doesn't specify the protocol. The existing orchestrator uses HTTP REST APIs with endpoints like `/api/queue/jobs` and `/api/agents/register`.
**Question**: Should the worker/agent modes use the existing orchestrator REST API, or implement a new WebSocket/gRPC protocol for real-time job dispatch?
**Options**:
- A: Use existing REST API with polling for job dispatch
- B: Add WebSocket support to orchestrator for real-time push notifications
- C: Use REST for registration/heartbeat, WebSocket for job notifications (hybrid)

**Answer**: *Pending*

### Q4: Agency MCP Integration
**Context**: The spec mentions 'Start Agency MCP server as subprocess' but doesn't clarify the communication pattern. The existing claude-code plugin uses container-based invocation.
**Question**: How should the headless CLI communicate with Agency MCP? As a subprocess with stdio, or via network (if Agency exposes an HTTP/SSE transport)?
**Options**:
- A: Launch Agency as subprocess, communicate via stdio (MCP default)
- B: Connect to Agency running as a network service (requires Agency HTTP transport)
- C: Embed Agency directly (no subprocess, same process)

**Answer**: *Pending*

### Q5: Scope of Initial Release
**Context**: The spec lists 3 CLI commands (run, worker, agent) plus 5 core components. This is substantial scope that could delay initial usability.
**Question**: Should the initial release focus on a minimal viable CLI (just `run` command for local workflow execution), or implement all commands simultaneously?
**Options**:
- A: MVP: Just `run` command + workflow engine (enables local testing, defer worker/agent modes)
- B: Full scope: Implement all 3 commands in parallel (matches original spec)
- C: MVP with worker: `run` + `worker` commands (enables container deployment without full autonomy)

**Answer**: *Pending*


# Feature Specification: Create @generacy-ai/generacy npm package for headless workflow execution

**Branch**: `155-create-generacy-ai-generacy` | **Date**: 2026-01-25 | **Status**: Draft

## Summary

Create a publishable npm package (`@generacy-ai/generacy`) in `packages/generacy/` that provides headless workflow execution capabilities. The package will extract and reuse the existing workflow runner from the VS Code extension into a shared `@generacy-ai/workflow-engine` package, implement all 3 CLI commands (run, worker, agent) in the initial release, use REST API polling for orchestrator communication, and support both subprocess stdio and network service communication with Agency MCP.

## Description

Create a publishable npm package that provides headless workflow execution capabilities, serving as the entry point for agent dev containers without requiring VS Code.

## Problem

Currently, the Generacy workflow engine only runs via the VS Code extension. For parallel agent development in containers, we need a headless runner that can:
- Start as a container entry point
- Execute workflows without human interaction (except at defined gates)
- Connect to the orchestrator for job dispatch
- Work alongside Agency MCP server for tool access

## Proposed Solution

Create `@generacy-ai/generacy` npm package with:

### CLI Interface
```bash
# Run a specific workflow
npx @generacy-ai/generacy run <workflow.yaml> --input issueUrl=...

# Start as worker (connects to orchestrator, processes jobs)
npx @generacy-ai/generacy worker --orchestrator=http://... --id=worker-1

# Start as agent (full autonomous mode with Agency MCP)
npx @generacy-ai/generacy agent --orchestrator=http://... --id=agent-1
```

### Core Components

1. **Workflow Loader**
   - Parse .generacy.yaml workflow definitions
   - Validate against schema
   - Resolve action references

2. **Workflow Engine**
   - Execute steps sequentially (with parallel support)
   - Handle conditionals and loops
   - Manage workflow state
   - Support gates/waits for human review

3. **Action System**
   - Plugin-based action loading
   - Built-in actions: workspace.*, github.*, humancy.*, agent.*
   - Custom action registration

4. **Orchestrator Client**
   - Register with orchestrator
   - Heartbeat/health reporting
   - Receive job assignments
   - Report job completion/failure

5. **Agency Integration**
   - Support dual connection modes for Agency MCP:
     - Subprocess mode: Launch Agency as subprocess, communicate via stdio (MCP default)
     - Network mode: Connect to Agency running as a network service (HTTP transport)
   - Route tool calls through Agency
   - Access git, docker, npm tools via plugins

### Package Structure

**Location**: `packages/generacy/` (following existing monorepo package conventions)

```
packages/generacy/
├── src/
│   ├── cli/
│   │   ├── index.ts        # CLI entry point
│   │   ├── run.ts          # run command
│   │   ├── worker.ts       # worker command
│   │   └── agent.ts        # agent command
│   ├── orchestrator/
│   │   ├── client.ts       # REST API client with polling
│   │   ├── heartbeat.ts
│   │   └── job-handler.ts
│   ├── agency/
│   │   ├── index.ts        # Agency connection manager
│   │   ├── subprocess.ts   # Subprocess/stdio mode
│   │   └── network.ts      # Network/HTTP mode
│   └── index.ts
├── bin/
│   └── generacy.js         # CLI binary
└── package.json

packages/workflow-engine/    # NEW: Shared workflow engine
├── src/
│   ├── workflow-loader.ts
│   ├── workflow-engine.ts
│   ├── step-executor.ts
│   ├── state-manager.ts
│   ├── actions/
│   │   ├── action-registry.ts
│   │   ├── builtin/
│   │   │   ├── workspace.ts
│   │   │   ├── github.ts
│   │   │   ├── humancy.ts
│   │   │   └── agent.ts
│   │   └── index.ts
│   └── index.ts
└── package.json
```

**Note**: The workflow engine code will be extracted from `packages/generacy-extension/src/views/local/runner/` into a new shared `@generacy-ai/workflow-engine` package. Both the headless CLI and VS Code extension will depend on this shared package.

## Use Case

As a platform operator, I want to run Generacy workflows in headless containers so that multiple agents can process GitHub issues in parallel without requiring VS Code connections.

As a developer, I want to test workflows locally via CLI before deploying to container infrastructure.

## Acceptance Criteria

1. Package publishes to npm as @generacy-ai/generacy
2. `npx @generacy-ai/generacy --help` shows available commands
3. `npx @generacy-ai/generacy run workflow.yaml` executes a workflow
4. `npx @generacy-ai/generacy worker` connects to orchestrator and processes jobs
5. Workflow engine handles sequential steps, conditionals, and gates
6. Action system loads and executes built-in actions
7. No VS Code dependencies in package
8. Health check endpoint available for container orchestration
9. Graceful shutdown on SIGTERM/SIGINT
10. Comprehensive logging with configurable levels

## Related

- Parent epic: generacy-ai/triad-development#10
- Depends on: Existing generacy src/ code (scheduler, worker, agents)
- Blocks: Docker compose setup, speckit actions

## User Stories

### US1: Platform Operator - Headless Container Execution

**As a** platform operator,
**I want** to run Generacy workflows in headless containers,
**So that** multiple agents can process GitHub issues in parallel without requiring VS Code connections.

**Acceptance Criteria**:
- [ ] `npx @generacy-ai/generacy worker` connects to orchestrator and processes jobs
- [ ] Health check endpoint available for container orchestration
- [ ] Graceful shutdown on SIGTERM/SIGINT

### US2: Developer - Local Workflow Testing

**As a** developer,
**I want** to test workflows locally via CLI,
**So that** I can validate workflow behavior before deploying to container infrastructure.

**Acceptance Criteria**:
- [ ] `npx @generacy-ai/generacy run workflow.yaml` executes a workflow
- [ ] Comprehensive logging with configurable levels
- [ ] Workflow execution state is visible during runs

### US3: Agent - Autonomous Processing

**As a** autonomous agent,
**I want** to run in full autonomous mode with Agency MCP,
**So that** I can process complex tasks that require tool access.

**Acceptance Criteria**:
- [ ] `npx @generacy-ai/generacy agent` starts in autonomous mode
- [ ] Agency MCP server accessible via subprocess or network
- [ ] All built-in actions available (workspace.*, github.*, humancy.*, agent.*)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | CLI provides 3 commands: run, worker, agent | P1 | All commands in initial release |
| FR-002 | Workflow engine extracted to shared @generacy-ai/workflow-engine package | P1 | Reuse existing extension runner code |
| FR-003 | Orchestrator client uses REST API with polling | P1 | Existing orchestrator endpoints |
| FR-004 | Agency MCP supports dual connection modes (subprocess/network) | P1 | User choice for flexibility |
| FR-005 | No VS Code dependencies in packages | P1 | Headless operation requirement |
| FR-006 | Health check endpoint for container orchestration | P2 | |
| FR-007 | Graceful shutdown on SIGTERM/SIGINT | P2 | |
| FR-008 | Configurable logging levels | P2 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Package publishes to npm | Success | npm publish completes |
| SC-002 | CLI help works | Success | `npx @generacy-ai/generacy --help` outputs help |
| SC-003 | Workflow execution | Success | Sample workflow runs to completion |
| SC-004 | Worker job processing | Success | Worker receives and processes at least 1 job |

## Assumptions

- Existing orchestrator REST API is sufficient for job dispatch (no WebSocket needed)
- VS Code extension can be refactored to use shared workflow-engine package
- Agency MCP can be launched as subprocess or connected via network

## Out of Scope

- WebSocket/gRPC protocol for real-time job dispatch
- GUI or interactive mode
- Workflow editor/designer
- Multi-tenant isolation (single agent per container)

---

*Generated by speckit*

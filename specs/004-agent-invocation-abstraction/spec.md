# Feature Specification: Agent invocation abstraction

**Branch**: `004-agent-invocation-abstraction` | **Date**: 2026-01-19 | **Status**: Draft

## Summary

Implement the agent invocation abstraction layer that supports multiple agent platforms.

## Parent Epic

#2 - Generacy Core Package

## Requirements

### Agent Interface

```typescript
// Start minimal: streaming and mcp_tools only. Add capabilities as needed.
enum AgentFeature {
  Streaming = 'streaming',
  McpTools = 'mcp_tools'
}

interface AgentInvoker {
  name: string;                    // e.g., "claude-code", "copilot"

  // Capabilities
  supports(feature: AgentFeature): boolean;

  // Invocation
  invoke(config: InvocationConfig): Promise<InvocationResult>;

  // Lifecycle
  isAvailable(): Promise<boolean>;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}

interface InvocationConfig {
  command: string;                 // e.g., "/speckit:specify"
  context: {
    workingDirectory: string;
    environment?: Record<string, string>;
    mode?: string;                 // Mode flows through invocation context, not separate mutable state
    issueNumber?: number;
    branch?: string;
  };
  timeout?: number;
  streaming?: boolean;
}

// Standard detail level: summaries for debugging without overwhelming
interface ToolCallRecord {
  toolName: string;
  success: boolean;
  duration: number;
  timestamp: Date;
  inputSummary?: string;           // Truncated on success, detailed on failure
  outputSummary?: string;
  errorMessage?: string;
}

interface InvocationResult {
  success: boolean;
  output: string;
  exitCode?: number;
  duration: number;
  toolCalls?: ToolCallRecord[];
  error?: InvocationError;         // Present when success=false for invocation failures
}

// Hybrid error handling:
// - Throw for infrastructure errors (agent unavailable, initialization failed)
// - Return InvocationResult with success=false for invocation failures (timeout, non-zero exit)
interface InvocationError {
  code: string;                    // e.g., 'TIMEOUT', 'COMMAND_FAILED', 'AGENT_ERROR'
  message: string;
  details?: unknown;
}
```

### Agent Registry

```typescript
class AgentRegistry {
  register(invoker: AgentInvoker): void;
  unregister(name: string): void;
  get(name: string): AgentInvoker | undefined;
  list(): AgentInvoker[];

  // Default agent is determined by explicit configuration (not auto-detection).
  // If configured agent isn't available, fail explicitly rather than silently picking another.
  getDefault(): AgentInvoker;

  // Set the default agent by name (from configuration file)
  setDefault(name: string): void;
}
```

### Built-in Support

| Agent | Package | Features |
|-------|---------|----------|
| Claude Code | built-in | Full support, MCP tools |
| Copilot | plugin | Workspace chat |
| Cursor | plugin | Composer API |

### Agent Selection

- Default agent configuration
- Per-workflow agent override
- Per-step agent override
- Capability-based selection

### Mode Setting

Mode flows through `InvocationConfig.context.mode` rather than setting global state. This:
- Provides a cleaner API (mode flows through invocation, not separate mutable state)
- Avoids race conditions in concurrent invocations with different modes
- Removes external dependencies for mode management

The agent invoker implementation internally uses the mode from context when invoking.

### Output Capture

- Capture stdout/stderr
- Parse structured output
- Extract tool call records
- Handle streaming output

### Error Handling

Hybrid approach:
- **Throw exceptions** for infrastructure errors (agent unavailable, initialization failed) - these are systemic issues
- **Return InvocationResult** with `success=false` for invocation failures (command timeout, non-zero exit) - these are expected workflow outcomes

## Acceptance Criteria

- [ ] Claude Code agent works
- [ ] Plugin interface for additional agents
- [ ] Mode passed through InvocationConfig.context
- [ ] Output capture and parsing
- [ ] Timeout and error handling (hybrid: throw for infrastructure, return for invocation)
- [ ] Agent availability checks
- [ ] Default agent configured explicitly (fail if unavailable)
- [ ] ToolCallRecord captures standard detail level (name, success, duration, timestamps, summaries)

## User Stories

### US1: Invoke Claude Code Agent

**As a** workflow orchestrator,
**I want** to invoke Claude Code with a command and context,
**So that** I can execute speckit commands programmatically.

**Acceptance Criteria**:
- [ ] Can invoke with command string and working directory
- [ ] Receives structured result with success/failure and output
- [ ] Handles timeouts gracefully

### US2: Check Agent Availability

**As a** workflow orchestrator,
**I want** to check if an agent is available before invoking,
**So that** I can fail fast or select an alternative.

**Acceptance Criteria**:
- [ ] `isAvailable()` returns true/false without side effects
- [ ] Throws infrastructure error if agent cannot be initialized

### US3: Capture Tool Call Records

**As a** developer debugging workflows,
**I want** to see what tool calls the agent made during execution,
**So that** I can understand and troubleshoot agent behavior.

**Acceptance Criteria**:
- [ ] Tool calls include name, success, duration, timestamps
- [ ] Summaries provided for inputs/outputs (truncated on success)
- [ ] Error messages included on failure

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | AgentInvoker interface with invoke(), isAvailable(), initialize(), shutdown() | P1 | |
| FR-002 | AgentRegistry with register/unregister/get/list/getDefault | P1 | |
| FR-003 | Claude Code invoker implementation | P1 | Built-in |
| FR-004 | AgentFeature enum with streaming, mcp_tools | P2 | Start minimal |
| FR-005 | ToolCallRecord with standard detail level | P2 | |
| FR-006 | Configuration-based default agent selection | P1 | Fail if unavailable |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Claude Code invocation success rate | >95% | Count successful invocations |
| SC-002 | Invocation timeout handling | 100% | No hung processes |

## Assumptions

- Claude Code CLI is available in the execution environment
- Working directory exists and is accessible
- Agent processes run in isolated contexts

## Out of Scope

- Copilot and Cursor agent implementations (plugin interface provided)
- Global mode state management (mode flows through context)
- Full input/output capture in ToolCallRecord (summaries only)

---

*Generated by speckit*

# Implementation Plan: Plugin: @generacy-ai/generacy-plugin-claude-code

**Feature**: Claude Code agent platform plugin for Generacy
**Branch**: `013-plugin-generacy-ai-generacy`
**Status**: Complete

## Summary

Implement the `@generacy-ai/generacy-plugin-claude-code` package that provides a thin interface for invoking Claude Code agents in isolated Docker containers. The plugin manages sessions, streams structured output, and integrates with the Humancy decision framework for human-in-the-loop decisions.

## Technical Context

| Aspect | Value |
|--------|-------|
| Language | TypeScript 5.4+ |
| Runtime | Node.js 20+ |
| Module System | ES Modules |
| Testing | Vitest |
| Build | tsc |
| Package Manager | npm (monorepo) |

### Key Dependencies

| Dependency | Purpose |
|------------|---------|
| dockerode | Docker API client for container management |
| pino | Structured logging (matches existing pattern) |
| zod | Runtime validation for configs |
| @types/dockerode | TypeScript definitions |

## Project Structure

```
packages/generacy-plugin-claude-code/
├── src/
│   ├── index.ts                      # Main exports
│   ├── types.ts                      # Core type definitions
│   ├── errors.ts                     # Custom error classes
│   ├── plugin/
│   │   ├── claude-code-plugin.ts     # Main plugin class
│   │   └── types.ts                  # Plugin-specific types
│   ├── session/
│   │   ├── session-manager.ts        # Session lifecycle management
│   │   ├── session.ts                # Session class
│   │   └── types.ts                  # Session types
│   ├── container/
│   │   ├── container-manager.ts      # Docker container operations
│   │   ├── container-factory.ts      # Container creation logic
│   │   └── types.ts                  # Container config types
│   ├── streaming/
│   │   ├── output-stream.ts          # Async generator for output
│   │   ├── output-parser.ts          # Parse Claude Code JSON output
│   │   └── types.ts                  # OutputChunk definitions
│   └── invocation/
│       ├── invoker.ts                # Invocation execution logic
│       └── types.ts                  # InvokeParams, InvokeOptions
├── tests/
│   ├── unit/
│   │   ├── session-manager.test.ts
│   │   ├── output-parser.test.ts
│   │   └── container-manager.test.ts
│   └── integration/
│       └── plugin.integration.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    ClaudeCodePlugin                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────┐  │
│  │ SessionManager  │  │ ContainerManager │  │    Invoker     │  │
│  │                 │  │                  │  │                │  │
│  │ - sessions Map  │  │ - docker client  │  │ - execute()    │  │
│  │ - start()       │◄─┤ - create()       │◄─┤ - buildCmd()   │  │
│  │ - continue()    │  │ - cleanup()      │  │ - parseOutput()│  │
│  │ - end()         │  │ - attach()       │  │                │  │
│  └────────┬────────┘  └─────────────────┘  └───────┬────────┘  │
│           │                                          │          │
│           ▼                                          ▼          │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                     OutputStream                         │   │
│  │     AsyncIterable<OutputChunk> from container stdout     │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Session State Machine

```
                    ┌──────────────┐
                    │   created    │
                    └──────┬───────┘
                           │ startSession()
                           ▼
            ┌──────────────────────────────┐
            │          running             │
            │  (container active, ready)   │
            └──────────────┬───────────────┘
                           │
           ┌───────────────┼───────────────┐
           │ question      │               │ invoke()
           ▼               │               │
    ┌──────────────┐       │        ┌──────▼───────┐
    │awaiting_input│───────┼───────►│  executing   │
    └──────────────┘       │        └──────────────┘
           │ continueSession()             │
           │               │               │ complete/error
           └───────────────┼───────────────┘
                           │
                           ▼ endSession()
                    ┌──────────────┐
                    │   terminated │
                    └──────────────┘
```

## Implementation Phases

### Phase 1: Core Types & Errors

1. Create package scaffolding (package.json, tsconfig.json)
2. Define core types in `src/types.ts`
3. Define error classes in `src/errors.ts`
4. Set up exports in `src/index.ts`

### Phase 2: Container Management

1. Implement `ContainerManager` with dockerode
2. Create container factory for building container configs
3. Implement container lifecycle (create, start, attach, cleanup)
4. Add health checks and timeout handling

### Phase 3: Session Management

1. Implement `Session` class with state machine
2. Implement `SessionManager` for session registry
3. Add session state transitions
4. Implement awaiting_input state for human decisions

### Phase 4: Output Streaming

1. Implement `OutputParser` for Claude Code JSON
2. Implement `OutputStream` async generator
3. Handle all OutputChunk types (stdout, stderr, tool_call, etc.)
4. Implement question detection for human decisions

### Phase 5: Invocation

1. Implement `Invoker` class
2. Build Claude Code CLI command with headless mode
3. Connect invocation to session and container
4. Handle mode setting via Agency integration

### Phase 6: Plugin Integration

1. Implement `ClaudeCodePlugin` main class
2. Wire all components together
3. Implement public API methods
4. Add logging with pino

### Phase 7: Testing

1. Unit tests for each component
2. Integration tests with Docker
3. Mock tests for CI environments without Docker

## Key Technical Decisions

### 1. Docker Client: dockerode

**Decision**: Use `dockerode` for Docker API interactions.

**Rationale**:
- Most mature Docker client for Node.js
- Full Docker API support
- Stream handling built-in
- Active maintenance

**Alternative Considered**: `node-docker-api` - Less mature, fewer features.

### 2. Output Streaming: Async Generators

**Decision**: Use async generators for `streamOutput()`.

**Rationale**:
- Native JavaScript async iteration
- Back-pressure handling built-in
- Composable with for-await-of
- Clean API for consumers

```typescript
async *streamOutput(sessionId: string): AsyncIterable<OutputChunk> {
  // Yield chunks as they arrive from container stdout
}
```

### 3. Session State: Finite State Machine

**Decision**: Implement explicit state machine for sessions.

**Rationale**:
- Clear state transitions
- Prevents invalid operations
- Self-documenting behavior
- Easier debugging

### 4. Error Handling: Fail-Fast with Classification

**Decision**: Surface errors immediately with rich classification.

**Rationale**:
- Matches spec requirement
- Workflow engine handles retry
- Clear contract for consumers

### 5. Container Cleanup: Eager Cleanup

**Decision**: Clean up containers immediately after session ends.

**Rationale**:
- Prevents resource leaks
- Sessions are ephemeral per spec
- Workflow handles continuity

## Integration Points

### With Generacy Core

The plugin implements patterns from `src/agents/types.ts`:
- `AgentInvoker` interface compatibility
- Registration in `AgentRegistry`

### With Workflow Engine

- Fail-fast errors let workflow handle retry
- `context` field in `InvokeOptions` for workflow state
- Session IDs for tracking invocations

### With Humancy Decision Framework

- `OutputChunk` with `type: 'question'` triggers decision queue
- `urgency` field maps to Humancy urgency levels
- `continueSession()` provides decision response

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Docker unavailable | Graceful error with clear message |
| Container crashes | Detect and report as `CONTAINER_CRASHED` |
| Output parsing fails | Fallback to raw stdout chunk |
| Session memory leak | Timeout-based cleanup |
| Rate limiting | Pass through as `RATE_LIMITED` error |

## Acceptance Validation

| Criterion | Validation Approach |
|-----------|---------------------|
| Invoke Claude Code in container | Integration test with real Docker |
| Mode setting works | Unit test mocking Agency |
| Output streaming works | Unit test with mock container |
| Session management works | Unit test state transitions |
| Headless mode works | Integration test with `--headless` |
| Error handling fail-fast | Unit test error propagation |
| Human decision handling | Unit test question flow |

## Next Steps

Run `/speckit:tasks` to generate the detailed task list from this plan.

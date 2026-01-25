# Tasks: @generacy-ai/generacy npm package

**Input**: Design documents from `/specs/155-create-generacy-ai-generacy/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Setup & Project Structure

- [x] T001 Create `packages/workflow-engine/` directory structure and `package.json`
  - Path: `packages/workflow-engine/package.json`
  - Dependencies: yaml, zod
  - Configure ES modules (`"type": "module"`)

- [x] T002 [P] Create `packages/generacy/` directory structure and `package.json`
  - Path: `packages/generacy/package.json`
  - Dependencies: @generacy-ai/workflow-engine, commander, pino, pino-pretty
  - Configure ES modules and `bin` entry

- [x] T003 [P] Create tsconfig.json for workflow-engine package
  - Path: `packages/workflow-engine/tsconfig.json`
  - Extend from root tsconfig, target ES2022

- [x] T004 [P] Create tsconfig.json for generacy CLI package
  - Path: `packages/generacy/tsconfig.json`
  - Extend from root tsconfig, target ES2022

---

## Phase 2: Workflow Engine - Core Types & Interfaces

- [x] T010 [US2] Create workflow definition types
  - Path: `packages/workflow-engine/src/types/workflow.ts`
  - Define: WorkflowDefinition, PhaseDefinition, StepDefinition, InputDefinition
  - Export from index.ts

- [x] T011 [P] [US2] Create execution state types
  - Path: `packages/workflow-engine/src/types/execution.ts`
  - Define: ExecutableWorkflow, ExecutionResult, ExecutionStatus, PhaseResult, StepResult

- [x] T012 [P] [US2] Create action system types
  - Path: `packages/workflow-engine/src/types/action.ts`
  - Define: ActionHandler, ActionContext, ActionResult, StepOutput

- [x] T013 [P] [US2] Create logger interface
  - Path: `packages/workflow-engine/src/types/logger.ts`
  - Define: Logger interface (info, warn, error, debug, child)

- [x] T014 Create retry configuration types
  - Path: `packages/workflow-engine/src/types/retry.ts`
  - Define: RetryConfig, BackoffStrategy

- [x] T015 Create main types barrel export
  - Path: `packages/workflow-engine/src/types/index.ts`
  - Re-export all types

---

## Phase 3: Workflow Engine - Loader & Validation

- [x] T020 [US2] Create workflow YAML loader
  - Path: `packages/workflow-engine/src/loader/index.ts`
  - Load YAML file, parse to WorkflowDefinition
  - Use `yaml` package for parsing

- [x] T021 [US2] Create Zod validation schemas
  - Path: `packages/workflow-engine/src/loader/schema.ts`
  - Define Zod schemas matching all WorkflowDefinition types
  - Export validation function

- [x] T022 [US2] Create workflow validator
  - Path: `packages/workflow-engine/src/loader/validator.ts`
  - Validate using Zod schemas
  - Return typed WorkflowDefinition or throw detailed errors

---

## Phase 4: Workflow Engine - Interpolation

- [x] T030 [US2] Create interpolation engine
  - Path: `packages/workflow-engine/src/interpolation/index.ts`
  - Support patterns: `${inputs.*}`, `${steps.*}`, `${env.*}`
  - Extract from existing extension code if available

- [x] T031 [US2] Create execution context
  - Path: `packages/workflow-engine/src/interpolation/context.ts`
  - Define ExecutionContext class with inputs, stepOutputs, env
  - Provide value resolution methods

---

## Phase 5: Workflow Engine - Retry System

- [x] T040 [US2] Create retry manager
  - Path: `packages/workflow-engine/src/retry/index.ts`
  - Implement retry loop with configurable attempts
  - Support AbortSignal for cancellation

- [x] T041 [P] [US2] Create backoff strategies
  - Path: `packages/workflow-engine/src/retry/strategies.ts`
  - Implement: constant, linear, exponential (with jitter option)
  - Calculate delay based on attempt number

---

## Phase 6: Workflow Engine - Action System

- [x] T050 [US3] Create action registry
  - Path: `packages/workflow-engine/src/actions/index.ts`
  - Register handlers by type
  - Lookup handlers for steps

- [x] T051 [US3] Create base action class
  - Path: `packages/workflow-engine/src/actions/base-action.ts`
  - Abstract base with common utilities
  - Implement canHandle default logic

- [x] T052 [US3] Implement workspace.prepare action
  - Path: `packages/workflow-engine/src/actions/builtin/workspace-prepare.ts`
  - Git clone/checkout operations
  - Configure workdir

- [x] T053 [P] [US3] Implement agent.invoke action
  - Path: `packages/workflow-engine/src/actions/builtin/agent-invoke.ts`
  - Claude CLI invocation
  - Capture stdout/stderr

- [x] T054 [P] [US3] Implement verification.check action
  - Path: `packages/workflow-engine/src/actions/builtin/verification-check.ts`
  - Run tests, linting commands
  - Parse exit codes

- [x] T055 [P] [US3] Implement github.pr-create action
  - Path: `packages/workflow-engine/src/actions/builtin/pr-create.ts`
  - GitHub PR creation via gh CLI or API

- [x] T056 [US3] Implement shell action (fallback)
  - Path: `packages/workflow-engine/src/actions/builtin/shell.ts`
  - Generic shell command execution
  - Used when no specific handler matches

---

## Phase 7: Workflow Engine - Executor

- [x] T060 [US2] Create workflow executor
  - Path: `packages/workflow-engine/src/executor/index.ts`
  - Execute phases and steps sequentially
  - Handle conditions, errors, cancellation

- [x] T061 [US2] Create event emission system
  - Path: `packages/workflow-engine/src/executor/events.ts`
  - Define: ExecutorEvent types (workflow:start, step:complete, etc.)
  - Implement event emitter pattern

- [x] T062 Create workflow-engine main export
  - Path: `packages/workflow-engine/src/index.ts`
  - Export: WorkflowExecutor, loadWorkflow, validateWorkflow, registerActionHandler
  - Export all types

---

## Phase 8: CLI Package - Core Infrastructure

- [x] T070 [US2] Create CLI logger setup
  - Path: `packages/generacy/src/cli/utils/logger.ts`
  - Configure Pino with pretty output for dev, JSON for prod
  - Support LOG_LEVEL env var

- [x] T071 [P] [US2] Create CLI config resolution
  - Path: `packages/generacy/src/cli/utils/config.ts`
  - Merge: defaults → env vars → CLI args
  - Define CLIConfig interface

- [x] T072 Create CLI entry point
  - Path: `packages/generacy/src/cli/index.ts`
  - Setup Commander.js program
  - Register subcommands: run, worker, agent

- [x] T073 Create bin entry script
  - Path: `packages/generacy/bin/generacy.js`
  - Shebang, import CLI entry, handle errors

---

## Phase 9: CLI Package - Run Command

- [x] T080 [US2] Implement run command
  - Path: `packages/generacy/src/cli/commands/run.ts`
  - Load workflow from file
  - Parse --input key=value arguments
  - Execute using WorkflowExecutor
  - Display results

---

## Phase 10: CLI Package - Orchestrator Client

- [x] T090 [US1] Create orchestrator REST client
  - Path: `packages/generacy/src/orchestrator/client.ts`
  - Use native fetch API
  - Implement: register, unregister, pollForJob, updateJobStatus, reportJobResult

- [x] T091 [US1] Create orchestrator types
  - Path: `packages/generacy/src/orchestrator/types.ts`
  - Define: Job, JobStatus, JobResult, WorkerRegistration, Heartbeat
  - Match existing orchestrator API

- [x] T092 [US1] Create heartbeat manager
  - Path: `packages/generacy/src/orchestrator/heartbeat.ts`
  - Periodic heartbeat with configurable interval
  - Report worker status and current job

- [x] T093 [US1] Create job handler
  - Path: `packages/generacy/src/orchestrator/job-handler.ts`
  - Poll for jobs at configurable interval
  - Execute job workflow
  - Report results back to orchestrator

---

## Phase 11: CLI Package - Worker Command

- [x] T100 [US1] Implement worker command
  - Path: `packages/generacy/src/cli/commands/worker.ts`
  - Connect to orchestrator
  - Start heartbeat
  - Poll and process jobs in loop
  - Handle graceful shutdown (SIGTERM/SIGINT)

---

## Phase 12: CLI Package - Health Check

- [x] T110 [US1] Create health check HTTP server
  - Path: `packages/generacy/src/health/server.ts`
  - GET /health endpoint
  - Return status, uptime, lastHeartbeat
  - Configurable port (default 8080)

---

## Phase 13: CLI Package - Agency Integration

- [x] T120 [US3] Create agency connection interface
  - Path: `packages/generacy/src/agency/index.ts`
  - Define AgencyConnection interface
  - Factory function to create appropriate mode

- [x] T121 [US3] Implement subprocess agency mode
  - Path: `packages/generacy/src/agency/subprocess.ts`
  - Launch Agency MCP as child process
  - Communicate via stdio (MCP default transport)
  - Handle process lifecycle

- [x] T122 [US3] Implement network agency mode
  - Path: `packages/generacy/src/agency/network.ts`
  - Connect to Agency HTTP service
  - Use HTTP-based MCP transport
  - Handle connection errors and retries

---

## Phase 14: CLI Package - Agent Command

- [x] T130 [US3] Implement agent command
  - Path: `packages/generacy/src/cli/commands/agent.ts`
  - Extend worker with Agency integration
  - Connect to Agency before starting job loop
  - Route tool calls through Agency connection

---

## Phase 15: CLI Package - Library Exports

- [x] T140 Create main library export
  - Path: `packages/generacy/src/index.ts`
  - Export: OrchestratorClient, AgencyConnection, SubprocessAgency, NetworkAgency
  - Re-export workflow-engine types

---

## Phase 16: Testing

- [x] T150 [US2] Add unit tests for workflow loader
  - Path: `packages/workflow-engine/src/loader/__tests__/`
  - Test YAML parsing, validation errors

- [x] T151 [P] [US2] Add unit tests for interpolation
  - Path: `packages/workflow-engine/src/interpolation/__tests__/`
  - Test variable substitution patterns

- [x] T152 [P] [US2] Add unit tests for retry system
  - Path: `packages/workflow-engine/src/retry/__tests__/`
  - Test backoff calculations

- [x] T153 [US2] Add unit tests for executor
  - Path: `packages/workflow-engine/src/executor/__tests__/`
  - Test phase/step execution, error handling

- [x] T154 [US1] Add integration tests for CLI commands
  - Path: `packages/generacy/src/__tests__/`
  - Test run, worker commands with mocks

---

## Phase 17: Documentation & Polish

- [x] T160 Add README for workflow-engine package
  - Path: `packages/workflow-engine/README.md`
  - API documentation, usage examples

- [x] T161 [P] Add README for generacy CLI package
  - Path: `packages/generacy/README.md`
  - CLI usage, configuration, examples

- [x] T162 Add sample workflow file
  - Path: `packages/generacy/examples/sample-workflow.yaml`
  - Demonstrate basic workflow structure

---

## Dependencies & Execution Order

### Phase Dependencies
- **Phase 1** (Setup) → Required for all subsequent phases
- **Phases 2-7** (Workflow Engine) → Sequential, core types before loader before executor
- **Phase 8** (CLI Infrastructure) → Depends on Phase 7 (engine complete)
- **Phases 9-14** (CLI Commands) → Depend on Phase 8, can partially parallelize
- **Phase 15** (Exports) → Depends on Phases 9-14
- **Phase 16** (Testing) → Depends on implementation phases
- **Phase 17** (Documentation) → Can run parallel to testing

### Parallel Opportunities
Within phases, tasks marked `[P]` can run in parallel:
- T002, T003, T004 (parallel package setup)
- T011, T012, T013 (parallel type definitions)
- T041 (parallel with T040)
- T053, T054, T055 (parallel action implementations)
- T071 (parallel with T070)
- T151, T152 (parallel test writing)
- T161 (parallel with T160)

### Critical Path
T001 → T010-T015 → T020-T022 → T030-T031 → T040-T041 → T050-T056 → T060-T062 → T072-T073 → T080 → T090-T093 → T100 → T110 → T120-T122 → T130 → T140

---

*Generated by speckit*

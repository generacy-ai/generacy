# Feature: Claude CLI Worker with Phase Loop

**Issue**: [#198](https://github.com/generacy-ai/generacy/issues/198)
**Parent Epic**: [#195 - Implement label-driven orchestrator package](https://github.com/generacy-ai/generacy/issues/195)
**Status**: Draft

## Overview

Implement the Worker component that replaces the placeholder handler in the orchestrator's `WorkerDispatcher`. The worker spawns Claude CLI processes to execute speckit workflow phases on claimed GitHub issues, manages label transitions between phases, posts/updates stage comments, captures conversation output for dashboard streaming, and handles errors with structured reporting.

## Context

The orchestrator already has all surrounding infrastructure in place:

- **RedisQueueAdapter** (`services/redis-queue-adapter.ts`) — Redis sorted-set queue with atomic claim/release/complete operations
- **WorkerDispatcher** (`services/worker-dispatcher.ts`) — Polls queue, enforces concurrency limits, manages heartbeats, reaps stale workers
- **LabelMonitorService** (`services/label-monitor-service.ts`) — Detects `process:*` and `completed:*`/`waiting-for:*` labels, enqueues items
- **PhaseTrackerService** (`services/phase-tracker-service.ts`) — Redis-backed deduplication

The dispatcher currently uses a placeholder handler in `server.ts` (line ~153):
```typescript
const placeholderHandler = async (item: QueueItem) => {
  server.log.info({ ... }, 'Worker handler invoked (placeholder)');
};
```

This issue replaces that placeholder with a production `ClaudeCliWorker` that spawns Claude CLI processes and drives the speckit phase loop. The existing `WorkerHandler` type signature (`(item: QueueItem) => Promise<void>`) defines the integration contract.

The codebase already has patterns for subprocess management:
- `SubprocessAgency` in `packages/generacy/src/agency/subprocess.ts` — JSON-RPC over stdio
- `Invoker` in `packages/generacy-plugin-claude-code/src/invocation/invoker.ts` — Claude CLI invocation with `--headless --output json`

## User Stories

1. **As an orchestrator operator**, I want claimed issues to be processed by spawning Claude CLI with the correct speckit command so that workflow phases execute automatically.
2. **As an orchestrator operator**, I want label transitions managed automatically so that `phase:*` and `completed:*` labels accurately reflect processing state.
3. **As an orchestrator operator**, I want the worker to stop cleanly when a `waiting-for:*` label is detected so that review gates pause processing without errors.
4. **As an orchestrator operator**, I want stage comments posted and updated on the issue so that progress is visible to developers.
5. **As an orchestrator operator**, I want conversation output captured and streamed via SSE so that the dashboard can display real-time worker activity.
6. **As an orchestrator operator**, I want structured error handling with `agent:error` labels and error comments so that failures are visible and diagnosable.
7. **As an orchestrator operator**, I want heartbeats sent during processing so that the dispatcher can detect and recover from stalled workers.

## Existing Code

| Component | Package | Path |
|-----------|---------|------|
| `WorkerHandler` type | `@generacy-ai/orchestrator` | `packages/orchestrator/src/types/monitor.ts` |
| `QueueItem` type | `@generacy-ai/orchestrator` | `packages/orchestrator/src/types/monitor.ts` |
| `WorkerInfo` type | `@generacy-ai/orchestrator` | `packages/orchestrator/src/types/monitor.ts` |
| `WorkerDispatcher` | `@generacy-ai/orchestrator` | `packages/orchestrator/src/services/worker-dispatcher.ts` |
| Placeholder handler | `@generacy-ai/orchestrator` | `packages/orchestrator/src/server.ts` |
| `WORKFLOW_LABELS` | `@generacy-ai/workflow-engine` | `packages/workflow-engine/src/actions/github/label-definitions.ts` |
| `SubprocessAgency` | `@generacy-ai/generacy` | `packages/generacy/src/agency/subprocess.ts` |
| `Invoker` | `@generacy-ai/generacy-plugin-claude-code` | `packages/generacy-plugin-claude-code/src/invocation/invoker.ts` |
| SSE events | `@generacy-ai/orchestrator` | `packages/orchestrator/src/sse/events.ts` |
| Config schema | `@generacy-ai/orchestrator` | `packages/orchestrator/src/config/schema.ts` |

## Functional Requirements

### FR-1: Phase Resolution

- Given a `QueueItem` with `command: 'process'`, determine the starting phase:
  - Query the issue's current labels via GitHub API
  - If a `phase:*` label exists, resume from that phase
  - If `completed:*` labels exist, start from the next uncompleted phase
  - If no phase labels exist, start from `specify`
- Given a `QueueItem` with `command: 'continue'`, determine the resume phase:
  - Find the `waiting-for:*` label that was just satisfied (matching `completed:*`)
  - Map the satisfied gate to the next phase in the workflow
- **Full loop per claim**: The worker loops through ALL remaining phases in a single queue claim until hitting a `waiting-for:*` gate or workflow completion. The dispatcher calls `queue.complete()` on handler success (permanently removing the item). Re-enqueue only occurs via `LabelMonitorService` detecting label changes for `continue` commands.

### FR-2: Phase Sequence Definition

- Define the speckit phase loop:
  ```
  specify → clarify → plan → tasks → implement → validate
  ```
- Each phase maps to a Claude CLI slash command:
  | Phase | Slash Command |
  |-------|---------------|
  | `specify` | `/speckit:specify` |
  | `clarify` | `/speckit:clarify --issue <number>` |
  | `plan` | `/speckit:plan` |
  | `tasks` | `/speckit:tasks` |
  | `implement` | `/speckit:implement` |
  | `validate` | Runs configurable test command (default: `pnpm test && pnpm build`). Auto-completes if passing; sets `agent:error` if failing. `waiting-for:manual-validation` available as configurable option for workflows requiring human sign-off. |

### FR-3: Claude CLI Spawning

- Spawn `claude` as a child process with arguments:
  ```
  claude --headless --output json --print all --max-turns 100 --prompt "<constructed prompt>"
  ```
- The prompt should include the raw speckit slash command for the current phase (worker handles all label transitions, stage comments, and state machine):
  - The slash command for the current phase (e.g., `/speckit:specify`)
  - The issue URL for context
  - Any phase-specific arguments (e.g., `--issue <number>` for clarify)
- **Separation of concerns**: Speckit commands do the AI work (generate artifacts, post comments); the worker manages the state machine (labels, phase transitions, gates, stage comments). This avoids dual-control issues.
- Environment variables to pass:
  - `GITHUB_TOKEN` — for GitHub API access
  - Any MCP tool configuration the worker needs
- Working directory: the repository checkout (cloned or pre-existing)
- Capture stdout and stderr streams for output parsing

### FR-4: Label Transitions

- **On phase start**: Add `phase:<current>` label, remove any previous `phase:*` label
- **On phase completion**: Add `completed:<current>` label, remove `phase:<current>` label
- **On waiting-for detection** (configuration-driven): Add `waiting-for:<gate>` label, remove `phase:<current>` label, set `agent:paused` label, exit cleanly. Gate mapping is configuration-driven with predefined defaults per workflow type (e.g., `speckit-feature` gates at clarify; `speckit-bugfix` skips clarify). Optional review gates (`waiting-for:spec-review`, `waiting-for:plan-review`, etc.) can be enabled per workflow in config.
- **On error**: Add `agent:error` label, remove `phase:<current>` label
- **On workflow complete** (all phases done): Remove `agent:in-progress` label
- Use GitHub API via the existing `createGitHubClient` factory for all label operations

### FR-5: Stage Comment Management

- Post or update three stage comments per issue using HTML markers:
  - `<!-- generacy-stage:specification -->` — covers specify + clarify phases
  - `<!-- generacy-stage:planning -->` — covers plan + tasks phases
  - `<!-- generacy-stage:implementation -->` — covers implement + validate phases
- Each stage comment should include:
  - Current status (in_progress, complete, error)
  - Phase progress (which sub-phases are done)
  - Timestamps for start/completion
  - Link to PR (if available)
- Update the relevant stage comment at the start and end of each phase

### FR-6: Output Capture and Streaming

- Parse Claude CLI's JSON output stream for structured events
- Emit SSE events via the existing `SubscriptionManager`:
  - `workflow:started` — when worker begins processing an issue
  - `step:started` / `step:completed` — for each phase
  - `workflow:completed` / `workflow:failed` — on finish
- Include `workflowId` (e.g., `{owner}/{repo}#{issue}`) in all events
- Buffer output for post-processing (conversation log)

### FR-7: Heartbeat Integration

- The `WorkerDispatcher` already manages heartbeat refresh via `setInterval` at half the TTL
- The worker's `Promise<void>` returned from the handler keeps the heartbeat alive
- If the Claude CLI process hangs beyond the heartbeat TTL, the dispatcher's reaper will detect and release the item
- No additional heartbeat logic needed in the worker itself — just ensure the handler promise resolves or rejects in bounded time

### FR-8: Error Handling

- **Process crash**: If Claude CLI exits with non-zero code:
  - Add `agent:error` label to the issue
  - Post an error comment with: exit code, last N lines of stderr, phase that failed
  - Re-throw error so dispatcher calls `queue.release()` for retry
- **Timeout**: If processing exceeds a configurable timeout (`WORKER_PHASE_TIMEOUT_MS`):
  - Kill the Claude CLI process (SIGTERM, then SIGKILL after grace period)
  - Handle same as process crash
- **GitHub API errors**: Retry label operations with exponential backoff (3 attempts)
- **Partial progress**: If a phase completes but the next phase fails to start, the completed phase's label should already be persisted

### FR-9: Repository Checkout

- Before spawning Claude CLI, ensure the repository is available locally:
  - Check if a checkout exists at a configured workspace path
  - If not, clone the repository (`git clone`)
  - If exists, fetch latest and checkout the appropriate branch (feature branch from the issue, or default branch)
- Checkout path convention: `{WORKSPACE_DIR}/{workerId}/{owner}/{repo}` — per-worker isolated checkout to avoid race conditions with concurrent workers on the same repository. Each worker gets its own clone; cleanup on worker completion or via periodic pruner.

### FR-10: Graceful Shutdown

- On abort signal from the dispatcher:
  - Send SIGTERM to the Claude CLI process
  - Wait for a grace period (5 seconds)
  - If still running, send SIGKILL
  - Clean up any partial label state (remove `phase:*` if set)
  - Return so the dispatcher can release the item back to the queue

## Non-Functional Requirements

- **Bounded execution**: Each phase must complete within `WORKER_PHASE_TIMEOUT_MS` (default: 600000ms / 10 minutes)
- **Isolation**: Each worker process runs in its own subprocess with isolated environment
- **Observability**: Structured logging for all phase transitions, label changes, process lifecycle events
- **Testability**: Core phase resolution, label transition, and output parsing logic must be testable without spawning real Claude CLI processes (inject mock process factory)
- **Reliability**: Worker must not leave orphaned labels — use try/finally for cleanup

## Success Criteria

- [ ] Spawns Claude CLI with correct arguments and Agency tools
- [ ] Manages `phase:*` and `completed:*` labels through phase transitions
- [ ] Stops cleanly on `waiting-for:*` labels
- [ ] Posts and updates stage comments
- [ ] Captures conversation output for streaming to dashboard
- [ ] Error handling with `agent:error` label and error comment
- [ ] Heartbeat sent at regular intervals (via dispatcher integration)
- [ ] `continue` command resumes from correct phase

## Out of Scope

- PR feedback monitor (separate issue in epic #195)
- Dashboard UI for worker monitoring (separate issue)
- Multi-repository workspace management (workers use single-repo checkout)
- Claude CLI installation or version management (assumes `claude` is on PATH)
- MCP tool server lifecycle management (assumes tools are configured globally)
- Horizontal scaling of the dispatcher itself (single-instance for now)

---

*Generated by speckit*

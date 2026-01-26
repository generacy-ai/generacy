# Feature Specification: Implement orchestrator server command for generacy CLI

**Branch**: `159-implement-orchestrator-server-command` | **Date**: 2026-01-26 | **Status**: Draft

## Summary

The generacy CLI currently has `worker`, `agent`, and `run` commands, but is missing the `orchestrator` command needed to run the orchestrator server that workers connect to.

## Current State

- `OrchestratorClient` exists for workers to communicate with an orchestrator
- `HeartbeatManager` and `JobHandler` are implemented for the worker side
- REST API contract is defined in `src/orchestrator/types.ts`
- No server implementation exists

## Architecture Decision

Create a **new separate server implementation** in `packages/generacy/src/orchestrator/server.ts` focused only on worker coordination. This keeps concerns separated from the cloud workflow management in `packages/orchestrator/`.

## Required Implementation

Create a `generacy orchestrator` command that:

1. **Starts an HTTP server** with the following endpoints (all prefixed with `/api`):
   - `POST /api/workers/register` - Worker registration
   - `DELETE /api/workers/:id` - Worker unregistration
   - `POST /api/workers/:id/heartbeat` - Heartbeat from workers
   - `GET /api/workers/:id/poll` - Job polling for workers
   - `POST /api/jobs/:id/result` - Job result reporting
   - `GET /api/health` - Health check endpoint

2. **Manages job queue** with optional Redis:
   - Use Redis when `--redis-url` is provided
   - Fall back to in-memory queue when Redis unavailable (with warning log)
   - Store pending jobs, assign to workers, track status and results

3. **Handles worker lifecycle**:
   - Track registered workers
   - Monitor heartbeats
   - Handle worker failures/timeouts

4. **Authentication** (optional):
   - Unauthenticated by default for internal/trusted network usage
   - Optionally honor `ORCHESTRATOR_TOKEN` if provided for environments that need authentication

## CLI Options

```
generacy orchestrator [options]

Options:
  -p, --port <port>           HTTP server port (default: 3100)
  -r, --redis-url <url>       Redis connection URL (optional, uses in-memory if not provided)
  --health-port <port>        Health check port (default: 3101)
  --worker-timeout <ms>       Worker heartbeat timeout (default: 60000)
```

## Files to Create/Modify

- `packages/generacy/src/cli/commands/orchestrator.ts` - New CLI command
- `packages/generacy/src/orchestrator/server.ts` - HTTP server implementation
- `packages/generacy/src/orchestrator/job-queue.ts` - Job queue with Redis/in-memory backends
- `packages/generacy/src/orchestrator/worker-registry.ts` - Worker tracking
- `packages/generacy/src/cli/index.ts` - Register new command

## Context

This is needed for the devcontainer integration in triad-development. The entrypoint scripts (`entrypoint-generacy-orchestrator.sh`) expect this command to exist.

Related: triad-development commit a3c8a75 added devcontainer integration that depends on this.

## User Stories

### US1: Start Orchestrator Server

**As a** developer running the devcontainer,
**I want** to start the orchestrator with `generacy orchestrator`,
**So that** workers can connect and receive jobs.

**Acceptance Criteria**:
- [ ] `generacy orchestrator` starts HTTP server on default port 3100
- [ ] Server logs startup message with port and Redis/in-memory mode
- [ ] Health endpoint responds at `/api/health`

### US2: Worker Registration

**As a** worker process,
**I want** to register with the orchestrator,
**So that** I can receive jobs to execute.

**Acceptance Criteria**:
- [ ] `POST /api/workers/register` accepts worker capabilities
- [ ] Returns worker ID and registration confirmation
- [ ] Worker appears in registry

### US3: Job Distribution

**As a** worker,
**I want** to poll for available jobs,
**So that** I can execute work when available.

**Acceptance Criteria**:
- [ ] `GET /api/workers/:id/poll` returns pending job or empty response
- [ ] Jobs are assigned exclusively to one worker
- [ ] Worker can report job results via `POST /api/jobs/:id/result`

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Server starts on configurable port | P1 | Default 3100 |
| FR-002 | API routes use `/api` prefix | P1 | Match existing client |
| FR-003 | In-memory fallback when no Redis | P1 | Log warning |
| FR-004 | Worker heartbeat tracking | P1 | Timeout configurable |
| FR-005 | Optional token authentication | P2 | Honor ORCHESTRATOR_TOKEN if set |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Server startup | < 1s | Time from command to ready |
| SC-002 | Worker registration | Works | Integration test passes |
| SC-003 | Job polling | Works | Integration test passes |

## Assumptions

- The existing `OrchestratorClient` API contract is correct and should be matched
- Devcontainer environment may not have Redis available
- Workers and orchestrator run on trusted internal network

## Out of Scope

- Cloud orchestrator features (workflows, GitHub OAuth, SSE)
- Persistent job storage beyond Redis
- Multi-orchestrator coordination
- Worker authentication enforcement (optional only)

---

*Generated by speckit*

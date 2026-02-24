# T016: Migrate contracts/orchestration/ to latency - COMPLETE

## Task Description
Migrate all TypeScript files and tests from contracts/orchestration/ to latency/packages/latency/src/orchestration/

## Files Migrated

### Source Files (5 files)
- ✅ `work-item.ts` - WorkItem schemas, types, and constants
- ✅ `agent-info.ts` - AgentInfo schemas and agent status
- ✅ `events.ts` - Orchestration event schemas (work and agent events)
- ✅ `status.ts` - OrchestratorStatus schema
- ✅ `index.ts` - Barrel export file

### Test Files (4 files)
- ✅ `__tests__/work-item.test.ts` - WorkItem schema tests
- ✅ `__tests__/agent-info.test.ts` - AgentInfo schema tests
- ✅ `__tests__/events.test.ts` - Event schema tests
- ✅ `__tests__/status.test.ts` - Status schema tests

## Source Location
`/workspaces/contracts/src/orchestration/`

## Destination Location
`/workspaces/latency/packages/latency/src/orchestration/`

## Import Dependencies
The orchestration files depend on common types:
- `WorkItemIdSchema`, `AgentIdSchema` from `../common/ids.js`
- `ISOTimestampSchema` from `../common/timestamps.js`

These imports will need to be updated in T017 (next task).

## File Summary

### work-item.ts
Defines WorkItem schema with:
- WorkItemType enum (github-issue, task, review)
- WorkItemStatus enum (pending, claimed, in-progress, completed, failed)
- WorkItemSchema with id, type, priority, status, payload, assignedAgent, timestamps
- Parse and safeParse helpers

### agent-info.ts
Defines AgentInfo schema with:
- AgentStatus enum (available, busy, offline)
- AgentInfoSchema with id, status, capabilities, currentWork, lastHeartbeat, metadata
- Parse and safeParse helpers

### events.ts
Defines orchestration events:
- Work events: queued, claimed, completed, failed, reassigned, progress
- Agent events: registered, heartbeat, offline, deregistered
- Discriminated union schema for all event types
- Parse and safeParse helpers

### status.ts
Defines OrchestratorStatus schema:
- queueDepth: number of items in queue
- activeAgents: number of active agents
- workInProgress: number of items being processed
- completedToday: number of completed items today
- Parse and safeParse helpers

## Next Steps
- **T017**: Fix imports in latency/orchestration/ (update from contracts/common to ../common)
- **T018**: Create/verify latency/orchestration/index.ts for proper exports

## Verification
```bash
# Verify files exist
ls -la /workspaces/latency/packages/latency/src/orchestration/

# Count files (should be 5 .ts + 1 README + 1 __tests__ dir)
find /workspaces/latency/packages/latency/src/orchestration -maxdepth 1 -name "*.ts" | wc -l

# Count test files (should be 4)
find /workspaces/latency/packages/latency/src/orchestration/__tests__ -name "*.test.ts" | wc -l
```

## Status
✅ **COMPLETE** - All files successfully copied to destination

## Date
2026-02-24

## Notes
- All files copied verbatim from contracts repo
- No modifications made to imports yet (pending T017)
- Test coverage maintained (all test files migrated)
- README.md already exists in destination directory

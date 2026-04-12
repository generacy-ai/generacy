# Implementation Plan: Migrate pr-feedback-handler to AgentLauncher

**Feature**: Route PR feedback Claude invocations through `AgentLauncher` + `ClaudeCodeLaunchPlugin`
**Branch**: `432-goal-phase-3b-spawn`
**Status**: Complete

## Summary

Replace the direct `processFactory.spawn('claude', ...)` call in `PrFeedbackHandler` (line 305) with `agentLauncher.launch()` using `intent.kind = "pr-feedback"`. The `ClaudeCodeLaunchPlugin` already builds byte-identical argv for this intent. This is a focused wiring change: inject `AgentLauncher` into `PrFeedbackHandler`, swap the spawn call, and extract `LaunchHandle.process` for downstream stdout/stderr/signal handling.

## Technical Context

**Language/Version**: TypeScript 5.x (Node.js)
**Primary Dependencies**: `AgentLauncher`, `ClaudeCodeLaunchPlugin`, `ProcessFactory`
**Storage**: N/A
**Testing**: Vitest — existing PR feedback handler tests + Wave 1 snapshot harness
**Target Platform**: Node.js server (orchestrator worker)
**Project Type**: Monorepo package (`packages/orchestrator`)
**Constraints**: Zero-regression — byte-identical spawn argv, identical stream-json output shape

## Constitution Check

No constitution file found — no gates to enforce.

## Project Structure

### Documentation (this feature)

```text
specs/432-goal-phase-3b-spawn/
├── plan.md              # This file
├── research.md          # Migration pattern analysis
├── data-model.md        # Key interfaces and types
├── quickstart.md        # Testing guide
├── contracts/           # (empty — no new API contracts)
└── checklists/          # (empty — populated by /speckit:checklist)
```

### Source Code (files to modify)

```text
packages/orchestrator/src/worker/
├── pr-feedback-handler.ts          # PRIMARY: swap spawn → agentLauncher.launch()
├── claude-cli-worker.ts            # Inject agentLauncher into PrFeedbackHandler
└── __tests__/
    └── pr-feedback-handler.test.ts # Update constructor calls, add snapshot test
```

### Key Dependencies (read-only reference)

```text
packages/orchestrator/src/launcher/
└── agent-launcher.ts               # AgentLauncher class (launch method, 3-layer env merge)

packages/generacy-plugin-claude-code/src/launch/
├── claude-code-launch-plugin.ts    # buildPrFeedbackLaunch() — already implements pr-feedback
└── types.ts                        # PrFeedbackIntent interface

packages/orchestrator/src/test-utils/
├── recording-process-factory.ts    # RecordingProcessFactory for snapshot validation
└── spawn-snapshot.ts               # normalizeSpawnRecords utility
```

## Implementation Approach

### Step 1: Add AgentLauncher to PrFeedbackHandler constructor

**File**: `pr-feedback-handler.ts`

- Add optional `agentLauncher?: AgentLauncher` parameter to constructor (after `processFactory`)
- Store as `private readonly agentLauncher?: AgentLauncher`
- Follows the dual-path pattern established in #429 (SubprocessAgency)

### Step 2: Replace spawn call with agentLauncher.launch()

**File**: `pr-feedback-handler.ts` (around line 305)

Replace:
```typescript
child = this.processFactory.spawn('claude', args, {
  cwd: checkoutPath,
  env: {} as Record<string, string>,
});
```

With:
```typescript
if (this.agentLauncher) {
  const handle = this.agentLauncher.launch({
    intent: {
      kind: 'pr-feedback',
      prNumber: prNumber,
      prompt: prompt,
    } as PrFeedbackIntent,
    cwd: checkoutPath,
    env: {},
  });
  child = handle.process;
} else {
  child = this.processFactory.spawn('claude', args, {
    cwd: checkoutPath,
    env: {} as Record<string, string>,
  });
}
```

Key notes:
- `handle.process` returns `ChildProcessHandle` — identical interface to what `processFactory.spawn()` returns
- All downstream code (stdout capture, stderr buffering, timeout/signal handling) works unchanged
- The argv construction moves into `ClaudeCodeLaunchPlugin.buildPrFeedbackLaunch()` which builds the identical array
- Empty `env: {}` caller env means AgentLauncher's 3-layer merge uses process.env + plugin env only
- The `prompt` is passed via `intent.prompt` instead of being in the args array directly

### Step 3: Wire AgentLauncher in ClaudeCliWorker

**File**: `claude-cli-worker.ts` (around line 213-218)

Pass the existing `this.agentLauncher` when constructing `PrFeedbackHandler`:
```typescript
const prFeedbackHandler = new PrFeedbackHandler(
  this.config,
  workerLogger,
  this.processFactory,
  this.sseEmitter,
  this.agentLauncher,  // NEW: inject launcher
);
```

`ClaudeCliWorker` already creates and configures an `AgentLauncher` with `ClaudeCodeLaunchPlugin` registered (lines 98-145), so no new setup is needed.

### Step 4: Update tests

**File**: `pr-feedback-handler.test.ts`

1. Update existing constructor calls to pass `undefined` for the new agentLauncher param (backward compat)
2. Add a test that constructs PrFeedbackHandler with an AgentLauncher and verifies:
   - `agentLauncher.launch()` is called with correct intent
   - `handle.process` is used for downstream operations
3. Add a snapshot test using `RecordingProcessFactory` to validate spawn-arg parity between direct and launcher paths

### Step 5: Validate with snapshot harness

Use `RecordingProcessFactory` + `normalizeSpawnRecords()` to capture both paths and assert identical spawn records. This satisfies SC-001 (byte-identical spawn composition).

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Env merge semantics change (3-layer vs empty obj) | Caller passes `env: {}` so only process.env layer added — test with snapshot |
| Signal handling regression | `LaunchHandle.process` exposes same `ChildProcessHandle` interface — SIGTERM/SIGKILL code unchanged |
| Stream-json output differs | Plugin builds identical argv; OutputParser is no-op pass-through |
| Test constructor breakage | AgentLauncher param is optional — existing tests pass without changes |

## Complexity Tracking

No constitution violations — this is a straightforward wiring change with no new abstractions, patterns, or dependencies introduced.

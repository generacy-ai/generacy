# Research: Migrate pr-feedback-handler to AgentLauncher

**Feature**: #432 — Phase 3b Spawn Refactor
**Date**: 2026-04-12

## Technology Decisions

### Decision 1: Dual-path pattern (launcher + fallback)

**Choice**: Optional `AgentLauncher` with fallback to direct `processFactory.spawn()`

**Rationale**: This is the established pattern from #429 (SubprocessAgency migration). It provides:
- Backward compatibility — existing tests pass without modification
- Gradual rollout — can be feature-flagged if needed
- Clear migration path — fallback removed in Wave 3 Cleanup

**Alternatives considered**:
- **Hard switch (no fallback)**: Simpler code but forces all call sites to provide AgentLauncher. Rejected because it would break existing test setup and doesn't match the pattern established by sibling issues.
- **Adapter/wrapper pattern**: Wrap ProcessFactory behind AgentLauncher interface. Over-engineered for a migration that will have the fallback removed in cleanup.

### Decision 2: Use LaunchHandle.process directly

**Choice**: Extract `handle.process` (ChildProcessHandle) and use it in existing downstream code.

**Rationale**: The `ChildProcessHandle` interface is identical whether it comes from `processFactory.spawn()` or `LaunchHandle.process`. This means all downstream code (stdout capture via OutputCapture, stderr buffering, SIGTERM/SIGKILL timeout handling) works without modification.

**Alternatives considered**:
- **Use OutputParser for stdout**: The `ClaudeCodeLaunchPlugin` returns a no-op OutputParser. Could have used it to process chunks, but the existing `OutputCapture` pattern in PrFeedbackHandler is well-tested and there's no benefit to changing it.

### Decision 3: Pass prompt via intent, not args

**Choice**: The `PrFeedbackIntent` type carries the `prompt` field, and `ClaudeCodeLaunchPlugin.buildPrFeedbackLaunch()` appends it to argv.

**Rationale**: This is how the plugin is already implemented. The handler constructs the prompt as before, but passes it as `intent.prompt` instead of directly in the args array. The plugin produces the identical argv.

## Implementation Patterns

### Pattern: AgentLauncher migration (from #429)

```typescript
// Constructor: optional AgentLauncher
constructor(
  private readonly config: Config,
  private readonly logger: Logger,
  private readonly processFactory: ProcessFactory,
  private readonly agentLauncher?: AgentLauncher,
) {}

// Usage: dual-path spawn
if (this.agentLauncher) {
  const handle = this.agentLauncher.launch({
    intent: { kind: 'pr-feedback', prNumber, prompt },
    cwd: checkoutPath,
    env: {},
  });
  child = handle.process;
} else {
  child = this.processFactory.spawn('claude', args, { cwd, env: {} });
}

// Downstream: identical regardless of path
child.stdout.on('data', (chunk) => outputCapture.write(chunk));
```

### Pattern: Snapshot validation (from #427)

```typescript
const factory = new RecordingProcessFactory();
const launcher = new AgentLauncher(new Map([['default', factory]]));
launcher.registerPlugin(new ClaudeCodeLaunchPlugin());

// Exercise the launch path
launcher.launch({ intent: { kind: 'pr-feedback', ... }, cwd, env: {} });

// Validate against known-good snapshot
expect(normalizeSpawnRecords(factory.calls)).toMatchSnapshot();
```

## Key Sources

- Spawn refactor plan: `tetrad-development/docs/spawn-refactor-plan.md`
- AgentLauncher: `packages/orchestrator/src/launcher/agent-launcher.ts`
- ClaudeCodeLaunchPlugin: `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts`
- SubprocessAgency migration (#429): `packages/generacy/src/agency/subprocess.ts`
- Snapshot harness (#427): `packages/orchestrator/src/test-utils/recording-process-factory.ts`

# Clarifications for #438: End-to-End Spawn Path Integration Test

## Batch 1 — 2026-04-12

### Q1: Real ProcessFactory Implementation
**Context**: The spec requires tests to use "real `AgentLauncher` with real plugins (not mocked `ProcessFactory`)" and "Real `child_process.spawn`". However, the only `ProcessFactory` implementation found in the codebase is `RecordingProcessFactory` (a test utility that records calls but doesn't spawn real processes). The `AgentLauncher` constructor requires `Map<string, ProcessFactory>`.
**Question**: Is there an existing production `ProcessFactory` implementation that wraps `child_process.spawn`, or should the integration test create a minimal real implementation (e.g., a `RealProcessFactory` that delegates to `child_process.spawn`)?
**Options**:
- A: There is an existing real `ProcessFactory` (please point to it)
- B: The integration test should create a simple `ProcessFactory` wrapper around `child_process.spawn` as test infrastructure
- C: A production `ProcessFactory` should be created as part of this work (new source file, not just test infra)

**Answer**: *Pending*

### Q2: conversation-turn PTY Round-Trip Scope
**Context**: FR-004 requires testing the `conversation-turn` intent which spawns through `python3 -u -c <PTY_WRAPPER>`. The PTY_WRAPPER uses `pty.spawn(sys.argv[1:], read)`, meaning the mock binary runs inside a real PTY session. Testing a full stdin→PTY→mock→PTY→stdout round-trip is significantly more complex than just verifying the mock binary received correct argv/env (which only requires reading the capture file).
**Question**: Should the conversation-turn test verify the full PTY stdin/stdout round-trip (write data to the child process stdin, read transformed output from stdout), or is it sufficient to verify the mock binary receives correct argv and env via the capture file?
**Options**:
- A: Full PTY round-trip — write stdin, verify stdout comes back correctly through the PTY
- B: Capture-file only — verify argv/env reach the mock binary correctly through the PTY wrapper, don't test stdin/stdout data flow
- C: Both — verify capture file for argv/env AND do a minimal stdin/stdout echo test

**Answer**: *Pending*

### Q3: Test File Location
**Context**: The spec says tests go "under `packages/orchestrator/src/launcher/__tests__/` (or a new `tests/integration/spawn/` directory)". The test needs imports from both `packages/orchestrator` (AgentLauncher, GenericSubprocessPlugin) and `packages/generacy-plugin-claude-code` (ClaudeCodeLaunchPlugin). The existing `claude-code-launch-plugin-integration.test.ts` already lives in the orchestrator package and imports from the claude-code plugin. A root `tests/integration/routing.test.ts` also exists.
**Question**: Where should the integration test file live?
**Options**:
- A: `packages/orchestrator/src/launcher/__tests__/` (co-located with existing launcher tests, follows existing cross-package import pattern)
- B: Root `tests/integration/spawn/` directory (separate from unit tests, but needs its own vitest config or the root config to include it)
- C: New `packages/orchestrator/tests/integration/spawn/` directory (within orchestrator package, already covered by orchestrator vitest config's `tests/**/*.test.ts` glob)

**Answer**: *Pending*

### Q4: Mock Binary stdout Fidelity
**Context**: For `phase` and `pr-feedback` intents, the launcher spawns `claude` with `--output-format stream-json`. Downstream code may expect to parse stream-json lines from stdout. The mock binary needs to write *something* to stdout, but the spec's mock binary design section says it "writes expected stdout (e.g., stream-json lines)" without specifying the fidelity level. Since output parsing is a no-op in current plugins (`processChunk: () => {}`, `flush: () => {}`), high-fidelity mock output may be unnecessary.
**Question**: Should the mock binary emit valid stream-json formatted output (e.g., `{"type":"result","result":"..."}` lines), or is it sufficient for the mock to write a simple marker string to stdout and only verify argv/env via the capture file?
**Options**:
- A: Emit realistic stream-json lines (future-proofs tests for when output parsing is implemented)
- B: Simple marker string on stdout (e.g., `"mock-output"`) — keeps mock binary minimal
- C: Configurable — mock reads a "response file" path from env and echoes its contents to stdout

**Answer**: *Pending*

### Q5: PATH Override vs. Config Injection for Mock Binary
**Context**: The spec says "Tests override `PATH` or use absolute path to route `claude` invocations to the mock." For intents that spawn `claude` (phase, pr-feedback, invoke), the `ClaudeCodeLaunchPlugin.buildLaunch()` hardcodes `command: 'claude'` in the returned LaunchSpec. For `conversation-turn`, the command is `python3` and `claude` args are passed via `sys.argv[1:]` to `pty.spawn()`. Overriding PATH is the simplest approach but affects all child processes. Using an absolute path would require the plugin to accept a configurable binary path.
**Question**: Should the tests override the PATH environment variable to place the mock binary directory first, or should the `ClaudeCodeLaunchPlugin` be modified to accept a configurable claude binary path?
**Options**:
- A: Override PATH in the test's env — simplest, no production code changes needed
- B: Add a `claudeBinaryPath` option to `ClaudeCodeLaunchPlugin` constructor — cleaner but changes production code for testability
- C: Override PATH for the test process AND pass mock path via env var that the mock reads (belt and suspenders)

**Answer**: *Pending*

# Clarifications for #438: End-to-End Spawn Path Integration Test

## Batch 1 — 2026-04-12

### Q1: Real ProcessFactory Implementation
**Context**: The spec requires tests to use "real `AgentLauncher` with real plugins (not mocked `ProcessFactory`)" and "Real `child_process.spawn`". However, the only `ProcessFactory` implementation found in the codebase is `RecordingProcessFactory` (a test utility that records calls but doesn't spawn real processes). The `AgentLauncher` constructor requires `Map<string, ProcessFactory>`.
**Question**: Is there an existing production `ProcessFactory` implementation that wraps `child_process.spawn`, or should the integration test create a minimal real implementation (e.g., a `RealProcessFactory` that delegates to `child_process.spawn`)?
**Options**:
- A: There is an existing real `ProcessFactory` (please point to it)
- B: The integration test should create a simple `ProcessFactory` wrapper around `child_process.spawn` as test infrastructure
- C: A production `ProcessFactory` should be created as part of this work (new source file, not just test infra)

**Answer**: A — Real ProcessFactory implementations already exist

Two production `ProcessFactory` implementations exist in the codebase:

1. **`defaultProcessFactory`** at [packages/orchestrator/src/worker/claude-cli-worker.ts:25-54](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/worker/claude-cli-worker.ts#L25-L54) — uses `stdio: ['ignore', 'pipe', 'pipe']`, merges `process.env`
2. **`conversationProcessFactory`** at [packages/orchestrator/src/conversation/process-factory.ts:10-40](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/conversation/process-factory.ts#L10-L40) — uses `stdio: ['pipe', 'pipe', 'pipe']`, merges `process.env`

Both are inline `const` objects (not classes), which is likely why the scan missed them. They wrap `child_process.spawn` and return `ChildProcessHandle`.

The integration test should use these directly:
```typescript
const factories = new Map<string, ProcessFactory>([
  ["default", defaultProcessFactory],
  ["interactive", conversationProcessFactory],
]);
const launcher = new AgentLauncher(factories, plugins);
```

No new `ProcessFactory` implementation needed — these are the production ones.

### Q2: conversation-turn PTY Round-Trip Scope
**Context**: FR-004 requires testing the `conversation-turn` intent which spawns through `python3 -u -c <PTY_WRAPPER>`. The PTY_WRAPPER uses `pty.spawn(sys.argv[1:], read)`, meaning the mock binary runs inside a real PTY session. Testing a full stdin→PTY→mock→PTY→stdout round-trip is significantly more complex than just verifying the mock binary received correct argv/env (which only requires reading the capture file).
**Question**: Should the conversation-turn test verify the full PTY stdin/stdout round-trip (write data to the child process stdin, read transformed output from stdout), or is it sufficient to verify the mock binary receives correct argv and env via the capture file?
**Options**:
- A: Full PTY round-trip — write stdin, verify stdout comes back correctly through the PTY
- B: Capture-file only — verify argv/env reach the mock binary correctly through the PTY wrapper, don't test stdin/stdout data flow
- C: Both — verify capture file for argv/env AND do a minimal stdin/stdout echo test

**Answer**: B — Capture-file only for conversation-turn

The integration test's job is to verify that the correct `argv` and `env` reach the mock binary through the PTY wrapper. That's what the capture file proves.

A full stdin→PTY→mock→PTY→stdout round-trip test would:
- Test the Python `pty` module more than the launcher
- Be fragile across platforms (PTY buffering, line discipline, terminal escape sequences)
- Add significant complexity for little additional confidence about the *spawn refactor* specifically

If PTY data flow needs testing, that's a separate PTY-specific test concern, not a spawn-path integration test. The capture file verifies: "did `python3 -u -c <PTY_WRAPPER> claude -p <message> --output-format stream-json --verbose --resume <sessionId>` get composed correctly and reach the binary?" — which is exactly what this test is for.

### Q3: Test File Location
**Context**: The spec says tests go "under `packages/orchestrator/src/launcher/__tests__/` (or a new `tests/integration/spawn/` directory)". The test needs imports from both `packages/orchestrator` (AgentLauncher, GenericSubprocessPlugin) and `packages/generacy-plugin-claude-code` (ClaudeCodeLaunchPlugin). The existing `claude-code-launch-plugin-integration.test.ts` already lives in the orchestrator package and imports from the claude-code plugin. A root `tests/integration/routing.test.ts` also exists.
**Question**: Where should the integration test file live?
**Options**:
- A: `packages/orchestrator/src/launcher/__tests__/` (co-located with existing launcher tests, follows existing cross-package import pattern)
- B: Root `tests/integration/spawn/` directory (separate from unit tests, but needs its own vitest config or the root config to include it)
- C: New `packages/orchestrator/tests/integration/spawn/` directory (within orchestrator package, already covered by orchestrator vitest config's `tests/**/*.test.ts` glob)

**Answer**: A — `packages/orchestrator/src/launcher/__tests__/`

The test imports from both `@generacy-ai/orchestrator` (AgentLauncher, GenericSubprocessPlugin, ProcessFactory instances) and `@generacy-ai/generacy-plugin-claude-code` (ClaudeCodeLaunchPlugin). The existing `claude-code-launch-plugin-integration.test.ts` already lives in the orchestrator package and imports from the claude-code plugin — this follows the same pattern.

Co-locating with the launcher tests keeps related tests discoverable and covered by the orchestrator's existing vitest config. The root `tests/integration/` directory (option B) would need its own vitest config, and option C creates a new directory structure without precedent.

### Q4: Mock Binary stdout Fidelity
**Context**: For `phase` and `pr-feedback` intents, the launcher spawns `claude` with `--output-format stream-json`. Downstream code may expect to parse stream-json lines from stdout. The mock binary needs to write *something* to stdout, but the spec's mock binary design section says it "writes expected stdout (e.g., stream-json lines)" without specifying the fidelity level. Since output parsing is a no-op in current plugins (`processChunk: () => {}`, `flush: () => {}`), high-fidelity mock output may be unnecessary.
**Question**: Should the mock binary emit valid stream-json formatted output (e.g., `{"type":"result","result":"..."}` lines), or is it sufficient for the mock to write a simple marker string to stdout and only verify argv/env via the capture file?
**Options**:
- A: Emit realistic stream-json lines (future-proofs tests for when output parsing is implemented)
- B: Simple marker string on stdout (e.g., `"mock-output"`) — keeps mock binary minimal
- C: Configurable — mock reads a "response file" path from env and echoes its contents to stdout

**Answer**: C — Configurable via response file

The mock binary reads a response-file path from an env var (e.g. `MOCK_CLAUDE_RESPONSE_FILE`) and echoes its contents to stdout. If the env var is unset, it writes a simple marker string (e.g. `{"type":"result","subtype":"success"}\n`).

This gives each test control over what stdout to emit without modifying the mock binary. Benefits:
- Phase and pr-feedback tests can point at a valid stream-json fixture file when output parsing is implemented
- Conversation-turn tests can use a simpler response
- The mock binary stays a single file that doesn't need per-intent logic
- Default marker is enough for current tests where parsers are no-ops

### Q5: PATH Override vs. Config Injection for Mock Binary
**Context**: The spec says "Tests override `PATH` or use absolute path to route `claude` invocations to the mock." For intents that spawn `claude` (phase, pr-feedback, invoke), the `ClaudeCodeLaunchPlugin.buildLaunch()` hardcodes `command: 'claude'` in the returned LaunchSpec. For `conversation-turn`, the command is `python3` and `claude` args are passed via `sys.argv[1:]` to `pty.spawn()`. Overriding PATH is the simplest approach but affects all child processes. Using an absolute path would require the plugin to accept a configurable binary path.
**Question**: Should the tests override the PATH environment variable to place the mock binary directory first, or should the `ClaudeCodeLaunchPlugin` be modified to accept a configurable claude binary path?
**Options**:
- A: Override PATH in the test's env — simplest, no production code changes needed
- B: Add a `claudeBinaryPath` option to `ClaudeCodeLaunchPlugin` constructor — cleaner but changes production code for testability
- C: Override PATH for the test process AND pass mock path via env var that the mock reads (belt and suspenders)

**Answer**: A — Override PATH in the test's env

Create a temp directory with a `claude` executable (the mock binary script), prepend it to `PATH` in the test's env, and pass the modified env through `LaunchRequest.env`. This is standard practice for CLI integration tests.

The mock binary is a Node script (or shell script with `#!/bin/sh`) that:
1. Writes its argv and env to a capture file (path from `MOCK_CLAUDE_CAPTURE_FILE` env var)
2. Reads and echoes the response file if `MOCK_CLAUDE_RESPONSE_FILE` is set
3. Exits 0

No production code changes needed. `ClaudeCodeLaunchPlugin.buildLaunch()` continues to return `command: "claude"` — the PATH override routes it to the mock transparently. This also works for conversation-turn because the PTY wrapper receives `claude` in `sys.argv[1:]` and the PATH applies inside the PTY child process.

Option B (configurable binary path) changes production code for testability, which violates the "structural refactor, no behavior changes" principle.

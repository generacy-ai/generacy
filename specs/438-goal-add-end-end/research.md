# Research: End-to-End Spawn Path Integration Test

## Technology Decisions

### Mock Binary: Shell Script vs Node Script

**Decision**: Use a shell script (`#!/bin/sh`)

**Rationale**:
- Shell scripts have no runtime dependencies beyond `/bin/sh`
- Work correctly inside the PTY wrapper (`python3 -u -c <PTY_WRAPPER>` → `pty.spawn(sys.argv[1:])`) since PATH resolution applies transitively
- Simpler to write — `echo` for stdout, redirect for capture file
- No shebang path portability issues (unlike `#!/usr/bin/env node` which may not exist in all envs)

**Alternative considered**: Node.js script with `process.argv` and `JSON.stringify`. More expressive but introduces a dependency on Node being at a specific path, and shell works fine for writing argv/env to a file.

### PATH Override vs Plugin Configuration

**Decision**: Override `PATH` in `request.env`

**Rationale**:
- `ClaudeCodeLaunchPlugin.buildLaunch()` hardcodes `command: 'claude'` — PATH resolution is the standard mechanism
- No production code changes needed for testability
- Works for all intent kinds including `conversation-turn` where `pty.spawn(sys.argv[1:])` resolves `claude` via PATH
- Standard integration testing practice for CLI tools

**Alternative considered**: Adding `claudeBinaryPath` option to `ClaudeCodeLaunchPlugin` constructor. Rejected because it modifies production code purely for test convenience.

### Capture File Format

**Decision**: Line-delimited text with sections

```
=== ARGV ===
arg0
arg1
arg2
=== ENV ===
KEY1=value1
KEY2=value2
```

**Rationale**:
- Human-readable for debugging failed tests
- Easy to parse with `fs.readFileSync().split('\n')`
- Sections separate argv from env cleanly
- No JSON parsing edge cases with special characters in shell

### Test Assertion Strategy

**Decision**: Parse capture file, assert specific argv entries and env keys

**Rationale**:
- Capture file proves the mock binary received the correct command composition
- More reliable than stdout parsing (which depends on process buffering)
- Env assertions verify the 3-layer merge (process.env ← plugin env ← request.env)
- Exit code verification confirms clean process lifecycle

## Implementation Patterns

### Test Lifecycle

```
beforeAll → create tmpdir, write mock binary, build PATH
beforeEach → delete capture file if exists
test → launch via AgentLauncher, await exitPromise, read capture file, assert
afterAll → rm -rf tmpdir
```

### Real ProcessFactory Usage

The test uses production factories directly:
- `defaultProcessFactory` from `packages/orchestrator/src/worker/claude-cli-worker.ts` — `stdio: ['ignore', 'pipe', 'pipe']`
- `conversationProcessFactory` from `packages/orchestrator/src/conversation/process-factory.ts` — `stdio: ['pipe', 'pipe', 'pipe']`

These are imported and passed to `createAgentLauncher()` (from `launcher-setup.ts`) which handles plugin registration.

### Env Filtering for Assertions

The capture file includes all env vars. Tests should only assert on specific keys they care about (e.g., `MOCK_CLAUDE_CAPTURE_FILE`, `PATH`, custom test keys) rather than snapshot the entire env, since `process.env` contents vary by environment.

## Key Sources

- `AgentLauncher.launch()`: `packages/orchestrator/src/launcher/agent-launcher.ts:47-102`
- `createAgentLauncher()`: `packages/orchestrator/src/launcher/launcher-setup.ts:12-25`
- `ClaudeCodeLaunchPlugin.buildLaunch()`: `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts:39-51`
- `defaultProcessFactory`: `packages/orchestrator/src/worker/claude-cli-worker.ts:29-62`
- `conversationProcessFactory`: `packages/orchestrator/src/conversation/process-factory.ts:10-43`
- `PTY_WRAPPER`: `packages/generacy-plugin-claude-code/src/launch/constants.ts:24-34`
- Existing integration test pattern: `packages/orchestrator/src/launcher/__tests__/claude-code-launch-plugin-integration.test.ts`

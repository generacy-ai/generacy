# Implementation Plan: End-to-End Spawn Path Integration Test

**Feature**: Add an end-to-end integration test covering all spawn intent kinds through `AgentLauncher`
**Branch**: `438-goal-add-end-end`
**Status**: Complete

## Summary

Build an integration test suite that exercises all spawn intent kinds (`phase`, `pr-feedback`, `conversation-turn`, `invoke`, `generic-subprocess`, `shell`) through real `AgentLauncher` with real `ProcessFactory` implementations (`defaultProcessFactory`, `conversationProcessFactory`). A mock `claude` binary captures argv/env to a fixture file, replacing the real CLI for deterministic assertions. Tests verify command composition, env inheritance, stdio profile selection, and PTY wrapper invocation end-to-end.

## Technical Context

- **Language**: TypeScript
- **Framework**: Vitest (test runner), Node.js (mock binary runtime)
- **Key packages**: `@generacy-ai/orchestrator` (AgentLauncher, GenericSubprocessPlugin, ProcessFactory), `@generacy-ai/generacy-plugin-claude-code` (ClaudeCodeLaunchPlugin)
- **Existing patterns**: `claude-code-launch-plugin-integration.test.ts` uses RecordingProcessFactory; this test upgrades to real `child_process.spawn` via production factories

## Project Structure

```
packages/orchestrator/src/launcher/__tests__/
├── agent-launcher.test.ts                          (existing — unit tests)
├── claude-code-launch-plugin-integration.test.ts   (existing — RecordingProcessFactory)
└── spawn-e2e.test.ts                               (NEW — real spawn integration test)

packages/orchestrator/src/launcher/__tests__/fixtures/
└── mock-claude.sh                                  (NEW — mock claude binary)
```

## Implementation Strategy

### Phase 1: Mock Binary

Create `mock-claude.sh` — a shell script placed in a temp directory as `claude` during tests.

**Behavior:**
1. Write argv to `$MOCK_CLAUDE_CAPTURE_FILE` as JSON (one line per arg)
2. Write selected env vars to the same file
3. If `$MOCK_CLAUDE_RESPONSE_FILE` is set and exists, cat its contents to stdout
4. Otherwise, write default marker: `{"type":"result","subtype":"success"}`
5. Exit 0

**Design rationale**: Shell script over Node script — simpler, no shebang path issues, works inside PTY wrapper's `pty.spawn()` since the PATH override applies transitively.

### Phase 2: Test Infrastructure (beforeAll / afterAll)

```
beforeAll:
  1. Create temp directory
  2. Write mock-claude.sh to <tmpdir>/claude, chmod +x
  3. Build modified PATH: <tmpdir>:$PATH
  4. Create capture and response file paths

afterAll:
  1. rm -rf temp directory
```

Each test case:
- Resets the capture file before running
- Launches via real `AgentLauncher` with real factories
- Waits for `exitPromise`
- Reads capture file and asserts argv/env

### Phase 3: Test Cases

#### Test 1: `phase` intent (default stdio profile)
- Intent: `{ kind: 'phase', phase: 'plan', prompt: 'https://github.com/org/repo/issues/1', sessionId: 'sess-123' }`
- Asserts: `claude` receives args `-p --output-format stream-json --dangerously-skip-permissions --verbose --resume sess-123 /plan https://...`
- Asserts: `defaultProcessFactory` used (stdin ignored)

#### Test 2: `pr-feedback` intent (default stdio profile)
- Intent: `{ kind: 'pr-feedback', prNumber: 42, prompt: 'Fix the bug in auth.ts' }`
- Asserts: `claude` receives args `-p --output-format stream-json --dangerously-skip-permissions --verbose Fix the bug...`

#### Test 3: `conversation-turn` intent (interactive stdio profile + PTY)
- Intent: `{ kind: 'conversation-turn', message: 'Hello', skipPermissions: true, model: 'claude-opus-4-6' }`
- Asserts: Mock binary receives `claude -p Hello --output-format stream-json --verbose --dangerously-skip-permissions --model claude-opus-4-6` via PTY wrapper
- Asserts: `conversationProcessFactory` used (stdin piped)
- Note: Requires `python3` available in CI (standard on Ubuntu runners)

#### Test 4: `invoke` intent (default stdio profile)
- Intent: `{ kind: 'invoke', command: '/speckit:specify https://github.com/org/repo/issues/5' }`
- Asserts: `claude --print --dangerously-skip-permissions /speckit:specify https://...`

#### Test 5: `generic-subprocess` intent
- Intent: `{ kind: 'generic-subprocess', command: 'echo', args: ['hello', 'world'] }`
- Asserts: Process spawns and exits cleanly, stdout contains `hello world`

#### Test 6: `shell` intent
- Intent: `{ kind: 'shell', command: 'echo integration-test-marker' }`
- Asserts: Wrapped in `sh -c`, stdout contains `integration-test-marker`

#### Test 7: Env inheritance 3-layer merge
- Passes `request.env` with a test key
- Asserts: Capture file shows merged env (process.env + plugin env + request.env)
- Asserts: Request env wins over process.env for duplicate keys

#### Test 8: Response file configurable stdout
- Sets `MOCK_CLAUDE_RESPONSE_FILE` pointing to a fixture with stream-json lines
- Asserts: Process stdout emits the fixture content

### Phase 4: CI Integration

The test file lives in `packages/orchestrator/src/launcher/__tests__/` which is already included by the orchestrator's vitest config (`src/**/*.test.ts` glob). No CI changes needed — it runs with the existing `pnpm test` pipeline.

**Runtime target**: <30 seconds for the full suite (each test spawns a single short-lived process).

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Mock binary format | Shell script (`#!/bin/sh`) | Simpler than Node, works inside PTY, no runtime dependencies |
| PATH override | Prepend temp dir to `PATH` | No production code changes, works transitively in PTY |
| Test location | `packages/orchestrator/src/launcher/__tests__/` | Follows existing integration test pattern, covered by vitest config |
| PTY round-trip | Capture-file only | Testing Python pty module is out of scope; capture file proves argv correctness |
| Response file | Env var `MOCK_CLAUDE_RESPONSE_FILE` | Gives per-test stdout control without per-intent mock logic |
| Real factories | `defaultProcessFactory` + `conversationProcessFactory` | Tests the actual spawn code path, not mock proxies |

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| PTY wrapper requires `python3` | Test skipped if missing | Guard with `beforeAll` check; Ubuntu CI has python3 preinstalled |
| `conversation-turn` test flaky due to PTY buffering | Intermittent failures | Use capture file (not stdout parsing) for assertions; generous timeout |
| Process env leaks between tests | Non-deterministic assertions | Unique capture file per test; reset between runs |

## Dependencies

- Waves 1-4 must be landed (provides AgentLauncher, plugins, factories)
- `python3` available in test environment (for PTY wrapper)
- No new npm dependencies required

# Feature Specification: End-to-End Spawn Path Integration Test

Add an end-to-end integration test suite covering all spawn intent kinds through `AgentLauncher`.

**Branch**: `438-goal-add-end-end` | **Date**: 2026-04-12 | **Status**: Draft | **Issue**: #438

## Summary

Add an integration test suite that exercises all six `LaunchIntent` kinds end-to-end through `AgentLauncher`, using an argv/env-inspecting mock `claude` binary. This catches regressions in command composition, env inheritance (3-layer merge), stdio wiring, and the PTY wrapper that existing unit and snapshot tests cannot cover because they mock the `ProcessFactory` layer.

## Scope

- Add an integration test suite under `packages/orchestrator/src/launcher/__tests__/` (or a new `tests/integration/spawn/` directory) exercising all intent kinds end-to-end against a mock `claude` binary:
  - `{ kind: "phase" }` — spawns with `-p --output-format stream-json` and the correct `/plan`-style slash command
  - `{ kind: "pr-feedback" }` — spawns with PR-specific prompt and stream-json output format
  - `{ kind: "conversation-turn" }` — spawns through PTY wrapper (`python3 -u -c <PTY_WRAPPER>`), verifies stdin/stdout round-trip
  - `{ kind: "invoke" }` — spawns root-level Claude Code invocation
  - `{ kind: "generic-subprocess" }` — pass-through command execution
  - `{ kind: "shell" }` — `sh -c` wrapped execution
- The mock `claude` binary is a small Node script that echoes its `argv` and selected env vars to a fixture file (JSON), which test assertions compare against golden outputs.
- Test failures produce actionable diffs (argv / env / stdout side-by-side).
- Runs in CI under the existing Vitest test infrastructure (target <30s for the full suite).

## User Stories

### US1: Developer Catches Spawn Regressions Early

**As a** developer working on the orchestrator or Claude Code plugin,
**I want** an integration test suite that exercises all spawn intent kinds end-to-end,
**So that** I catch regressions in command composition, env inheritance, and stdio wiring before they reach production.

**Acceptance Criteria**:
- [ ] All six intent kinds (`phase`, `pr-feedback`, `conversation-turn`, `invoke`, `generic-subprocess`, `shell`) are tested
- [ ] Tests use a real `AgentLauncher` with real plugins (not mocked `ProcessFactory`)
- [ ] Tests verify actual argv, env, and stdio behavior of spawned processes

### US2: CI Provides Clear Regression Signals

**As a** developer reviewing a failing CI build,
**I want** test failures to clearly identify which intent kind regressed and what changed,
**So that** I can quickly pinpoint and fix the issue without debugging the test infrastructure.

**Acceptance Criteria**:
- [ ] Failure output includes the regressing intent kind name
- [ ] Diffs show expected vs. actual argv and env side-by-side
- [ ] Suite runtime stays under 30 seconds

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Mock `claude` binary: Node script that writes `{ argv, env, stdin }` to a temp JSON file | P1 | Must be cross-platform (Node, not shell) |
| FR-002 | Test `phase` intent: verify argv includes `-p --output-format stream-json --dangerously-skip-permissions --verbose` and correct `/plan`-style command | P1 | Use `PHASE_TO_COMMAND` map as source of truth |
| FR-003 | Test `pr-feedback` intent: verify argv includes PR number and prompt in correct position | P1 | |
| FR-004 | Test `conversation-turn` intent: verify PTY wrapper invocation (`python3 -u -c`), stdin write, stdout read | P1 | Requires `python3` in CI |
| FR-005 | Test `invoke` intent: verify root-level invocation argv | P2 | |
| FR-006 | Test `generic-subprocess` intent: verify pass-through of command and args | P1 | |
| FR-007 | Test `shell` intent: verify `sh -c` wrapping | P1 | |
| FR-008 | Test 3-layer env merge: process.env < plugin env < caller env | P1 | Verify caller env wins on conflicts |
| FR-009 | Test `stdioProfile` selection: `'default'` vs `'interactive'` routes to correct factory | P2 | |
| FR-010 | Golden output comparison with snapshot or fixture files | P2 | Use Vitest snapshots or JSON fixture files |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Intent kind coverage | 6/6 kinds tested | Count of distinct intent kinds in test suite |
| SC-002 | CI suite runtime | <30 seconds | Vitest timing output |
| SC-003 | Failure diagnostics | Clear intent-kind + diff in output | Manual review of deliberately broken test |
| SC-004 | Suite passes on develop | Green after Waves 1-5 merged | CI pipeline status |

## Technical Context

### Key Components Under Test

- **AgentLauncher** (`packages/orchestrator/src/launcher/agent-launcher.ts`): Plugin registry + env merge + factory dispatch
- **GenericSubprocessPlugin** (`packages/orchestrator/src/launcher/generic-subprocess-plugin.ts`): Handles `generic-subprocess` and `shell` intents
- **ClaudeCodeLaunchPlugin** (`packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts`): Handles `phase`, `pr-feedback`, `conversation-turn`, `invoke` intents
- **ProcessFactory implementations**: Real `child_process.spawn` (not `RecordingProcessFactory`)
- **PTY Wrapper** (`packages/generacy-plugin-claude-code/src/launch/constants.ts`): Python3 `pty.spawn()` wrapper for interactive stdio

### Existing Test Infrastructure

- **Framework**: Vitest 3.2.4
- **Existing unit tests**: Mock `ProcessFactory` via `RecordingProcessFactory` — validates LaunchSpec but not actual process behavior
- **Existing snapshot tests**: Verify argv composition stability — but don't run real processes
- **Gap**: No tests that actually spawn processes and verify end-to-end behavior through the full stack

### Mock Binary Design

The mock `claude` binary replaces the real `claude` CLI:
1. Receives argv and env from the launcher
2. Writes a JSON capture file: `{ argv: process.argv, env: { selected keys }, stdin: <buffered stdin> }`
3. Writes expected stdout (e.g., stream-json lines for `phase`/`pr-feedback`)
4. Exits with configurable exit code

Tests override `PATH` or use absolute path to route `claude` invocations to the mock.

## Assumptions

- `python3` is available in the CI environment (required for PTY wrapper tests)
- Waves 1-5 have all landed on `develop` before this suite is expected to pass
- The mock binary approach is sufficient — no need for the real Claude CLI

## Dependencies

- Waves 1-5 (#425, #428, #429, #430, #431, #432, #433, #434, #435, #436) all landed
- Parallel-safe with Wave 5 Lint issue (#426)

## Out of Scope

- Running against the real Claude CLI binary (operational smoke test, handled in `tetrad-development`)
- Stress or performance testing
- Testing network/API behavior of Claude CLI
- Modifying existing unit or snapshot tests

## References

- Parent tracking: #423
- Phase 1 (Foundation): #425
- Phase 2 (Claude Plugin): #428
- Phase 5 (Root Consolidation): #436

---

*Generated by speckit*

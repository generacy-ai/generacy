# Feature Specification: Phase 5 — Consolidate root-level claude-code-invoker

**Branch**: `436-goal-phase-5-spawn` | **Date**: 2026-04-12 | **Status**: Draft

## Summary

Consolidate the root-level `src/agents/claude-code-invoker.ts` — a parallel Claude spawn path that bypasses `ProcessFactory` — onto `AgentLauncher` + `ClaudeCodeLaunchPlugin`. The `AgentInvoker` interface is retained as a thin adapter over `AgentLauncher`, preserving the root-worker surface contract.

## Goal

Phase 5 of the [spawn refactor](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-5--consolidate-the-root-level-claude-invoker). Consolidate the root-level `src/agents/claude-code-invoker.ts` — a parallel Claude spawn path that bypasses `ProcessFactory` entirely — onto `AgentLauncher` + `ClaudeCodeLaunchPlugin`.

Per resolved open question #5, the `AgentInvoker` interface is **kept** as a thin adapter over `AgentLauncher`, not deleted. This preserves the root-worker surface.

## Scope

- Migrate [src/worker/main.ts](https://github.com/generacy-ai/generacy/blob/develop/src/worker/main.ts) to use `AgentLauncher` + `ClaudeCodeLaunchPlugin` via the `AgentInvoker` interface.
- Rewrite `ClaudeCodeInvoker` at [src/agents/claude-code-invoker.ts:86](https://github.com/generacy-ai/generacy/blob/develop/src/agents/claude-code-invoker.ts#L86) as a thin adapter:
  - `invoke(config: InvocationConfig)` translates to a `LaunchRequest` and calls `agentLauncher.launch()`
  - No direct `child_process.spawn` calls remain in the file
  - No direct use of `spawn` / `fork` / `exec` anywhere under `src/agents/`
- `AgentRegistry` stays; it registers the adapter-form invoker.
- `AgentInvoker` interface at [src/agents/types.ts:91-126](https://github.com/generacy-ai/generacy/blob/develop/src/agents/types.ts#L91-L126) unchanged.
- Rewrite [tests/agents/claude-code-invoker.test.ts](https://github.com/generacy-ai/generacy/blob/develop/tests/agents/claude-code-invoker.test.ts):
  - Assertions about spawn argv/env move to `ClaudeCodeLaunchPlugin.test.ts` (resolved open question #6).
  - Adapter-level tests verify the `InvocationConfig` → `LaunchRequest` translation and `AgentRegistry` dispatch.
- Update [tests/worker/handlers/agent-handler.test.ts](https://github.com/generacy-ai/generacy/blob/develop/tests/worker/handlers/agent-handler.test.ts) to exercise the new path.

## Acceptance criteria

- `grep -n "child_process" src/agents/` returns nothing.
- `AgentInvoker` interface signature unchanged.
- Root-level worker integration tests pass end-to-end through the new path.
- Plugin-level tests cover every spawn-argv assertion that was previously in `claude-code-invoker.test.ts`.
- `tests/agents/claude-code-invoker.test.ts` passes (as an adapter-level test) or is cleanly removed with equivalent coverage landed at the plugin level.

## Out of scope

- Deletion of the `AgentInvoker` interface (kept per resolved open question #5).
- Any changes to `AgentRegistry` beyond adapter registration.

## Dependencies

- Depends on Wave 2 Claude Plugin issue.
- Parallel-safe with Wave 3 (touches a different subtree — `src/` vs `packages/orchestrator/src/worker/`).

## References

- Parent tracking: #423


## User Stories

### US1: Developer eliminates duplicate spawn path

**As a** platform developer,
**I want** `ClaudeCodeInvoker` to delegate to `AgentLauncher` instead of calling `child_process.spawn` directly,
**So that** all Claude process spawning flows through a single, plugin-based pipeline with consistent environment setup, lifecycle management, and testability.

**Acceptance Criteria**:
- [ ] `ClaudeCodeInvoker.invoke()` translates `InvocationConfig` to `LaunchRequest` and calls `agentLauncher.launch()`
- [ ] No `child_process` imports remain under `src/agents/`
- [ ] `AgentInvoker` interface signature is unchanged

### US2: Developer migrates worker entry point

**As a** platform developer,
**I want** `src/worker/main.ts` to use `AgentLauncher` + `ClaudeCodeLaunchPlugin` via the `AgentInvoker` adapter,
**So that** the root-level worker spawns Claude through the unified launcher pipeline.

**Acceptance Criteria**:
- [ ] Worker main uses the adapter-form invoker
- [ ] Agent handler integration tests pass through the new path

### US3: Developer maintains test coverage at the correct layer

**As a** platform developer,
**I want** spawn-argv/env assertions to live in `ClaudeCodeLaunchPlugin.test.ts` and adapter-translation assertions in `claude-code-invoker.test.ts`,
**So that** tests are layered correctly and each concern is tested at the right abstraction level.

**Acceptance Criteria**:
- [ ] Plugin-level tests cover every spawn-argv assertion previously in `claude-code-invoker.test.ts`
- [ ] Adapter-level tests verify `InvocationConfig` → `LaunchRequest` translation
- [ ] Agent handler tests exercise the end-to-end new path

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Rewrite `ClaudeCodeInvoker` as thin adapter: `invoke()` → `LaunchRequest` → `agentLauncher.launch()` | P1 | No direct spawn calls |
| FR-002 | Migrate `src/worker/main.ts` to use `AgentLauncher` via `AgentInvoker` adapter | P1 | |
| FR-003 | `AgentInvoker` interface at `src/agents/types.ts:91-126` remains unchanged | P1 | Preserves root-worker surface |
| FR-004 | `AgentRegistry` registers the adapter-form invoker | P1 | No other registry changes |
| FR-005 | Move spawn-argv/env test assertions to `ClaudeCodeLaunchPlugin.test.ts` | P1 | Per resolved open question #6 |
| FR-006 | Rewrite or remove `tests/agents/claude-code-invoker.test.ts` as adapter-level tests | P1 | |
| FR-007 | Update `tests/worker/handlers/agent-handler.test.ts` for new path | P1 | |
| FR-008 | Zero `child_process` references remain under `src/agents/` | P1 | Acceptance gate |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `child_process` references in `src/agents/` | 0 | `grep -rn "child_process" src/agents/` returns nothing |
| SC-002 | `AgentInvoker` interface diff | No changes | `git diff` on `src/agents/types.ts` lines 91-126 is empty |
| SC-003 | Test suite passes | All green | `pnpm test` — all agent and worker tests pass |
| SC-004 | Spawn-argv coverage at plugin layer | 100% of prior assertions | Every spawn-argv assertion from old invoker test exists in plugin test |

## Assumptions

- Wave 2 Claude Plugin (`ClaudeCodeLaunchPlugin`) is already implemented and available
- `AgentLauncher` API is stable and supports the `LaunchRequest` shape needed by this adapter
- No other consumers of the direct spawn path in `src/agents/` beyond `ClaudeCodeInvoker`

## Out of Scope

- Deletion of the `AgentInvoker` interface (kept per resolved open question #5)
- Any changes to `AgentRegistry` beyond adapter registration
- Changes to `packages/orchestrator/src/worker/` (Wave 3, parallel-safe)

---

*Generated by speckit*

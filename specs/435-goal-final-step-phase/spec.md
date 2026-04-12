# Feature Specification: Phase 3 Cleanup — Delete PHASE_TO_COMMAND and Claude Flags from Orchestrator

**Branch**: `435-goal-final-step-phase` | **Date**: 2026-04-12 | **Status**: Draft | **Issue**: #435

## Summary

Final step of Phase 3 of the [spawn refactor](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-3--migrate-orchestrator-spawn-sites). After Wave 3's Phase 3a/3b/3c migrations moved all Claude spawn logic into plugins, the orchestrator's hardcoded Claude knowledge is dead code. This issue removes that dead code.

## Scope

- Delete `PHASE_TO_COMMAND` map from `packages/orchestrator/src/worker/types.ts` (lines 73-80).
- Delete any Claude-specific flag constants (`--resume`, `--output-format`, `--dangerously-skip-permissions`) that remain only in orchestrator internals.
- Delete any now-unused helper functions in `cli-spawner.ts`, `pr-feedback-handler.ts`, `conversation-spawner.ts`.
- Delete the inline PTY wrapper script from `conversation-spawner.ts` (it now lives only in `ClaudeCodeLaunchPlugin`).
- Verify the literal string `"claude"` no longer appears in `packages/orchestrator/src/` except in plugin-ID references and comments.
- Update orchestrator package exports if any now-dead symbols were previously re-exported.

## User Stories

### US1: Maintainer removes dead orchestrator code

**As a** developer maintaining the orchestrator package,
**I want** all hardcoded Claude-specific spawn logic removed from the orchestrator internals,
**So that** the orchestrator is fully decoupled from any specific agent implementation and relies solely on the plugin system.

**Acceptance Criteria**:
- [ ] `PHASE_TO_COMMAND` map is deleted from `types.ts`
- [ ] Claude-specific CLI flag constants are removed from orchestrator internals
- [ ] Unused helper functions in `cli-spawner.ts`, `pr-feedback-handler.ts`, `conversation-spawner.ts` are deleted
- [ ] Inline PTY wrapper script is removed from `conversation-spawner.ts`
- [ ] No literal `"claude"` strings remain except plugin-ID references and comments
- [ ] Package exports are updated to remove dead symbols

### US2: CI validates clean separation

**As a** CI pipeline,
**I want** grep-based assertions to confirm no hardcoded Claude references remain,
**So that** accidental re-introduction of coupled code is caught early.

**Acceptance Criteria**:
- [ ] `grep -rn "PHASE_TO_COMMAND" packages/orchestrator/src/` returns nothing
- [ ] `grep -rn '"claude"' packages/orchestrator/src/` returns only plugin-ID references

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Delete `PHASE_TO_COMMAND` map from `types.ts` | P1 | Lines 73-80 |
| FR-002 | Delete Claude-specific flag constants from orchestrator internals | P1 | `--resume`, `--output-format`, `--dangerously-skip-permissions` |
| FR-003 | Delete unused helper functions in `cli-spawner.ts` | P1 | Functions no longer called after plugin migration |
| FR-004 | Delete unused helper functions in `pr-feedback-handler.ts` | P1 | Functions no longer called after plugin migration |
| FR-005 | Delete unused helper functions in `conversation-spawner.ts` | P1 | Functions no longer called after plugin migration |
| FR-006 | Delete inline PTY wrapper script from `conversation-spawner.ts` | P1 | Now lives in `ClaudeCodeLaunchPlugin` |
| FR-007 | Update orchestrator package exports for removed symbols | P2 | Only if dead symbols were re-exported |
| FR-008 | Verify no `"claude"` literals remain except plugin-ID refs | P1 | Grep-based verification |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `PHASE_TO_COMMAND` references in orchestrator | 0 | `grep -rn "PHASE_TO_COMMAND" packages/orchestrator/src/` |
| SC-002 | `"claude"` literals in orchestrator (non-plugin-ID) | 0 | `grep -rn '"claude"' packages/orchestrator/src/` filtered for plugin-ID |
| SC-003 | LOC reduction in `cli-spawner.ts` | Measurable decrease | `wc -l` before/after |
| SC-004 | LOC reduction in `pr-feedback-handler.ts` | Measurable decrease | `wc -l` before/after |
| SC-005 | LOC reduction in `conversation-spawner.ts` | Measurable decrease | `wc -l` before/after |
| SC-006 | All CI tests pass | 100% green | CI pipeline |

## Assumptions

- Wave 3 Phase 3a, 3b, 3c migrations have all landed on `develop` before this work begins.
- All Claude spawn logic is now handled by `ClaudeCodeLaunchPlugin` and no orchestrator code depends on the items being deleted.
- No external consumers depend on the orchestrator package symbols being removed.

## Out of Scope

- Root-level `claude-code-invoker.ts` deletion (Wave 4).
- Any functional behavior change — this is a pure dead-code cleanup.
- Phase 3d shell validators issue (independent of this cleanup).

## Dependencies

- **Blocked by**: Wave 3 Phase 3a (#429), 3b (#430), 3c spawn-site migrations all landing.
- **Independent of**: Phase 3d shell validators issue.
- **Parent tracking**: #423

## References

- [Spawn refactor plan — Phase 3](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-3--migrate-orchestrator-spawn-sites)
- Parent tracking: #423

---

*Generated by speckit*

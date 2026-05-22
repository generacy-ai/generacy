# Feature Specification: Inject sibling-repo awareness into agent prompt

**Branch**: `688-phase-1-multi-repo` | **Date**: 2026-05-22 | **Status**: Draft
**Issue**: [#688](https://github.com/generacy-ai/generacy/issues/688)

## Summary

Phase 1 of [multi-repo workflow support](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/multi-repo-workflows-plan.md). The agent (Claude Code) can edit files in sibling repos cloned under `/workspaces/`, but the orchestrator never tells it those repos exist. The agent stays inside its primary repo even when the task requires cross-repo edits.

This feature injects a sibling-repo instruction block into the agent prompt before each phase spawn, so the agent can deliberately edit sibling repos when the task calls for it.

## User Stories

### US1: Cross-repo task awareness

**As a** developer running a workflow that spans multiple repos,
**I want** the agent to know about sibling repos in the workspace,
**So that** it can make coordinated edits across repos without being told where they are.

**Acceptance Criteria**:
- [ ] When sibling repos are configured, the agent prompt includes a block listing each repo name and path
- [ ] The agent can reference and edit files in listed sibling repos during implement phase
- [ ] When no siblings are configured, the prompt contains no sibling block (no "no siblings" noise)

### US2: No regression for single-repo workflows

**As a** developer running a single-repo workflow,
**I want** the agent behavior to remain unchanged,
**So that** existing workflows are unaffected by this feature.

**Acceptance Criteria**:
- [ ] Phase spawn with empty/absent sibling list produces identical prompt to today
- [ ] No new errors or warnings when sibling config is missing

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Inject sibling-repo instruction block into the phase prompt when `siblingWorkdirs` is non-empty | P1 | Injection point in `phase-loop.ts` before passing prompt to `cliSpawner.spawnPhase()` |
| FR-002 | Source sibling list from a defined data structure (stub until Issue A lands) | P1 | Likely a field on `WorkerContext` or `WorkerConfig`, populated upstream by `claude-cli-worker.ts` |
| FR-003 | Omit the block entirely when sibling list is empty or undefined | P1 | No "no siblings" message — just the original prompt |
| FR-004 | Include repo name and absolute path for each sibling entry | P1 | Format: `` `<name>` — `/workspaces/<name>` `` |
| FR-005 | Draft-PR note in prompt text | P2 | Pending clarification on timing — may defer to Phase 2 |

## Key Implementation Details

### Prompt injection path

1. `phase-loop.ts` line ~185 — `context.issueUrl` is passed as `prompt` to `cliSpawner.spawnPhase()`
2. `cli-spawner.ts` line ~56 — passes prompt as `intent.prompt` to `agentLauncher.launch()`
3. `claude-code-launch-plugin.ts` line ~85 — appends prompt after slash command: `/implement <prompt>`

The injection point is in step 1: prepend the sibling block to `context.issueUrl` before the spawn call.

### Data flow

```
siblingWorkdirs (Issue A / stub)
  → WorkerContext or WorkerConfig
    → phase-loop.ts (build sibling block)
      → prompt string passed to cliSpawner
```

### Prompt format (proposed)

```
**Sibling repos available in this workspace.** You may edit files in any of these as part of this task:
- `agency` — `/workspaces/agency`
- `generacy-cloud` — `/workspaces/generacy-cloud`

<original prompt>
```

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Sibling block present in agent prompt when siblings configured | 100% of implement-phase spawns | Inspect conversation log / stream-json output |
| SC-002 | No sibling block when siblings absent | 100% of spawns without config | Verify prompt string matches original format |
| SC-003 | Agent acknowledges sibling repos | Visible in conversation log | Manual smoke test in tetrad-development |

## Assumptions

- Sibling repos are pre-cloned under `/workspaces/` by the time the agent spawns (handled by peer-repo-cloner or manual setup)
- Issue A (`siblingWorkdirs` map) will land separately; this feature can stub the data source
- The agent (Claude Code) does not need filesystem permission changes to edit sibling repos — it already has access

## Out of Scope

- Picking up changes the agent makes in sibling repos (Phase 2, Issue E)
- Cross-repo dependency tracking ("this PR depends on repo B")
- Sibling repo discovery via filesystem scan (explicit config only)
- Teaching the agent cross-repo git workflows (commit, branch, PR creation in siblings)

## Dependencies

- **Soft**: Issue A (`siblingWorkdirs` map) — can develop against stub in parallel
- **Files**: `packages/orchestrator/src/worker/phase-loop.ts`, `packages/orchestrator/src/worker/types.ts`, `packages/orchestrator/src/worker/claude-cli-worker.ts`

## Open Questions (see clarifications.md)

1. Which injection point — phase-loop prompt, per-task prompt, or system-level (CLAUDE.md)?
2. Where should sibling data live at runtime — context object, WorkerConfig, or filesystem scan?
3. Inject into implement phase only, or all phases?
4. Include draft-PR note now or defer to Phase 2?
5. Repo identifier format — directory basename, repo slug, or full org/repo?

---

*Generated by speckit*

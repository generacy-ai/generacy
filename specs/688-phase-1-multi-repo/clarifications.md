# Clarifications for #688 — Inject sibling-repo awareness into agent prompt

## Batch 1 — 2026-05-22

### Q1: Prompt injection point
**Context**: The implement-phase prompt is assembled at two levels: (1) `phase-loop.ts` passes the issue URL as the prompt to `cli-spawner.spawnPhase()`, which launches `claude /implement <url>`, and (2) within the `/implement` skill, `buildTaskPrompt()` in `implement.ts` builds a per-task prompt with spec/plan context. "Prepend to the agent prompt" could mean either level — or a third option like injecting into the CLAUDE.md/system prompt that the CLI session reads.
**Question**: Which injection point should the sibling-repo block be added to?
**Options**:
- A: The initial phase prompt in `phase-loop.ts` (prepended before the issue URL — seen once per implement phase)
- B: The per-task prompt in `buildTaskPrompt()` (repeated for each task within implement)
- C: A system-level injection (e.g., appended to the CLAUDE.md that the CLI session reads)

**Answer**: A — Phase-loop initial prompt prepend. Prepend before the issue URL in `phase-loop.ts` where `options.prompt` is constructed for `cli-spawner.spawnPhase()`. The CLI conversation context persists across tasks within a phase, so per-task repetition (B) is wasteful. Option C (CLAUDE.md mutation) would create dirty git state in the workspace and conflict with the committed CLAUDE.md.

### Q2: siblingWorkdirs data source
**Context**: The spec references a `siblingWorkdirs` map from "Issue A", but no such field exists in the codebase today. To wire the injection, the implementer needs to know where this data will live at runtime — e.g., on `WorkerConfig`, on the phase-loop `context` object, as an environment variable, or read from a config file like `.agency/config.yaml`.
**Question**: Where should the sibling repo list be sourced from at runtime? If Issue A hasn't landed, what shape should the stub take and where should it live?
**Options**:
- A: A new field on the phase-loop `context` object (populated upstream by `claude-cli-worker.ts`)
- B: A config value in `WorkerConfig` / `.agency/config.yaml`
- C: Filesystem scan of `/workspaces/` directories (discover siblings dynamically)

**Answer**: A — Phase-loop `context` object. The orchestrator's `claude-cli-worker.ts` (which already loads `WorkerConfig`) resolves the sibling map from workspace config and populates a new field on the phase-loop context. Same data-source decision as #687 Q2. If #687 hasn't landed, stub the field on the context object with an empty default and wire the real source when #687 merges.

### Q3: Phase scope
**Context**: FR-001 specifies "implement-phase agent spawn path" only. However, the `plan` phase designs the implementation strategy and could benefit from knowing about sibling repos to plan cross-repo changes. The `specify` and `tasks` phases might also produce better artifacts if they know siblings exist. All phases share the same spawn path in `phase-loop.ts`.
**Question**: Should sibling-repo awareness be limited strictly to the implement phase, or should it also be injected into other phases (especially `plan`)?
**Options**:
- A: Implement phase only (as spec says)
- B: All CLI phases (specify, clarify, plan, tasks, implement) — minimal cost since they share the same spawn path
- C: Implement + plan phases only

**Answer**: B — All CLI phases (specify, clarify, plan, tasks, implement). Same spawn path, near-zero cost, real benefit. The `plan` phase produces strategy artifacts that should reference siblings if cross-repo work is needed; `clarify` may need to ask sibling-specific questions. Implement-only (A) leaves earlier-phase artifacts blind to the multi-repo reality.

### Q4: Draft PR note timing
**Context**: FR-004 (P2) says to include a note that "changes in sibling repos will be automatically committed with draft PRs." This behavior doesn't exist yet (Phase 2). Including it now could cause the agent to make incorrect assumptions about what happens to its cross-repo edits — or it could helpfully set the right mental model.
**Question**: Should the draft-PR note be included in Phase 1, or deferred until Phase 2 when the behavior actually exists?
**Options**:
- A: Include now as-is (sets expectations even if not yet functional)
- B: Include with a caveat like "in a future update" so the agent doesn't assume it works today
- C: Defer entirely to Phase 2

**Answer**: C — Defer entirely to Phase 2. The prompt should only state what's true today: "These sibling repos exist at these paths; you may edit them." Don't promise auto-PR behavior that doesn't ship until #691 — the agent would form an incorrect mental model and not flag lost changes.

### Q5: Repo identifier format
**Context**: The proposed prompt format shows entries like `` `agency` — `/workspaces/agency` ``. The "repo name" could be the GitHub repo name (e.g., `generacy-ai/agency`), just the repo slug (`agency`), or the directory basename under `/workspaces/`. This affects both the display and how the `siblingWorkdirs` map keys are defined.
**Question**: What should the repo name/identifier be in the prompt — the directory basename, the GitHub repo slug, or the full `org/repo` name?
**Options**:
- A: Directory basename (e.g., `agency`) — simplest, matches filesystem
- B: GitHub repo slug (e.g., `agency`) — same in most cases, but semantically different
- C: Full org/repo (e.g., `generacy-ai/agency`) — most precise but verbose

**Answer**: A — Directory basename (e.g., `agency`). Matches what the agent sees on disk and what it'll type in file paths. Org-qualified (C) is verbose and surfaces an org concept the agent doesn't need for filesystem operations.

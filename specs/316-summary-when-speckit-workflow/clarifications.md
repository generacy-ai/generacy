# Clarifications

## Batch 1 — 2026-03-06

### Q1: Duplicate Posting with executeClarify
**Context**: The `executeClarify()` function in `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` (lines 268-305) already posts clarification questions to the GitHub issue via `gh issue comment`. However, the bug report shows this isn't working in practice. Adding orchestrator-level posting would create two code paths that do the same thing.

**Question**: Should the existing posting code in `executeClarify()` be removed in favor of orchestrator-level posting, or should the orchestrator posting be a fallback that only fires if questions weren't already posted?

**Options**:
- A) Remove the posting from `executeClarify()` and make the orchestrator solely responsible
- B) Keep both — let `executeClarify()` try first, orchestrator posts only if no comment found
- C) Keep `executeClarify()` as-is but add orchestrator posting unconditionally (accept potential duplicates)

**Answer**: A — Remove the posting from `executeClarify()`, orchestrator is solely responsible. The orchestrator has deterministic control over the posting flow and can guarantee ordering relative to labels. Agent-level posting via `gh issue comment` inside the Claude Code session is fragile — it can be skipped, formatted differently, or fail partway through.

---

### Q2: Implementation Location
**Context**: The spec mentions two possible locations: directly in `phase-loop.ts` (after `labelManager.onGateHit()`) or as a responsibility of `StageCommentManager`. The phase-loop approach is simpler but adds file I/O logic to the orchestration layer. The StageCommentManager approach is more cohesive since it already manages issue comments.

**Question**: Should the clarification posting be added directly in `phase-loop.ts` or encapsulated in `StageCommentManager` (or a new dedicated class)?

**Options**:
- A) Directly in `phase-loop.ts` between `onGateHit()` and stage comment update
- B) As a new method on `StageCommentManager` called from `phase-loop.ts`
- C) As a new dedicated `ClarificationCommentManager` class

**Answer**: C — New dedicated class (e.g., `clarification-poster.ts`). Phase-loop should stay clean of file I/O and markdown parsing. StageCommentManager has a different responsibility (progress tracking). A dedicated class gives clean separation of concerns and is independently testable.

---

### Q3: Clarifications File Path
**Context**: The `clarifications.md` file lives inside the spec directory (e.g., `specs/316-summary-when-speckit-workflow/clarifications.md`). The orchestrator has `context.checkoutPath` (the repo checkout) but would need to know the spec directory name to locate the file. The spec says "read from working directory" but at the orchestrator level, the working directory is the repo root.

**Question**: How should the orchestrator locate `clarifications.md`? Should it derive the spec directory from the branch name, search for it with a glob, or receive it as output from the clarify phase?

**Options**:
- A) Derive from branch name: `specs/{branch-name}/clarifications.md`
- B) Glob search: `specs/*/clarifications.md` (take most recently modified)
- C) Parse clarify phase output to get the file path

**Answer**: B — Glob search for `specs/{issueNumber}-*/clarifications.md`. `PhaseResult` doesn't carry structured output from the clarify phase, and adding that is out of scope for this bugfix. Globbing by issue number is reliable and matches the existing `specs/{issueNumber}-{slug}/` directory convention.

---

### Q4: Gate-Specific Behavior
**Context**: The current gate-hit code in `phase-loop.ts` is generic — it handles all gate types the same way. Adding clarification-specific logic (reading `clarifications.md`, posting questions) would make the gate handler aware of specific gate types, breaking the current abstraction.

**Question**: Is it acceptable to add `waiting-for:clarification`-specific logic in the gate handler, or should this be designed as a generic "gate action" system that could support other gate types in the future?

**Options**:
- A) Add clarification-specific logic directly (simpler, solves the immediate problem)
- B) Design a generic gate action hook system (more extensible but more complex)

**Answer**: A — Add clarification-specific logic directly. This is a bugfix, not an architecture redesign. A generic gate action system is over-engineering for a single use case. Can be refactored later if more gate types need custom actions.

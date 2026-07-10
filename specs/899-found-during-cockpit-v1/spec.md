# Feature Specification: plan phase writes per-feature managed files (stop appending to shared CLAUDE.md)

**Feature Branch**: `899-found-during-cockpit-v1`
**Created**: 2026-07-10
**Status**: Draft
**Input**: GitHub issue [generacy-ai/generacy#899](https://github.com/generacy-ai/generacy/issues/899)

## Summary

The speckit `plan` phase currently appends a managed section to the repo-root `CLAUDE.md` on **every feature branch** (`<!-- speckit:managed — technologies added by /plan for feature NNN -->`, plus "Active work" entries). Sibling feature branches derived from the same base therefore always collide pairwise on `CLAUDE.md` when either merges, even when the epic scrupulously partitions all other owned files. The workflow's own bookkeeping defeats the file-disjoint parallelization convention it documents.

This spec proposes to move that managed content off `CLAUDE.md` and into a per-feature file the branch owns (proposal (a) in the issue: `specs/<feature>/stack.md` or `.specify/managed/<feature>.md`). `CLAUDE.md` gains a one-time static pointer that never changes per feature; parallel branches become genuinely file-disjoint again by construction, not by luck.

## Context

Observed in the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92, finding #46) as the structural root cause behind findings #40 and #44:

- Five distinct merge-conflict incidents across T-S2 and T-S4, all centered on `CLAUDE.md`.
- Consequence chain: sibling #5 merges → every remaining P2 branch's base-merge (#864) conflicts on `CLAUDE.md` → all pause at `waiting-for:merge-conflicts` → phase stalls.
- The #44 handler resolves each incident at the cost of an agent invocation per sibling per merge. The fix here removes the conflict class instead of treating each instance.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Parallel siblings through /plan merge without CLAUDE.md conflicts (Priority: P1)

As a cockpit auto-mode operator running an epic that fans out into parallel feature branches, when each sibling passes through the `/plan` phase and later merges into the shared base, none of them should collide on `CLAUDE.md`. Only files that a branch genuinely owns should ever appear in merge conflicts.

**Why this priority**: This is the entire point of the change. Without it, every parallel-phase epic re-manufactures the same class of merge conflict indefinitely, stalling phases and burning one agent invocation per sibling per merge on a self-inflicted collision.

**Independent Test**: Create two sibling feature branches from the same base, run each through the `/plan` phase, then run `git merge-tree` of either into base-plus-other. Report must show **no conflicts**. This is the T-S4 scenario inverted into an assertion (see Regression Test below).

**Acceptance Scenarios**:

1. **Given** two sibling feature branches created from the same base commit, **When** each branch passes through `/plan` and modifies only its own files (including any speckit-managed technology notes), **Then** `git merge-tree base sibling-A sibling-B` reports zero conflicts.
2. **Given** an epic with N parallel feature branches all running through `/plan` concurrently, **When** they merge back into the base one after another, **Then** no branch pauses at `waiting-for:merge-conflicts` because of `CLAUDE.md`.
3. **Given** a branch has just finished the `/plan` phase, **When** an agent (or human) inspects the repo, **Then** the per-feature managed content is discoverable at a predictable per-feature path and `CLAUDE.md` contains a static pointer to that path.

---

### User Story 2 - Agents still find per-feature technology context (Priority: P2)

As an agent invoked on a feature branch, when I need the "what stack / active work" context that used to live in `CLAUDE.md`'s managed section, I can still find it — for the current feature — with one hop from `CLAUDE.md` or by convention.

**Why this priority**: The managed section exists because the context has value. Removing it entirely (issue proposal (c)) would regress agent effectiveness. This story defends the value while the P1 story removes the conflict class.

**Independent Test**: On any feature branch that has completed `/plan`, an agent starting cold from `CLAUDE.md` alone can reach the per-feature managed content in one file read (via the pointer) or by naming convention alone.

**Acceptance Scenarios**:

1. **Given** a branch that completed `/plan`, **When** an agent reads `CLAUDE.md`, **Then** it finds an explicit static pointer describing where per-feature managed notes live.
2. **Given** the same branch, **When** an agent reads the per-feature managed file, **Then** it contains the same categories of information the CLAUDE.md managed section used to hold (technologies added by `/plan`, active work entries, etc.).

---

### User Story 3 - Existing feature branches with legacy managed sections still work (Priority: P3)

As a maintainer with in-flight feature branches created before this change, when I rebase or continue those branches after the change lands, the workflow tolerates the legacy `<!-- speckit:managed -->` section in `CLAUDE.md` without producing a fresh conflict or duplicated content.

**Why this priority**: Migration hygiene. Prevents the fix from becoming its own conflict source during the changeover window.

**Independent Test**: Run `/plan` on a branch whose `CLAUDE.md` still contains a legacy managed section from an earlier plan invocation; verify the plan phase migrates or leaves-alone the legacy section without appending a new one to `CLAUDE.md`.

**Acceptance Scenarios**:

1. **Given** a feature branch whose `CLAUDE.md` still contains a legacy managed section, **When** `/plan` runs, **Then** no new managed section is appended to `CLAUDE.md` (writes go only to the per-feature file).
2. **Given** the same branch merged into the updated base, **When** conflict resolution runs, **Then** any remaining `CLAUDE.md` conflict is confined to the deletion of the legacy managed section and is trivially auto-resolvable, not a content merge.

---

### Edge Cases

- What happens if the per-feature managed file already exists when `/plan` runs (re-invocation, or human-authored)? Expected: idempotent update — regenerate the managed section in place without duplicating.
- What happens if the branch has no `specs/<feature>/` directory yet? Expected: `/plan` creates it (it already does today for `plan.md`), so the managed file lands alongside.
- What happens on a branch that never runs `/plan` (e.g., a bugfix workflow that skips planning)? Expected: no per-feature managed file is created; `CLAUDE.md` remains untouched.
- What happens if two branches happen to modify the *pointer line* in `CLAUDE.md` (e.g., during the migration commit itself)? Expected: the pointer is written once by the migration and is identical on every branch, so no conflict arises from the pointer.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The `/plan` phase MUST NOT append, modify, or delete any content in the repo-root `CLAUDE.md` as part of its per-feature bookkeeping.
- **FR-002**: The `/plan` phase MUST write its managed technology-and-active-work content to a per-feature file whose path is uniquely determined by the current feature identifier (e.g., `specs/<feature>/stack.md` or `.specify/managed/<feature>.md`). [NEEDS CLARIFICATION: exact path — `specs/<feature>/stack.md` (co-located with other spec artifacts) vs `.specify/managed/<feature>.md` (grouped with other speckit-managed state)]
- **FR-003**: `CLAUDE.md` MUST contain a single, static, feature-independent pointer describing where per-feature managed notes live (e.g., "per-feature technology notes live in `specs/*/stack.md`"). This pointer MUST be written exactly once (by the migration / scaffolder) and never modified by `/plan`.
- **FR-004**: Re-invoking `/plan` on the same branch MUST be idempotent with respect to the per-feature managed file — content is regenerated in place, not duplicated or appended.
- **FR-005**: The per-feature managed file MUST preserve the information categories the CLAUDE.md managed section carried today (at minimum: technologies added by `/plan`, active-work entries).
- **FR-006**: The change MUST include migration handling for in-flight branches carrying a legacy `<!-- speckit:managed -->` section in `CLAUDE.md`: either leave it alone (do not append more) or delete it as part of the plan step. [NEEDS CLARIFICATION: migration policy — leave-alone vs strip-on-next-plan]
- **FR-007**: The change MUST include a regression test that constructs two sibling feature branches from the same base, runs each through `/plan`, and asserts `git merge-tree` (or equivalent) reports zero conflicts on `CLAUDE.md`.
- **FR-008**: Documentation that currently instructs contributors that `/plan` "updates CLAUDE.md" (if any) MUST be updated to describe the per-feature file instead.

### Key Entities

- **Per-feature managed file**: Per-branch file owned exclusively by one feature. Holds the technology notes and active-work entries that `/plan` currently writes into `CLAUDE.md`. Path is deterministic from the feature identifier. Never shared, never merged across siblings.
- **CLAUDE.md pointer line**: A single static sentence in `CLAUDE.md` (written once by the migration) pointing agents at the per-feature managed file convention. Feature-independent; identical on every branch.
- **Legacy managed section**: The existing `<!-- speckit:managed — technologies added by /plan for feature NNN --> ... <!-- /speckit:managed -->` region in `CLAUDE.md` on branches created before this change. Subject to the migration policy in FR-006.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the regression test scenario (two sibling branches through `/plan`, base-merge each way), `git merge-tree` reports **zero** conflicts attributable to `CLAUDE.md`.
- **SC-002**: In a full cockpit auto-mode integration run of an epic with ≥2 parallel `/plan`-passing branches, **zero** merge-conflict incidents are attributed to `CLAUDE.md` (baseline observed: five incidents across two phases in the T-S2 / T-S4 run).
- **SC-003**: After the change, the number of agent invocations spent resolving `CLAUDE.md` merge conflicts per epic drops to **zero** for `/plan`-driven collisions (baseline: one invocation per sibling per merge).
- **SC-004**: Agents starting cold from `CLAUDE.md` on a post-`/plan` branch reach the per-feature managed content in ≤1 additional file read (verified by inspection: the pointer line is present and correct).
- **SC-005**: In-flight branches with legacy managed sections merge into the updated base without introducing new content-level conflicts (only the trivial removal of the legacy section, if the chosen migration policy strips it).

## Regression Test *(from issue)*

Two sibling feature branches created from the same base, both through the `/plan` phase → `git merge-tree` of either into base-plus-other reports **no conflicts**. This is the T-S4 scenario inverted into an assertion.

## Assumptions

- The value of the CLAUDE.md managed section is preserved by moving it to a per-feature file plus a static pointer — proposal (a) is the accepted direction (issue explicitly prefers (a) over (b) union-merge and (c) drop-entirely).
- The `/plan` phase is implemented by a skill/script under speckit (upstream), not by code in this repo directly. The fix will land in the upstream skill and be picked up here via the scaffolder / setup.
- No behavior in this repo depends on the presence of the `<!-- speckit:managed -->` markers in `CLAUDE.md` itself (searches for `speckit:managed` and `Active work` in `.specify/` and workflow code turned up no consumers).
- The cockpit `waiting-for:merge-conflicts` / #44 handler remains in place as the general-purpose safety net; this change simply removes one recurring cause.

## Out of Scope

- Alternative fix (b): shipping `.gitattributes` with `CLAUDE.md merge=union`. Rejected in the issue as a weaker guarantee (silently interleaves genuinely conflicting edits).
- Alternative fix (c): dropping the managed section entirely and recording the stack only in spec artifacts. Rejected in the issue as losing the in-repo agent-context value.
- Changes to the #44 merge-conflict resolver handler — this spec removes one cause; the handler stays for the general case.
- Any change to how `/plan` chooses the *content* of the managed section — only the **write target** changes.
- Fixing conflicts in files other than `CLAUDE.md` — the smoke test only surfaced `CLAUDE.md` as the shared attractor; other files (if they emerge) are separate findings.

---

*Generated by speckit — enhanced from generacy-ai/generacy#899*

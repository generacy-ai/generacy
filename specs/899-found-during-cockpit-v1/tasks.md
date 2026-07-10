## 📝 Standard mode: Generating fine-grained implementation tasks

# Tasks: plan phase writes per-feature managed files (stop appending to shared `CLAUDE.md`)

**Input**: Design documents from `/specs/899-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/companion-issue.md, contracts/stack-md-file.md, contracts/merge-tree-invariant.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 = the sole user story (break the CLAUDE.md sibling-conflict class)

## Phase 1: Documentation edit — add `CLAUDE.md` pointer

- [ ] T001 [US1] Add "Per-feature technology notes" pointer block to `CLAUDE.md` near the top (below the intro paragraph, above `## Development`), matching plan.md §Phase 1 step 1 verbatim (SC-004). Terse, no `<!-- speckit:managed -->` marker, one-time hand-written block, references issue #899 for the rationale.

## Phase 2: Regression test — merge-tree invariant + drift guard

- [ ] T002 [US1] Create `packages/workflow-engine/src/actions/builtin/speckit/__tests__/managed-file-disjointness.test.ts` scaffolding: vitest `describe('managed-file disjointness (issue #899)', …)`, imports (`node:child_process`, `node:fs`, `node:os`, `node:path`, `vitest`), and a shared `git(cwd, args)` helper matching the research.md §Vitest merge-tree test pattern.
- [ ] T003 [US1] Implement Layer 2 (merge-tree simulation) inside the test file created in T002: `it('two sibling branches writing per-feature stack.md do not conflict on CLAUDE.md', …)` — creates a temp `git init` repo via `os.tmpdir()`, commits an empty `CLAUDE.md`, branches `feature-a` writing `specs/feature-a/stack.md`, branches `feature-b` writing `specs/feature-b/stack.md`, runs `git merge-tree --write-tree -z <base> <shaA> <shaB>`, asserts output does not match `/CONFLICT/` and does not match `/CLAUDE\.md/`. Proves SC-002 + [contracts/merge-tree-invariant.md](./contracts/merge-tree-invariant.md).
- [ ] T004 [US1] Implement Layer 1 (static-grep drift guard) inside the same test file: `it('plan.ts prompt does not mention CLAUDE.md or update_agent (drift guard)', …)` — reads `packages/workflow-engine/src/actions/builtin/speckit/operations/plan.ts` via `fs/promises.readFile`, isolates the `buildPlanPrompt` function region via regex `/function buildPlanPrompt[\s\S]+?^}/m`, asserts the region does not match `/CLAUDE\.md/i` and does not match `/update_agent/i`. Proves SC-003.
- [ ] T005 [US1] Verify the regression test file runs green in isolation: `pnpm --filter @generacy-ai/workflow-engine test managed-file-disjointness` (or equivalent). Confirms both layers pass on this branch after T001–T004 land.

## Phase 3: Companion upstream issue

- [ ] T006 [US1] File the companion issue in `generacy-ai/agency` per [contracts/companion-issue.md](./contracts/companion-issue.md): title, body, and success-criteria checklist copied from the contract file. Cross-reference this issue (#899) and this spec. Block SC-001 on it.

## Phase 4: Verification / sign-off

- [ ] T007 [US1] Manually confirm the `CLAUDE.md` pointer text is discoverable — `grep -n "specs/<feature>/stack.md" CLAUDE.md` returns a hit on line ≤50 (SC-004). Recorded in PR description.
- [ ] T008 [US1] Confirm scope-guard invariants held during implementation: `packages/workflow-engine/src/actions/builtin/speckit/operations/plan.ts`, `packages/workflow-engine/src/actions/builtin/speckit/lib/templates.ts`, and `.specify/templates/agent-file-template.md` are byte-unchanged in the PR diff. Recorded in PR description.

## Dependencies & Execution Order

**Sequential within Phase 2** (single file):
- T002 → T003 → T004 → T005 all touch/read the same new file `managed-file-disjointness.test.ts`. Must run in order (T002 scaffolds, T003 and T004 add sibling `it()` blocks, T005 executes).

**Phase 1 is independent** of Phase 2:
- T001 (CLAUDE.md edit) touches a different file than the test scaffolding and can run in parallel with T002–T005. Not marked `[P]` here because the whole PR is single-agent; no coordination gain.

**Phase 3 depends on nothing in this repo**:
- T006 (companion issue) can be filed before, during, or after the code edits. It gates SC-001 (end-to-end proof), not the merge of this PR.

**Phase 4 depends on Phases 1 and 2**:
- T007 depends on T001 (needs the pointer text present).
- T008 is a static check over the full diff; runs last.

**Parallelism**: Two-agent parallel is possible (T001 || T002+T003+T004+T005), but the phase is small enough (2 files, ~1 hour total) that a single-pass single-agent walk-through is simpler and expected. No `[P]` markers applied.

**Suggested next step**: `/speckit:implement` to execute T001–T008 in order.

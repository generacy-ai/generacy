# Tasks: Update Getting-Started Docs for Cluster Base Repo Approach

**Input**: Design documents from `/specs/355-summary-update-external-facing/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, clarifications.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Research & Setup

- [X] T001 [US1,US2,US3] Read migration plan from `https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cluster-base-migration-plan.md` to extract exact git commands, `cluster-base.json` schema, fork chain details, and update workflow specifics
- [X] T002 [P] Read existing doc patterns from `docs/docs/getting-started/dev-environment.md` and `docs/docs/getting-started/project-setup.md` to match formatting conventions (admonitions, Mermaid, frontmatter, sidebar_position values)

## Phase 2: Core Content — Create cluster-setup.md

- [X] T003 [US3] Create `docs/docs/getting-started/cluster-setup.md` with Docusaurus frontmatter (`sidebar_position: 7`) and introductory section defining "cluster" in developer-facing terms
- [X] T004 [US3] Add fork chain Mermaid diagram (`graph TD`) showing `cluster-base` → `cluster-microservices` relationship, plus a "Which variant do I need?" comparison table
- [X] T005 [US1] Document new project setup workflow in `cluster-setup.md`: `git remote add cluster-base <url>` → `git merge cluster-base/main --allow-unrelated-histories`, with step-by-step instructions and expected output
- [X] T006 [US2] Document update workflow in `cluster-setup.md`: `git fetch cluster-base` → `git merge cluster-base/main`, with step-by-step instructions
- [X] T007 [US3] Document `cluster-base.json` tracking file in `cluster-setup.md` — schema, location, what each field means, when it's created/updated
- [X] T008 [US1,US2] Add troubleshooting section in `cluster-setup.md` for common merge conflicts and resolution steps

## Phase 3: Update Existing Pages

- [X] T009 [US1] Update `docs/docs/getting-started/project-setup.md` — add section describing the onboarding PR (merge commit approach, how it's triggered, what developers see), mention `cluster-base.json` as a tracked file, and cross-reference `cluster-setup.md`
- [X] T010 [P] [US1] Update `docs/docs/getting-started/dev-environment.md` — add a callout or "Next Steps" link pointing to `cluster-setup.md` for cluster configuration

## Phase 4: Verification

- [X] T011 Run `grep -r "cluster-templates" docs/docs/getting-started/` and confirm 0 results (SC-001)
- [X] T012 [P] Verify all acceptance criteria: fork chain diagram present (SC-002), update workflow documented step-by-step (SC-003), links to base repos correct (SC-004), `cluster-base.json` explained, onboarding PR described

## Dependencies & Execution Order

```
T001 ──┐
       ├──► T003 → T004 → T005 → T006 → T007 → T008  (cluster-setup.md, sequential build-up)
T002 ──┘
                                                    │
                                                    ▼
                                              T009 ─┤ (project-setup.md, needs cluster-setup.md to exist for cross-ref)
                                              T010 ─┤ (dev-environment.md, parallel with T009)
                                                    │
                                                    ▼
                                              T011 ─┤ (verification, parallel)
                                              T012 ─┘
```

**Parallel opportunities**:
- T001 and T002 can run in parallel (different sources, no dependencies)
- T009 and T010 can run in parallel (different files)
- T011 and T012 can run in parallel (independent checks)

**Sequential constraints**:
- T001 must complete before T003–T008 (migration plan provides authoritative content)
- T003–T008 are sequential within `cluster-setup.md` (each builds on prior sections)
- T009 depends on `cluster-setup.md` existing (for cross-reference links)
- T011–T012 must wait for all content changes to complete

# Clarifications: Phase-5 closeout — migration notes, per-repo config examples, rollout checklist + dogfood

## Batch 2026-08-20

### Q1: Dogfood execution scope
**Context**: FR-006/FR-007 and US5 require driving one real feature story and one real bugfix
story end-to-end through the new flow on a canary cluster (publish `@channel` packages, restart
cluster + workers, fresh Claude session, `Workflows: write` to add the CI trigger). An automated
speckit worker running in this repo cannot restart clusters or drive live stories, so it matters
whether that live run is part of this issue's deliverable PR or a separate manual operator step.
**Question**: Is the live end-to-end dogfood (FR-006/FR-007) performed *as part of this issue's PR*,
or does this issue ship only the docs + rollout checklist, with the dogfood tracked/recorded as a
manual operator step (e.g., a follow-up comment/checklist item on epic #1120)?
**Options**:
- A: This issue ships docs + checklist only; the live dogfood is a manual operator step recorded
     against epic #1120 (the PR does not block on the live run).
- B: The live dogfood must be completed and evidence linked before this issue's PR merges.
- C: Ship docs + checklist now, and add an unchecked dogfood checklist/runbook artifact in-repo that
     the operator ticks off and links to #1120 later.

**Answer**: *Pending*

### Q2: Doc file locations and structure
**Context**: FR-001–FR-005 create migration/gate/contract/rollout documentation. Assumptions point
at Docusaurus under `docs/docs/` (`guides/generacy/` for the migration guide, `reference/config/`
for config examples) and say to extend the Phase-4 `docs/docs/reference/bugfix-profile-config.md`.
Exact file paths/names for the migration guide, gate-semantics doc, contracts doc, and rollout
checklist are not pinned, which blocks knowing what files to create vs. edit.
**Question**: What is the intended file layout — one consolidated migration guide page, or separate
pages per concern (migration guide, gate semantics, contracts, rollout checklist)? And should the
rollout checklist live in the docs site or as a repo-level runbook (e.g., under `docs/` or the spec
`checklists/` dir)?
**Options**:
- A: One migration guide page under `docs/docs/guides/generacy/` covering migration + gate semantics
     + flags; a separate contracts reference page; rollout checklist as its own docs page.
- B: Separate docs pages per FR (migration, gates, contracts) + rollout checklist as its own page,
     all under the existing Docusaurus tree, extending `bugfix-profile-config.md` by link.
- C: Author owns exact filenames; just keep everything under `docs/docs/` and wire it into the
     Docusaurus sidebar/nav.

**Answer**: *Pending*

### Q3: Canary / dogfood repo identity
**Context**: US4 (canary story) and US5 (dogfood) reference a "designated canary/test repo" with the
operator holding `Workflows: write`. The rollout checklist and dogfood evidence need to name the
target repo. Without it, the checklist can only be generic.
**Question**: Which repo is the designated canary/test repo for the rollout + dogfood, and should
the checklist name it explicitly or stay repo-agnostic with a placeholder?
**Options**:
- A: Repo-agnostic checklist with a clearly-marked placeholder; the operator fills in the canary at
     run time.
- B: Name a specific canary repo (please specify which) in the checklist and dogfood evidence.

**Answer**: *Pending*

### Q4: How to document the contracts (FR-003)
**Context**: FR-003 documents the findings-artifact sidecar shape and the engine-authored review
marker, "keyed by contract name for the generacy-cloud mirror." These were defined in Phases 1–4
(#1124 findings artifact, #1125 review marker). The docs could either restate the shapes inline or
link to the shipped canonical artifacts, and it's unclear what the "contract name" key is.
**Question**: Should the contracts doc restate the sidecar/marker shapes inline (self-contained), or
link to the shipped Phase 1–4 contract files as the source of truth? And what is the canonical
"contract name" key the generacy-cloud mirror should match on?
**Options**:
- A: Restate the shapes inline in the docs (self-contained), citing the shipping issue numbers, and
     derive the contract-name key from the shipped marker string.
- B: Link to the canonical shipped contract files as source of truth; docs summarize only.
- C: Hybrid — inline summary for readers plus a link to the canonical shipped contract as the
     authoritative source.

**Answer**: *Pending*

### Q5: Docs build/validation gate
**Context**: New Markdown pages in a Docusaurus site typically need sidebar/nav wiring and may be
subject to a docs build or link-check CI gate. The spec's Out of Scope excludes code under
`packages/*/src/`, but does not state whether the docs must build/lint clean as an acceptance bar.
**Question**: Must the new docs be wired into the Docusaurus sidebar/navigation and pass the existing
docs build/link-check (if any) as an acceptance criterion, or is dropping well-formed Markdown files
into the tree sufficient for this issue?
**Options**:
- A: Docs must be wired into the sidebar/nav and pass the existing docs build/link-check gate.
- B: Well-formed Markdown files in the correct location are sufficient; nav wiring is best-effort.

**Answer**: *Pending*

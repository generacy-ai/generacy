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

**Answer**: C — ship docs + checklist now AND add an unchecked in-repo dogfood checklist/runbook
artifact that the operator ticks off and links to epic #1120 later. The PR does not block on the
live run. An automated speckit worker in this repo structurally cannot restart clusters or drive
live stories, so B would deadlock the PR; A drops the evidence artifact. C ships the P1 docs
(FR-001–FR-005) as the mergeable deliverable while preserving FR-006/FR-007 as a committed runbook.

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

**Answer**: A — one migration guide page under `docs/docs/guides/generacy/` (covering migration +
gate semantics + flags), a separate contracts reference page under `docs/docs/reference/` (next to
`bugfix-profile-config.md`), and the rollout checklist as its own docs page. Extend
`bugfix-profile-config.md` by link rather than duplicating it. Consolidates coupled operator
concerns (US1 migration + US2 gate semantics) into one narrative; puts the integrator contract
(US3) on a reference page.

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

**Answer**: A — repo-agnostic checklist with a clearly-marked placeholder the operator fills in at
run time. The spec never names a canary; canary identity is a runtime/operator decision, so the
worker has no grounded basis to hard-code a repo. Keeps the checklist reusable, consistent with the
Q1-C model where the operator supplies live-run specifics.

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

**Answer**: C — hybrid: inline summary of the sidecar/marker shapes for readers PLUS a link to the
canonical shipped contract files as the authoritative source. Canonical sidecar contract is
`ReviewArtifactSchema` in `packages/orchestrator/src/worker/review-artifact.ts` (Zod; path
`.generacy/review-findings-<sanitized-workflowId>.json`; severity `critical|major|minor`, status
`open|resolved`, verdict `clean|changes-required`, `round`, `remediationCount`; #1124). Engine
review marker contract is `packages/orchestrator/src/worker/review-poster.ts`: body marker
`<!-- generacy-engine-review round=<N> -->` (prefix `generacy-engine-review`) and inline
`<!-- generacy-finding:<marker> -->`. The canonical "contract name" key the generacy-cloud mirror
matches on is the marker string `generacy-engine-review` (body) / `generacy-finding:` (inline).
FR-008 makes shipped code authoritative, so inline-only (A) drifts and link-only (B) fails US3's
readability goal.

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

**Answer**: A — wire the new pages into `docs/sidebars.ts`/nav and ensure a clean Docusaurus build;
treat that build (not a per-PR CI job) as the acceptance gate. Also retroactively wire the Phase-4
`docs/docs/reference/bugfix-profile-config.md` (currently orphaned/unwired) into the sidebar. There
is no docs build/link-check job in CI (docs/ is not in `pnpm-workspace.yaml`), but `sidebars.ts` is
a manually curated list and with `docusaurus.config` `onBrokenLinks:'throw'` the enforcing gate is
the local/deploy Docusaurus build. Option B reproduces the orphaned-page defect that defeats the
epic's premise that docs make the flow reachable.

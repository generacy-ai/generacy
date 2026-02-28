# Tasks: Architecture Overview for Adopters

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Preparation — Read & Extract Source Material

### T001 [DONE] Read and catalog existing overview content
**File**: `docs/docs/architecture/overview.md`
- Read the full 311-line existing overview
- Identify content to preserve for internals page (Redis, BullMQ, PostgreSQL, deployment topology, design decisions)
- Identify content to simplify/adapt for the new adopter-focused overview (Triad description, high-level diagrams)
- Note all internal cross-references (links to contracts, security, other docs)

### T002 [DONE] [P] Extract adopter-relevant labels from label protocol
**File**: `/workspaces/tetrad-development/docs/label-protocol.md`
- Catalog all trigger labels (`process:*`)
- Catalog all completion labels (`completed:*`)
- Catalog all waiting labels (`waiting-for:*`)
- Catalog status labels (`agent:in-progress`, `agent:error`)
- Separate adopter-relevant labels from system-internal labels
- Note the lifecycle pattern: trigger → process → waiting → completed → resume

### T003 [DONE] [P] Extract workflow structure from speckit-feature.yaml
**File**: `workflows/speckit-feature.yaml`
- Map the 7-phase structure (setup, specify, clarify, plan, tasks, implement, verify)
- Identify a minimal 2-3 phase excerpt suitable for the customization section
- Document the YAML structure: `name`, `phases[]`, `steps[]`, `uses`, `with`
- Note built-in action namespaces (`speckit.*`, `verification.*`, `github.*`, `workflow.*`)

### T004 [DONE] [P] Extract stage comment and phase resolver patterns
**Files**:
- `packages/orchestrator/src/worker/stage-comment-manager.ts`
- `packages/orchestrator/src/worker/phase-resolver.ts`
- From stage-comment-manager: how progress comments appear on issues (markdown table, status emojis, timestamps)
- From phase-resolver: gate-to-phase mapping for each review cycle type
- Distill into adopter-friendly descriptions (what they see, not how it works internally)

### T005 [DONE] [P] Review intro page and sidebar for consistency
**Files**:
- `docs/docs/intro.md`
- `docs/sidebars.ts`
- Note the progressive adoption levels (1-4) referenced in intro
- Confirm sidebar structure for Architecture category (lines 103-115)
- Identify where `architecture/internals` should be inserted in sidebar

---

## Phase 2: Create Architecture Internals Page

### T006 [DONE] Create internals.md with frontmatter and introduction
**File**: `docs/docs/architecture/internals.md`
- Add frontmatter with `sidebar_position: 4`
- Write introductory note linking back to adopter overview: "Looking for a high-level understanding? See the Architecture Overview"
- Add page title and brief description of the page's purpose (internal architecture details for contributors/operators)

### T007 [DONE] Move infrastructure details to internals.md
**File**: `docs/docs/architecture/internals.md`
- Move Redis + BullMQ queue architecture content from existing overview
- Move PostgreSQL state management details
- Move message flow / communication channels diagrams
- Adapt Mermaid diagrams to fit the new context (update cross-references)

### T008 [DONE] Move deployment architecture to internals.md
**File**: `docs/docs/architecture/internals.md`
- Move deployment architecture diagrams (local Level 1-3, cloud Level 4)
- Move worker pool configuration details
- Preserve the progressive complexity narrative

### T009 [DONE] Move design decisions to internals.md
**File**: `docs/docs/architecture/internals.md`
- Move key design decisions section (why Redis, why PostgreSQL, why MCP)
- Add cross-references to relevant docs (contracts, security)
- Add "Next Steps" footer linking to overview, contracts, and security pages

---

## Phase 3: Rewrite Architecture Overview

### T010 [DONE] Write overview introduction (Section 1)
**File**: `docs/docs/architecture/overview.md`
- Replace existing frontmatter (keep `sidebar_position: 1`)
- Write one-liner scoping to orchestrated workflow (Level 3+)
- Add link to getting-started docs for simpler setups (Level 1-2)
- List what readers will learn (components, labels, review cycles, customization)
- Target: ~20 lines

### T011 [DONE] Create high-level architecture diagram (Section 2)
**File**: `docs/docs/architecture/overview.md`
- Design simplified Mermaid diagram: GitHub (issues + PRs) ↔ Orchestrator ↔ Worker ↔ AI Agent
- Show labels as the communication mechanism between GitHub and Orchestrator
- Show review gates as pause points in the flow
- Omit internal details: Redis, PostgreSQL, BullMQ, S3, load balancers
- Add brief prose explaining each component's role
- Target: ~40 lines

### T012 [DONE] Write workflow lifecycle walkthrough (Section 3)
**File**: `docs/docs/architecture/overview.md`
- Write conversational walkthrough of speckit-feature flow:
  1. Label an issue → orchestrator picks it up
  2. Agent generates specification → creates draft PR
  3. Agent posts clarification questions → workflow pauses
  4. You answer → workflow resumes
  5. Agent plans, generates tasks, implements
  6. PR marked ready for review → you review
  7. Agent addresses feedback if needed
- Include stage comments explanation: progress appears as structured comments on the issue, updated automatically as phases complete (reference stage-comment-manager patterns from T004)
- Target: ~80 lines

### T013 [DONE] Write label protocol section (Section 4)
**File**: `docs/docs/architecture/overview.md`
- Create "Labels you add" table: trigger labels (`process:speckit-feature`, `process:speckit-bugfix`), completion signals (`completed:clarification`, `completed:spec-review`, etc.)
- Create "Labels you'll observe" table: status indicators (`agent:in-progress`, `agent:error`, `waiting-for:*`)
- Write brief explanation of the label lifecycle pattern: trigger → process → waiting → completed → resume
- Use adopter-relevant labels only (omit system-internal labels per plan decision Q4)
- Target: ~60 lines

### T014 [DONE] Write clarification and review cycles section (Section 5)
**File**: `docs/docs/architecture/overview.md`
- Write unified pattern explanation: system pauses → posts comment → you review → signal via label → system resumes
- Document each review type with its label pair:
  - Clarification (`waiting-for:clarification` / `completed:clarification`)
  - Spec review (`waiting-for:spec-review` / `completed:spec-review`)
  - Plan review (`waiting-for:plan-review` / `completed:plan-review`)
  - Tasks review (`waiting-for:tasks-review` / `completed:tasks-review`)
  - PR feedback (`waiting-for:address-pr-feedback`) — auto-addressed
- Reference gate-to-phase mapping from T004 for accuracy
- Target: ~60 lines

### T015 [DONE] Write customizing workflows section (Section 6)
**File**: `docs/docs/architecture/overview.md`
- Include real minimal YAML excerpt from `speckit-feature.yaml` (2-3 phases, per T003 extraction)
- Add note: "Simplified for illustration — see actual workflow files for the full definition"
- Explain YAML structure: `name`, `phases[]`, `steps[]`, `uses` (action reference), `with` (inputs using `${{ }}` interpolation)
- List built-in action namespaces (without full parameter docs):
  - `speckit.*` — specification, clarification, planning, tasks, implementation
  - `verification.*` — test and lint checking
  - `github.*` — label management, PR operations
  - `workflow.*` — gate checking, flow control
- Link to future workflow authoring guide
- Target: ~60 lines

### T016 [DONE] Write configuration essentials section (Section 7)
**File**: `docs/docs/architecture/overview.md`
- Cover minimal setup only:
  - GitHub webhook URL and required events (concept-level, not step-by-step)
  - Watched repositories YAML snippet
  - API token / GitHub App credentials (mention, don't detail)
- Add "Learn more" link to existing config reference (`/docs/reference/config/generacy`)
- Target: ~30 lines

### T017 [DONE] Write error handling section (Section 8)
**File**: `docs/docs/architecture/overview.md`
- Explain `agent:error` label meaning and error comment format
- Document retry procedure: remove error label, re-add trigger label
- Cover common scenarios with actionable guidance:
  - Timeout: retry or break into smaller pieces
  - Context overflow: simplify requirements or split into epic
  - Test failures: review errors, fix manually or retry
  - Merge conflicts: resolve conflicts and retry
- Target: ~40 lines

### T018 [DONE] Write glossary and next steps sections (Sections 9-10)
**File**: `docs/docs/architecture/overview.md`
- Create glossary table with definitions: Orchestrator, Worker, Phase, Gate, Stage Comment, Workflow, Action
- Write next steps with links to: Getting Started, Workflow Authoring Guide, Configuration Reference, Architecture Internals
- Target: ~30 lines combined

---

## Phase 4: Sidebar Update

### T019 [DONE] Add internals entry to sidebar
**File**: `docs/sidebars.ts`
- Add `'architecture/internals'` to the Architecture category items array (after `'architecture/overview'`)
- Resulting order: overview, internals, contracts, security

---

## Phase 5: Verification

### T020 [DONE] Validate Mermaid diagram syntax
**Files**:
- `docs/docs/architecture/overview.md`
- `docs/docs/architecture/internals.md`
- Verify all Mermaid code blocks use valid syntax
- Check diagram renders correctly in Docusaurus dev server (start with `pnpm --filter docs dev`)
- Confirm both light and dark theme rendering (configured in `docusaurus.config.ts`)

### T021 [DONE] [P] Validate internal links
**Files**:
- `docs/docs/architecture/overview.md`
- `docs/docs/architecture/internals.md`
- Check all markdown links resolve to valid targets
- Verify cross-references between overview and internals
- Verify links to external docs (getting-started, config reference, contracts, security)
- Confirm no broken links from content moved out of the old overview

### T022 [DONE] [P] Validate sidebar renders correctly
**File**: `docs/sidebars.ts`
- Start Docusaurus dev server
- Navigate to Architecture section
- Confirm all four pages appear in correct order: Overview, Internals, Contracts, Security
- Confirm page navigation (previous/next) works between pages

### T023 [DONE] Self-containment review
**Files**:
- `docs/docs/architecture/overview.md`
- Read the overview end-to-end without clicking any links
- Verify an adopter can understand how the system works from this document alone
- Confirm the overview does not reference internal details (Redis, BullMQ, PostgreSQL, etc.)
- Verify the hybrid tone: conversational for walkthroughs, reference-style for tables
- Check total line count is approximately ~400 lines (not excessively long)

### T024 [DONE] Cross-reference consistency check
**Files**:
- `docs/docs/architecture/overview.md`
- `docs/docs/architecture/internals.md`
- `docs/docs/intro.md`
- Verify terminology consistency across all three documents
- Confirm the overview and intro don't contradict each other on component descriptions
- Verify internals page doesn't duplicate adopter-level content from overview

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (Preparation) must complete before Phases 2 and 3
- Phase 2 (Internals) and Phase 3 (Overview) can run in parallel after Phase 1
- Phase 4 (Sidebar) can run in parallel with Phases 2 and 3
- Phase 5 (Verification) must wait for Phases 2, 3, and 4 to complete

**Parallel opportunities within phases**:
- Phase 1: T002, T003, T004, T005 can all run in parallel (independent source reads)
- Phase 2: T007, T008, T009 are sequential (all write to the same file, building on T006)
- Phase 3: T010 must come first (sets up the file), then T011-T018 are sequential (single file, ordered sections)
- Phase 4: T019 is independent of Phase 2/3 content
- Phase 5: T021 and T022 can run in parallel; T020 and T023 can run in parallel

**Critical path**:
T001 → T006 → T007 → T008 → T009 (internals complete)
T001 → T010 → T011 → T012 → T013 → T014 → T015 → T016 → T017 → T018 (overview complete)
T019 (sidebar, parallel with above)
→ T020 → T021/T022 → T023 → T024 (verification)

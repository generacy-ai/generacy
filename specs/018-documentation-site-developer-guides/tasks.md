# Tasks: Documentation site and developer guides

**Input**: Design documents from `/specs/018-documentation-site-developer-guides/`
**Prerequisites**: plan.md (required), spec.md (required), research.md (available)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Project Setup

- [X] T001 Initialize Docusaurus 3.x project in `docs/` directory with TypeScript support
- [X] T002 [P] Configure `docs/package.json` with required dependencies (@docusaurus/core, @docusaurus/preset-classic, @docusaurus/theme-mermaid)
- [X] T003 [P] Create `docs/tsconfig.json` with appropriate TypeScript configuration
- [X] T004 Configure `docs/docusaurus.config.ts` with site metadata, theme, and Mermaid plugin
- [X] T005 Configure `docs/sidebars.ts` with initial navigation structure
- [X] T006 [P] Create `docs/static/img/` directory with logo.svg and favicon.ico placeholders
- [X] T007 [P] Create `docs/src/css/custom.css` with basic theme customizations
- [X] T008 Create `.github/workflows/docs.yml` for GitHub Pages deployment via GitHub Actions
- [X] T009 Configure GitHub repository settings for GitHub Pages (gh-pages branch or Actions) [manual]

---

## Phase 2: Getting Started Guides (MVP)

- [X] T010 [US1] Create `docs/docs/intro.md` - Introduction and landing page content
- [X] T011 [US1] Create `docs/docs/getting-started/_category_.json` with category metadata
- [X] T012 [US1] Create `docs/docs/getting-started/quick-start.md` - 5-minute quick start guide
- [X] T013 [US1] Create `docs/docs/getting-started/installation.md` - Detailed installation guide
- [X] T014 [US1] Create `docs/docs/getting-started/level-1-agency-only.md` - Agency-only setup guide
- [X] T015 [US1] Create `docs/docs/getting-started/level-2-agency-humancy.md` - Agency + Humancy integration guide
- [X] T016 [P] Create `docs/src/pages/index.tsx` - Custom landing page with adoption level cards
- [X] T017 [P] Create `docs/src/components/AdoptionLevel/index.tsx` - Adoption level card component

---

## Phase 3: Component Guides

- [X] T018 Create `docs/docs/guides/_category_.json` with guides category metadata
- [X] T019 [P] Create `docs/docs/guides/agency/overview.md` - Agency component overview
- [X] T020 [P] Create `docs/docs/guides/agency/configuration.md` - Agency configuration reference
- [X] T021 [P] Create `docs/docs/guides/humancy/overview.md` - Humancy component overview
- [X] T022 [P] Create `docs/docs/guides/humancy/configuration.md` - Humancy configuration reference
- [X] T023 [P] Create `docs/docs/guides/generacy/overview.md` - Generacy component overview
- [X] T024 [P] Create `docs/docs/guides/generacy/configuration.md` - Generacy configuration reference

---

## Phase 4: API Reference Integration

- [X] T025 [US3] Install and configure `docusaurus-plugin-typedoc` in docs/package.json
- [X] T026 [US3] Create TypeDoc configuration in `docs/typedoc.json` pointing to npm package entry points
- [X] T027 [US3] Create `docs/api/.gitkeep` directory for TypeDoc generated output
- [X] T028 [US3] Create `docs/docs/reference/_category_.json` with reference category metadata
- [X] T029 [US3] Create `docs/docs/reference/api/index.md` - API reference landing page
- [X] T030 [US3] Create `docs/static/api/orchestrator.yaml` - OpenAPI spec for orchestrator REST API
- [X] T031 [US3] Configure OpenAPI rendering in docusaurus.config.ts or create reference page

---

## Phase 5: Plugin Development Guides

- [X] T032 [US2] Create `docs/docs/plugins/_category_.json` with plugins category metadata
- [X] T033 [US2] Create `docs/docs/plugins/developing-plugins.md` - Plugin development overview
- [X] T034 [US2] Create `docs/docs/plugins/agency-plugins.md` - Agency plugin tutorial
- [X] T035 [US2] Create `docs/docs/plugins/humancy-plugins.md` - Humancy plugin tutorial
- [X] T036 [US2] Create `docs/docs/plugins/generacy-plugins.md` - Generacy plugin tutorial
- [X] T037 [US2] Create `docs/docs/plugins/manifest-reference.md` - Plugin manifest reference

---

## Phase 6: Configuration Reference

- [X] T038 Create `docs/docs/reference/config/agency.md` - Agency configuration options reference
- [X] T039 [P] Create `docs/docs/reference/config/humancy.md` - Humancy configuration options reference
- [X] T040 [P] Create `docs/docs/reference/config/generacy.md` - Generacy configuration options reference
- [X] T041 Create `docs/docs/reference/cli/commands.md` - CLI command reference

---

## Phase 7: Architecture Documentation

- [X] T042 Create `docs/docs/architecture/_category_.json` with architecture category metadata
- [X] T043 Create `docs/docs/architecture/overview.md` - System overview with Mermaid diagrams
- [X] T044 [P] Create `docs/docs/architecture/contracts.md` - Contract schemas documentation
- [X] T045 [P] Create `docs/docs/architecture/security.md` - Security model documentation
- [X] T046 [P] Create SVG diagram for The Triad overview (exported to `docs/static/img/diagrams/triad-overview.svg`)
- [X] T047 [P] Create SVG diagram for adoption path (exported to `docs/static/img/diagrams/adoption-path.svg`)
- [X] T048 Create `docs/src/components/DiagramEmbed/index.tsx` - Diagram embed component

---

## Phase 8: Testing & Polish

- [X] T049 Verify documentation site builds successfully with `npm run build`
- [ ] T050 Test GitHub Pages deployment workflow [manual]
- [ ] T051 Validate Quick Start guide completion time < 5 minutes [manual]
- [ ] T052 Run accessibility audit for WCAG 2.1 AA compliance [manual]
- [X] T053 Verify all internal links and navigation work correctly
- [X] T054 Update sidebar configuration with final navigation structure

---

## Dependencies & Execution Order

### Sequential Dependencies
- T001 (Docusaurus init) must complete before T002-T009
- T004 (config) must complete before T025 (TypeDoc config)
- T008 (workflow) must complete before T050 (deployment test)

### Phase Dependencies
- Phase 1 must complete before Phases 2-7 can begin
- Phase 2 should complete before Phase 8 testing
- Phase 4 (API Reference) requires existing TypeScript source with JSDoc comments

### Parallel Opportunities
- T002, T003, T006, T007 can run in parallel after T001
- T016, T017 can run in parallel with T010-T015
- T019-T024 (component guides) can all run in parallel
- T044-T047 (architecture docs) can run in parallel after T042

### User Story Mapping
- US1 (New Developer Onboarding): T010-T017
- US2 (Plugin Developer): T032-T037
- US3 (Integration Developer): T025-T031

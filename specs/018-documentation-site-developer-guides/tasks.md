# Tasks: Documentation site and developer guides

**Input**: Design documents from `/specs/018-documentation-site-developer-guides/`
**Prerequisites**: plan.md (required), spec.md (required), research.md (available)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Project Setup

- [ ] T001 Initialize Docusaurus 3.x project in `docs/` directory with TypeScript support
- [ ] T002 [P] Configure `docs/package.json` with required dependencies (@docusaurus/core, @docusaurus/preset-classic, @docusaurus/theme-mermaid)
- [ ] T003 [P] Create `docs/tsconfig.json` with appropriate TypeScript configuration
- [ ] T004 Configure `docs/docusaurus.config.ts` with site metadata, theme, and Mermaid plugin
- [ ] T005 Configure `docs/sidebars.ts` with initial navigation structure
- [ ] T006 [P] Create `docs/static/img/` directory with logo.svg and favicon.ico placeholders
- [ ] T007 [P] Create `docs/src/css/custom.css` with basic theme customizations
- [ ] T008 Create `.github/workflows/docs.yml` for GitHub Pages deployment via GitHub Actions
- [ ] T009 Configure GitHub repository settings for GitHub Pages (gh-pages branch or Actions)

---

## Phase 2: Getting Started Guides (MVP)

- [ ] T010 [US1] Create `docs/docs/intro.md` - Introduction and landing page content
- [ ] T011 [US1] Create `docs/docs/getting-started/_category_.json` with category metadata
- [ ] T012 [US1] Create `docs/docs/getting-started/quick-start.md` - 5-minute quick start guide
- [ ] T013 [US1] Create `docs/docs/getting-started/installation.md` - Detailed installation guide
- [ ] T014 [US1] Create `docs/docs/getting-started/level-1-agency-only.md` - Agency-only setup guide
- [ ] T015 [US1] Create `docs/docs/getting-started/level-2-agency-humancy.md` - Agency + Humancy integration guide
- [ ] T016 [P] Create `docs/src/pages/index.tsx` - Custom landing page with adoption level cards
- [ ] T017 [P] Create `docs/src/components/AdoptionLevel/index.tsx` - Adoption level card component

---

## Phase 3: Component Guides

- [ ] T018 Create `docs/docs/guides/_category_.json` with guides category metadata
- [ ] T019 [P] Create `docs/docs/guides/agency/overview.md` - Agency component overview
- [ ] T020 [P] Create `docs/docs/guides/agency/configuration.md` - Agency configuration reference
- [ ] T021 [P] Create `docs/docs/guides/humancy/overview.md` - Humancy component overview
- [ ] T022 [P] Create `docs/docs/guides/humancy/configuration.md` - Humancy configuration reference
- [ ] T023 [P] Create `docs/docs/guides/generacy/overview.md` - Generacy component overview
- [ ] T024 [P] Create `docs/docs/guides/generacy/configuration.md` - Generacy configuration reference

---

## Phase 4: API Reference Integration

- [ ] T025 [US3] Install and configure `docusaurus-plugin-typedoc` in docs/package.json
- [ ] T026 [US3] Create TypeDoc configuration in `docs/typedoc.json` pointing to npm package entry points
- [ ] T027 [US3] Create `docs/api/.gitkeep` directory for TypeDoc generated output
- [ ] T028 [US3] Create `docs/docs/reference/_category_.json` with reference category metadata
- [ ] T029 [US3] Create `docs/docs/reference/api/index.md` - API reference landing page
- [ ] T030 [US3] Create `docs/static/api/orchestrator.yaml` - OpenAPI spec for orchestrator REST API
- [ ] T031 [US3] Configure OpenAPI rendering in docusaurus.config.ts or create reference page

---

## Phase 5: Plugin Development Guides

- [ ] T032 [US2] Create `docs/docs/plugins/_category_.json` with plugins category metadata
- [ ] T033 [US2] Create `docs/docs/plugins/developing-plugins.md` - Plugin development overview
- [ ] T034 [US2] Create `docs/docs/plugins/agency-plugins.md` - Agency plugin tutorial
- [ ] T035 [US2] Create `docs/docs/plugins/humancy-plugins.md` - Humancy plugin tutorial
- [ ] T036 [US2] Create `docs/docs/plugins/generacy-plugins.md` - Generacy plugin tutorial
- [ ] T037 [US2] Create `docs/docs/plugins/manifest-reference.md` - Plugin manifest reference

---

## Phase 6: Configuration Reference

- [ ] T038 Create `docs/docs/reference/config/agency.md` - Agency configuration options reference
- [ ] T039 [P] Create `docs/docs/reference/config/humancy.md` - Humancy configuration options reference
- [ ] T040 [P] Create `docs/docs/reference/config/generacy.md` - Generacy configuration options reference
- [ ] T041 Create `docs/docs/reference/cli/commands.md` - CLI command reference

---

## Phase 7: Architecture Documentation

- [ ] T042 Create `docs/docs/architecture/_category_.json` with architecture category metadata
- [ ] T043 Create `docs/docs/architecture/overview.md` - System overview with Mermaid diagrams
- [ ] T044 [P] Create `docs/docs/architecture/contracts.md` - Contract schemas documentation
- [ ] T045 [P] Create `docs/docs/architecture/security.md` - Security model documentation
- [ ] T046 [P] Create Excalidraw diagram for The Triad overview (export to `docs/static/img/diagrams/triad-overview.png`)
- [ ] T047 [P] Create Excalidraw diagram for adoption path (export to `docs/static/img/diagrams/adoption-path.png`)
- [ ] T048 Create `docs/src/components/DiagramEmbed/index.tsx` - Excalidraw diagram embed component

---

## Phase 8: Testing & Polish

- [ ] T049 Verify documentation site builds successfully with `npm run build`
- [ ] T050 Test GitHub Pages deployment workflow
- [ ] T051 Validate Quick Start guide completion time < 5 minutes
- [ ] T052 Run accessibility audit for WCAG 2.1 AA compliance
- [ ] T053 Verify all internal links and navigation work correctly
- [ ] T054 Update sidebar configuration with final navigation structure

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

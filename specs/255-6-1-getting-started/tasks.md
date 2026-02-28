# Tasks: 6.1 — Getting Started Guide

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
- **[US1]**: New developer can follow the guide and have a working setup

---

## Phase 1: Hub Page and Structure Setup

Sets up the navigation skeleton. All subsequent phases depend on the sidebar and category config being in place.

### T001 [US1] Create hub page `index.md`
**File**: `docs/docs/getting-started/index.md`
- Write welcome paragraph explaining what Generacy is (source from `docs/docs/intro.md`)
- Add "What you'll set up" bulleted overview
- Add progressive adoption level summary table (Levels 1-4, one line each, sourced from `intro.md` adoption table)
- Add recommended path callout: "Start with Level 1"
- Add ordered navigation links to each sub-page (prerequisites → installation → authentication → project-setup → configuration → dev-environment → verify-setup → first-workflow → adoption-levels)
- Add time estimate: "~15-30 minutes for Level 1 setup"
- Add frontmatter: `sidebar_position: 0`, `slug: /docs/getting-started`

### T002 [P] [US1] Update `_category_.json`
**File**: `docs/docs/getting-started/_category_.json`
- Change `link.type` from `generated-index` to `doc`
- Set `link.id` to `getting-started/index`
- Remove `link.description` (hub page provides its own description)

### T003 [P] [US1] Update `sidebars.ts`
**File**: `docs/sidebars.ts`
- Replace the Getting Started category `link` from `generated-index` to `{ type: 'doc', id: 'getting-started/index' }`
- Replace `items` array with new page order:
  ```
  getting-started/prerequisites
  getting-started/installation
  getting-started/authentication
  getting-started/project-setup
  getting-started/configuration
  getting-started/dev-environment
  getting-started/verify-setup
  getting-started/first-workflow
  getting-started/adoption-levels
  getting-started/troubleshooting
  getting-started/multi-repo
  ```
- Keep `collapsed: false`

### T004 [US1] Verify Phase 1 build
**Command**: `cd docs && pnpm build`
- Expect build failure for missing pages — confirm only "broken link" errors for pages not yet created
- Validates sidebar config and index.md are wired correctly

---

## Phase 2: Prerequisites and Installation

Foundational setup pages. Can be written in parallel since they reference different source material.

### T005 [P] [US1] Create `prerequisites.md`
**File**: `docs/docs/getting-started/prerequisites.md`
- Add frontmatter with `sidebar_position: 1`
- System requirements table (absorb from existing `installation.md` lines 18-30):
  - Node.js 18+, npm 9+, Git 2.x+, Docker Desktop (optional for Level 1)
  - RAM: 4GB+, Disk: 500MB+
- OS-specific notes section (macOS, Linux, Windows/WSL2)
- Required accounts subsection: GitHub account, Anthropic account
- Optional tools subsection: VS Code, Docker Desktop
- Source: existing `installation.md` system requirements + `packages/generacy/src/cli/commands/init/` types

### T006 [P] [US1] Rewrite `installation.md`
**File**: `docs/docs/getting-started/installation.md`
- Replace all existing content (currently ~180 lines covering system requirements + install + init + verify)
- Update frontmatter: keep `sidebar_position: 2`
- Section 1: Install Generacy CLI — `npm install -g @generacy-ai/generacy` with verify step
- Section 2: Install Docker Desktop — link to docker.com, note it's optional for Level 1
- Section 3: Install VS Code + Generacy extension — text description with `<!-- Screenshot placeholder: VS Code extension install -->` comment
- Section 4: Alternative install methods — collapsed `<details>` for pnpm and from-source
- Remove content absorbed into `prerequisites.md` (system requirements) and `project-setup.md` (init walkthrough)

---

## Phase 3: Authentication and Project Setup

Credential and project initialization pages. Can be written in parallel.

### T007 [P] [US1] Create `authentication.md`
**File**: `docs/docs/getting-started/authentication.md`
- Add frontmatter with `sidebar_position: 3`
- Credentials overview table: credential name, where to get it, which adoption levels need it
- **GitHub PAT** section: step-by-step creation, required scopes (`repo`, `workflow`), source from `packages/generacy/src/cli/commands/init/github.ts`
- **Anthropic API key** section: step-by-step creation at console.anthropic.com
- **OAuth sign-in** section: text description of generacy.ai web login flow, `<!-- Screenshot placeholder: OAuth sign-in flow -->`
- **Store credentials securely** callout: mention `.generacy/generacy.env` is gitignored

### T008 [P] [US1] Create `project-setup.md`
**File**: `docs/docs/getting-started/project-setup.md`
- Add frontmatter with `sidebar_position: 4`
- Step 1: Navigate to project root (`cd your-project`)
- Step 2: Run `generacy init --yes` (happy path)
- Step 3: Show expected output — source from `packages/generacy/src/cli/commands/init/summary.ts` output format
- Step 4: Explain what was created (`.generacy/` directory contents: `config.yaml`, `generacy.env`, `generacy.env.template`, etc.)
- Link to CLI reference for advanced `generacy init` flags
- Absorb relevant content from existing `quick-start.md` init section (lines ~35-65)

---

## Phase 4: Configuration and Environment

Config and dev container pages. Can be written in parallel.

### T009 [P] [US1] Create `configuration.md`
**File**: `docs/docs/getting-started/configuration.md`
- Add frontmatter with `sidebar_position: 5`
- `.generacy/config.yaml` overview with 4 main blocks (1-2 sentences each):
  - `project` — unique ID and display name
  - `repos` — primary, dev, and clone repositories
  - `defaults` — agent and base branch
  - `orchestrator` — polling and worker settings
- Inline example config — source from `packages/generacy/examples/config-single-repo.yaml`
- Link to full config reference: `packages/generacy/src/config/README.md` (or docs site equivalent)
- `.generacy/generacy.env` setup section:
  - Copy template: `cp .generacy/generacy.env.template .generacy/generacy.env`
  - Set `GITHUB_TOKEN` and `ANTHROPIC_API_KEY`
  - Callout: file is gitignored, never commit
  - Source variable names from `packages/templates/src/shared/generacy.env.template.hbs`
- Link to full env reference for advanced variables

### T010 [P] [US1] Create `dev-environment.md`
**File**: `docs/docs/getting-started/dev-environment.md`
- Add frontmatter with `sidebar_position: 6`
- What the dev container provides (pre-configured Node.js, Docker-in-Docker, extensions)
- Starting Docker Compose — commands and expected output
- Opening in VS Code dev container — text walkthrough
- Connecting to the dev container
- Verifying container is running
- Source from templates package (devcontainer, docker-compose templates)

---

## Phase 5: Verification and First Workflow

Setup validation and first-use pages. Can be written in parallel.

### T011 [P] [US1] Create `verify-setup.md`
**File**: `docs/docs/getting-started/verify-setup.md`
- Add frontmatter with `sidebar_position: 7`
- **Level 1 (config-only)** section:
  - Run `generacy validate` — verify config.yaml is valid
  - Run `generacy doctor` — comprehensive environment check
  - Show expected output for passing checks (source from `packages/generacy/src/cli/commands/doctor.ts` and `validate.ts`)
  - What to do if checks fail → link to troubleshooting page
- **Level 2+ (workflow submission)** section:
  - Submit a minimal test workflow
  - Verify it appears on dashboard — text description, `<!-- Screenshot placeholder: dashboard -->`

### T012 [P] [US1] Create `first-workflow.md`
**File**: `docs/docs/getting-started/first-workflow.md`
- Add frontmatter with `sidebar_position: 8`
- Configure AI agent MCP settings — Claude Code example (absorb from existing `quick-start.md` MCP config section, lines ~67-90)
- Ask the agent to use Generacy tools — example prompts
- What success looks like — expected tool responses
- Next steps links

---

## Phase 6: Adoption Levels, Troubleshooting, and Stubs

Adoption guide and troubleshooting. Adoption levels absorbs existing content. All four files in this phase can be written in parallel.

### T013 [P] [US1] Create `adoption-levels.md`
**File**: `docs/docs/getting-started/adoption-levels.md`
- Add frontmatter with `sidebar_position: 9`
- Overview table: Level 1-4 with columns for components, capabilities, complexity
- **Level 1: Agency Only** — Full inline walkthrough:
  - Absorb all content from existing `level-1-agency-only.md`
  - What it provides (custom tools, context providers, local plugins)
  - Architecture diagram (Mermaid — copy from existing)
  - MCP configuration example
  - Built-in tools table
  - Best practices section
- **Level 2: Agency + Humancy** — Summary + link:
  - Absorb summary from existing `level-2-agency-humancy.md`
  - Architecture diagram (Mermaid — copy from existing)
  - Link to Level 2 detailed guide (`/docs/guides/humancy/overview`)
- **Level 3: Local Orchestration** — Summary paragraph + link to stub
- **Level 4: Cloud** — Summary paragraph + link to stub

### T014 [P] [US1] Create `troubleshooting.md`
**File**: `docs/docs/getting-started/troubleshooting.md`
- Add frontmatter with `sidebar_position: 10`
- Format: **Symptom** → **Cause** → **Resolution** for each issue
- 8+ issues to document:
  1. `generacy` command not found — PATH issue, npm global bin not in PATH
  2. `generacy init` fails — not in a git repository
  3. Config validation errors — invalid project ID format, missing required fields (source from `validate.ts`)
  4. GitHub token invalid or insufficient scopes (source from `init/github.ts`)
  5. Anthropic API key not set or invalid
  6. MCP connection issues — agent can't connect to Agency (source from existing `level-1-agency-only.md` troubleshooting)
  7. Docker not running / container issues
  8. Port conflicts — Redis, dev server
- Absorb troubleshooting sections from existing `quick-start.md`, `level-1-agency-only.md`, `level-2-agency-humancy.md`
- "Still stuck?" section with links to GitHub issues and community

### T015 [P] [US1] Create stub `level-3-local-orchestration.md`
**File**: `docs/docs/getting-started/level-3-local-orchestration.md`
- Frontmatter with title "Level 3: Local Orchestration"
- Brief description of what Level 3 provides
- Admonition: "This guide is coming soon"
- Link back to adoption levels overview

### T016 [P] [US1] Create stub `level-4-cloud.md`
**File**: `docs/docs/getting-started/level-4-cloud.md`
- Frontmatter with title "Level 4: Cloud"
- Brief description of what Level 4 provides
- Admonition: "This guide is coming soon"
- Link back to adoption levels overview

---

## Phase 7: Multi-Repo Appendix

### T017 [US1] Create `multi-repo.md`
**File**: `docs/docs/getting-started/multi-repo.md`
- Add frontmatter with `sidebar_position: 11`
- When to use multi-repo vs single-repo — decision criteria
- Differences in `generacy init` — dev repos, clone repos
- Config differences — inline example from `packages/generacy/examples/config-multi-repo.yaml`
- Additional env variables: `POLL_INTERVAL_MS`, `WORKER_TIMEOUT_SECONDS` (source from `generacy.env.template.hbs`)
- Orchestrator considerations

---

## Phase 8: Redirects and Cleanup

Replace old pages with redirect notices. All three can be done in parallel.

### T018 [P] [US1] Replace `quick-start.md` with redirect
**File**: `docs/docs/getting-started/quick-start.md`
- Replace all content with redirect page
- Keep frontmatter `slug` to preserve URL
- Add notice: "This page has moved" with link to new hub page (`./index.md`)
- Add `sidebar_class_name: hidden` or remove from sidebar (already removed in T003)
- Ensure the page is NOT listed in `sidebars.ts` (confirmed removed in T003)

### T019 [P] [US1] Replace `level-1-agency-only.md` with redirect
**File**: `docs/docs/getting-started/level-1-agency-only.md`
- Replace all content with redirect page
- Add notice: "This page has moved" with link to `adoption-levels.md`
- Ensure the page is NOT listed in `sidebars.ts` (confirmed removed in T003)

### T020 [P] [US1] Replace `level-2-agency-humancy.md` with redirect
**File**: `docs/docs/getting-started/level-2-agency-humancy.md`
- Replace all content with redirect page
- Add notice: "This page has moved" with link to `adoption-levels.md`
- Ensure the page is NOT listed in `sidebars.ts` (confirmed removed in T003)

---

## Phase 9: Link Checking and Footer Updates

### T021 [P] [US1] Update footer links in `docusaurus.config.ts`
**File**: `docs/docusaurus.config.ts`
- Change footer "Getting Started" link from `/docs/getting-started/quick-start` to `/docs/getting-started` (line 81)
- Verify all other footer links still resolve

### T022 [P] [US1] Create link checker ignore list
**File**: `docs/.markdown-link-check.json`
- Create config for `markdown-link-check`
- Add ignore patterns for known future/external pages:
  - Level 3-4 external docs that may not exist yet
  - Architecture overview, API reference pages that may be stubs
  - External URLs (GitHub, Anthropic, Docker) — mark as allowed but skip in CI

---

## Phase 10: Build Verification and Validation

### T023 [US1] Verify Docusaurus build
**Command**: `cd docs && pnpm build`
- Confirm zero broken link errors (`onBrokenLinks: 'throw'` will catch issues)
- Confirm all 14 getting-started pages render in sidebar
- Confirm sidebar order matches plan
- Confirm hub page is the category landing page

### T024 [US1] Verify internal link integrity
**Command**: Manual review or link checker
- Check all cross-references between getting-started pages resolve
- Check links from getting-started to other doc sections (guides, reference, architecture) resolve
- Check redirect pages link to correct new locations

### T025 [US1] One-developer walkthrough
- Follow the guide end-to-end from `index.md` through `first-workflow.md`
- Verify commands are accurate against current CLI behavior
- Verify config examples match current schema
- Document any issues found and fix inline
- Confirm acceptance criteria: "A new developer can follow the guide and have a working setup"

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (T001-T004) must complete before all other phases — sidebar and hub page define the structure
- Phase 2 (T005-T006) can start after Phase 1
- Phase 3 (T007-T008) can start after Phase 1
- Phase 4 (T009-T010) can start after Phase 1
- Phase 5 (T011-T012) can start after Phase 1
- Phase 6 (T013-T016) can start after Phase 1
- Phase 7 (T017) can start after Phase 1
- Phase 8 (T018-T020) should start after Phase 6 (T013 absorbs content before originals are replaced)
- Phase 9 (T021-T022) can start after Phase 1
- Phase 10 (T023-T025) must run after ALL other phases complete

**Parallel opportunities within phases**:
- Phases 2-7 and Phase 9 are fully independent of each other — all can run in parallel once Phase 1 completes
- Within each phase, tasks marked [P] can run in parallel
- T005 and T006 are parallel (different source material)
- T007 and T008 are parallel (different source material)
- T009 and T010 are parallel (different source material)
- T011 and T012 are parallel (different source material)
- T013, T014, T015, T016 are all parallel (different files)
- T018, T019, T020 are all parallel (independent redirects)
- T021 and T022 are parallel (different files)

**Critical path**:
```
T001 → T003 → T004 → T013 → T018/T019/T020 → T023 → T025
       (hub)  (sidebar) (build) (adoption)  (redirects)  (build)  (walkthrough)
```

**Content dependency graph** (must read before writing):
- T005 reads existing `installation.md` → T006 rewrites it
- T008 reads existing `quick-start.md` → T018 replaces it
- T012 reads existing `quick-start.md` → T018 replaces it
- T013 reads existing `level-1-agency-only.md` and `level-2-agency-humancy.md` → T019/T020 replace them
- T014 reads troubleshooting from all three existing files → T018/T019/T020 replace them

**Therefore**: T005 before T006, T008/T012/T013/T014 before T018/T019/T020.

---

## File Summary

| Action | Count | Files |
|--------|-------|-------|
| **New** | 13 | `index.md`, `prerequisites.md`, `authentication.md`, `project-setup.md`, `configuration.md`, `dev-environment.md`, `verify-setup.md`, `first-workflow.md`, `adoption-levels.md`, `troubleshooting.md`, `multi-repo.md`, `level-3-local-orchestration.md`, `level-4-cloud.md` |
| **Rewrite** | 1 | `installation.md` |
| **Replace (redirect)** | 2 | `quick-start.md`, `level-1-agency-only.md`, `level-2-agency-humancy.md` |
| **Modify** | 3 | `_category_.json`, `sidebars.ts`, `docusaurus.config.ts` |
| **Create (config)** | 1 | `.markdown-link-check.json` |
| **Total** | 20 files touched | |

## Content Sources Reference

| New File | Primary Source | Secondary Sources |
|----------|---------------|-------------------|
| `index.md` | New content | `intro.md` adoption table |
| `prerequisites.md` | `installation.md` (system req) | CLI `init/` types |
| `installation.md` | `installation.md` (install methods) | New Docker/VS Code content |
| `authentication.md` | New content | `generacy.env.template.hbs`, `init/github.ts` |
| `project-setup.md` | `quick-start.md` (init section) | `init/summary.ts`, `init/index.ts` |
| `configuration.md` | New content | `config/README.md`, `examples/config-single-repo.yaml` |
| `dev-environment.md` | New content | Templates package (devcontainer, docker-compose) |
| `verify-setup.md` | New content | `doctor.ts`, `validate.ts` |
| `first-workflow.md` | `quick-start.md` (MCP config) | `level-1-agency-only.md` (tools) |
| `adoption-levels.md` | `level-1-agency-only.md`, `level-2-agency-humancy.md` | `intro.md` |
| `troubleshooting.md` | Existing troubleshooting sections | CLI error classes, `doctor.ts` |
| `multi-repo.md` | New content | `examples/config-multi-repo.yaml`, `generacy.env.template.hbs` |

# Implementation Plan: 6.1 — Getting Started Guide

**Branch**: `255-6-1-getting-started` | **Date**: 2026-02-28

## Summary

Restructure the existing `docs/getting-started/` section into a comprehensive, hub-and-sub-pages guide that walks a new developer through the full Generacy onboarding flow. The existing 4 files (`quick-start.md`, `installation.md`, `level-1-agency-only.md`, `level-2-agency-humancy.md`) are refactored into a new 10-section outline with an `index.md` hub page. Content is text-only (no screenshots) per the clarification decisions, with screenshots added in a follow-up PR once UIs are stable.

## Technical Context

- **Framework**: Docusaurus 3.7.0 (TypeScript config)
- **Language**: Markdown (MDX-compatible)
- **Config files**: `docs/sidebars.ts`, `docs/docusaurus.config.ts`
- **Sidebar pattern**: `_category_.json` + explicit `sidebars.ts` items
- **Mermaid**: Enabled for diagrams
- **Prism languages**: Bash, JSON, TypeScript, YAML
- **Existing content location**: `docs/docs/getting-started/`

## Architecture Overview

### Current Structure
```
docs/docs/getting-started/
├── _category_.json
├── quick-start.md          (sidebar_position: 1)
├── installation.md         (sidebar_position: 2)
├── level-1-agency-only.md  (sidebar_position: 3)
└── level-2-agency-humancy.md (sidebar_position: 4)
```

### Target Structure
```
docs/docs/getting-started/
├── _category_.json              (updated)
├── index.md                     (hub page — new)
├── prerequisites.md             (new — absorbs from installation.md)
├── installation.md              (rewritten — CLI, Docker, VS Code extension)
├── authentication.md            (new — OAuth, PAT, API keys)
├── project-setup.md             (new — generacy init walkthrough)
├── configuration.md             (new — config.yaml + env vars)
├── dev-environment.md           (new — dev container setup)
├── verify-setup.md              (new — tiered verification)
├── first-workflow.md            (new — run first workflow)
├── adoption-levels.md           (new — Level 1 inline, Levels 2-4 summary)
├── troubleshooting.md           (new — 8+ common issues)
├── multi-repo.md                (new — appendix: multi-repo differences)
├── level-3-local-orchestration.md  (stub — new)
└── level-4-cloud.md             (stub — new)
```

### Removed Files
- `quick-start.md` — content absorbed into `index.md` and `project-setup.md`; redirect left at old location
- `level-1-agency-only.md` — content absorbed into `adoption-levels.md`; redirect left
- `level-2-agency-humancy.md` — content absorbed into `adoption-levels.md`; redirect left

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Guide structure | Hub + sub-pages (replace) | 10 sections + appendix far exceeds 2000-word single-page threshold; existing directory already uses sub-page pattern |
| Quick-start handling | Absorb + redirect | Eliminates redundancy; redirect prevents broken external links |
| Screenshots | Text-only first | UIs blocked by Phases 1-5; avoids creating screenshots that immediately need replacing |
| Screenshot annotations | Markdown captions | Most maintainable; no fragile annotated PNGs |
| `generacy init` depth | Guided defaults (happy path) | Getting-started guide should get people started, not be CLI reference |
| Config detail | Key fields inline + link | 530-line config README exists; no need to duplicate |
| Verification | Tiered by level | Level 1: `generacy doctor`/`validate`; Level 2+: submit test workflow |
| Auth documentation | OAuth + PAT + API keys | All three needed for working setup |
| Default path | Single-repo | Simpler starting point; multi-repo in appendix |
| Env variables | Required only (Level 1) | `GITHUB_TOKEN` + `ANTHROPIC_API_KEY`; link to full reference |
| Sidebar integration | Replace category | Existing items reorganized into new structure |
| Link checking | Conditional ignore list | CI ignore list for known future pages |
| Adoption levels | Level 1 inline, rest linked | Level 1 is recommended starting point |

---

## Implementation Phases

### Phase 1: Hub Page and Structure Setup
**Files**: `index.md`, `_category_.json`, `sidebars.ts`

**Tasks**:

1. **Create `docs/docs/getting-started/index.md`** — Hub page that serves as the main entry point. Contains:
   - Welcome paragraph explaining what Generacy is
   - "What you'll set up" overview (bulleted list)
   - Progressive adoption level summary table (Levels 1-4, one line each)
   - Recommended path callout: "Start with Level 1"
   - Navigation links to each sub-page in order
   - Time estimate: "~15-30 minutes for Level 1 setup"

2. **Update `docs/docs/getting-started/_category_.json`** — Update metadata to reference `index.md` as the category link instead of `generated-index`.

3. **Update `docs/sidebars.ts`** — Replace the existing Getting Started category items with the new structure:
   ```typescript
   {
     type: 'category',
     label: 'Getting Started',
     link: { type: 'doc', id: 'getting-started/index' },
     collapsed: false,
     items: [
       'getting-started/prerequisites',
       'getting-started/installation',
       'getting-started/authentication',
       'getting-started/project-setup',
       'getting-started/configuration',
       'getting-started/dev-environment',
       'getting-started/verify-setup',
       'getting-started/first-workflow',
       'getting-started/adoption-levels',
       'getting-started/troubleshooting',
       'getting-started/multi-repo',
     ],
   }
   ```

### Phase 2: Prerequisites and Installation
**Files**: `prerequisites.md`, `installation.md`

**Tasks**:

4. **Create `docs/docs/getting-started/prerequisites.md`** — System requirements and prerequisites. Content absorbed from existing `installation.md` system requirements table:
   - System requirements table (Node.js 18+, npm 9+, Git, Docker Desktop)
   - OS-specific notes (macOS, Linux, Windows/WSL2)
   - Required accounts (GitHub, Anthropic)
   - Optional tools (VS Code, Docker Desktop)

5. **Rewrite `docs/docs/getting-started/installation.md`** — Replace existing content with focused installation guide:
   - Install Generacy CLI (`npm install -g @generacy-ai/generacy`)
   - Verify installation (`generacy --version`)
   - Install Docker Desktop (link to docker.com)
   - Install VS Code + Generacy extension (text-only description, screenshot placeholder comment)
   - Alternative installation methods (pnpm, from source) as collapsed details

### Phase 3: Authentication and Project Setup
**Files**: `authentication.md`, `project-setup.md`

**Tasks**:

6. **Create `docs/docs/getting-started/authentication.md`** — Unified credentials setup:
   - Credentials overview table: what's needed, where to get it, which levels need it
   - GitHub PAT: step-by-step creation with `repo` + `workflow` scopes
   - Anthropic API key: step-by-step creation
   - OAuth sign-in: text description of generacy.ai web login flow (screenshot placeholder comment)
   - Store credentials securely callout

7. **Create `docs/docs/getting-started/project-setup.md`** — `generacy init` walkthrough:
   - Navigate to project root
   - Run `generacy init --yes` (happy path with defaults)
   - Show expected output (generated file list)
   - Brief explanation of what was created (`.generacy/` directory contents)
   - Link to CLI reference for advanced `generacy init` flags
   - Source content from existing `quick-start.md` init section + CLI codebase (`init/summary.ts` output format)

### Phase 4: Configuration and Environment
**Files**: `configuration.md`, `dev-environment.md`

**Tasks**:

8. **Create `docs/docs/getting-started/configuration.md`** — Config and env setup:
   - `.generacy/config.yaml` overview: explain 4 main blocks with 1-2 sentences each:
     - `project` — unique ID and display name
     - `repos` — primary, dev, and clone repositories
     - `defaults` — agent and base branch
     - `orchestrator` — polling and worker settings
   - Show example config (single-repo, from `examples/config-single-repo.yaml`)
   - Link to full config reference (`packages/generacy/src/config/README.md` / docs site equivalent)
   - `.generacy/generacy.env` setup:
     - Copy from template: `cp .generacy/generacy.env.template .generacy/generacy.env`
     - Set `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` (Level 1 required only)
     - Note: file is gitignored, never commit
   - Link to full env reference for advanced variables

9. **Create `docs/docs/getting-started/dev-environment.md`** — Dev container setup:
   - What the dev container provides
   - Starting Docker Compose
   - Opening in VS Code dev container
   - Connecting to the dev container
   - Verifying container is running

### Phase 5: Verification and First Workflow
**Files**: `verify-setup.md`, `first-workflow.md`

**Tasks**:

10. **Create `docs/docs/getting-started/verify-setup.md`** — Tiered verification:
    - **Level 1 (config-only)**:
      - Run `generacy validate` — verify config.yaml is valid
      - Run `generacy doctor` — comprehensive environment check
      - Expected output for passing checks
      - What to do if checks fail (link to troubleshooting)
    - **Level 2+ (workflow submission)**:
      - Submit a minimal test workflow
      - Verify it appears on dashboard (text description, screenshot placeholder)

11. **Create `docs/docs/getting-started/first-workflow.md`** — Running your first workflow:
    - Configure AI agent MCP settings (Claude Code example from existing quick-start)
    - Ask the agent to use Generacy tools
    - Example prompts to try
    - What success looks like

### Phase 6: Adoption Levels and Troubleshooting
**Files**: `adoption-levels.md`, `troubleshooting.md`, `level-3-local-orchestration.md`, `level-4-cloud.md`

**Tasks**:

12. **Create `docs/docs/getting-started/adoption-levels.md`** — Progressive adoption:
    - Overview table: Level 1-4 with components, capabilities, complexity
    - **Level 1: Agency Only** — Full inline walkthrough (absorb content from existing `level-1-agency-only.md`):
      - What it provides (custom tools, context providers, local plugins)
      - Architecture diagram (Mermaid, from existing)
      - MCP configuration
      - Built-in tools table
      - Best practices
    - **Level 2: Agency + Humancy** — Summary + link:
      - What it adds (review gates, approvals, audit trail)
      - Architecture diagram (Mermaid, from existing)
      - Link to Level 2 detailed guide
    - **Level 3: Local Orchestration** — Summary + link to stub
    - **Level 4: Cloud** — Summary + link to stub

13. **Create `docs/docs/getting-started/troubleshooting.md`** — 8+ common issues:
    - Derive from codebase error handling and existing troubleshooting sections
    - Format: symptom → cause → resolution for each issue
    - Issues to cover (derived from CLI validation, doctor checks, and existing guides):
      1. `generacy` command not found (PATH issue)
      2. `generacy init` fails — not in a git repository
      3. Config validation errors (invalid project ID format, missing required fields)
      4. GitHub token invalid or insufficient scopes
      5. Anthropic API key not set or invalid
      6. MCP connection issues (agent can't connect to Agency)
      7. Docker not running / container issues
      8. Port conflicts (Redis, dev server)
    - "Still stuck?" section with links to GitHub issues and community

14. **Create stub `docs/docs/getting-started/level-3-local-orchestration.md`** — Minimal page:
    - Title and brief description of Level 3
    - "Coming soon" note
    - Link back to adoption levels overview

15. **Create stub `docs/docs/getting-started/level-4-cloud.md`** — Minimal page:
    - Title and brief description of Level 4
    - "Coming soon" note
    - Link back to adoption levels overview

### Phase 7: Multi-Repo Appendix
**Files**: `multi-repo.md`

**Tasks**:

16. **Create `docs/docs/getting-started/multi-repo.md`** — Appendix for multi-repo:
    - When to use multi-repo vs single-repo
    - Differences in `generacy init` (dev repos, clone repos)
    - Config differences (show `config-multi-repo.yaml` example)
    - Additional env variables (`POLL_INTERVAL_MS`, `WORKER_TIMEOUT_SECONDS`)
    - Orchestrator considerations

### Phase 8: Redirects and Cleanup
**Files**: `quick-start.md`, `level-1-agency-only.md`, `level-2-agency-humancy.md`

**Tasks**:

17. **Replace `docs/docs/getting-started/quick-start.md`** with redirect content:
    - Frontmatter with `slug: /docs/getting-started/quick-start`
    - Redirect notice pointing to the new hub page
    - Use Docusaurus `@docusaurus/plugin-client-redirects` or a manual redirect page with a link and note

18. **Replace `docs/docs/getting-started/level-1-agency-only.md`** with redirect:
    - Redirect to `adoption-levels` page

19. **Replace `docs/docs/getting-started/level-2-agency-humancy.md`** with redirect:
    - Redirect to `adoption-levels` page

### Phase 9: Link Checking and CI
**Files**: `.markdown-link-check.json` (or equivalent)

**Tasks**:

20. **Create link checker ignore list** — Add configuration for `markdown-link-check` or equivalent:
    - Ignore known future pages (Level 3-4 external docs, architecture overview, API reference, plugin docs that may not exist yet)
    - Configuration file at `docs/.markdown-link-check.json` or integrated into existing CI

21. **Update footer links** — Check `docusaurus.config.ts` footer for any links pointing to old getting-started pages and update to new paths.

### Phase 10: Review and Validation

22. **One-developer walkthrough** — Per Q15 answer, validate the guide by having one developer follow it end-to-end before merge. Document any issues found and fix them.

23. **Verify Docusaurus build** — Run `pnpm build` in the docs directory to ensure all pages compile without errors, all internal links resolve, and the sidebar renders correctly.

---

## Content Sources Map

| New File | Primary Content Source | Secondary Sources |
|----------|----------------------|-------------------|
| `index.md` | New content | `quick-start.md` intro, `intro.md` adoption table |
| `prerequisites.md` | `installation.md` (system requirements) | CLI `init/types.ts` (requirements) |
| `installation.md` | `installation.md` (install methods) | New content for Docker/VS Code |
| `authentication.md` | New content | `generacy.env.template.hbs` (required vars), `init/github.ts` (scopes) |
| `project-setup.md` | `quick-start.md` (init section) | `init/summary.ts` (output format), `init/index.ts` (steps) |
| `configuration.md` | New content | `config/README.md` (schema), `examples/config-single-repo.yaml` |
| `dev-environment.md` | New content | Templates package (devcontainer, docker-compose) |
| `verify-setup.md` | New content | `doctor.ts` (checks), `validate.ts` (output) |
| `first-workflow.md` | `quick-start.md` (agent config) | `level-1-agency-only.md` (tool usage) |
| `adoption-levels.md` | `level-1-agency-only.md`, `level-2-agency-humancy.md` | `intro.md` (level descriptions) |
| `troubleshooting.md` | `quick-start.md`, `level-1-agency-only.md`, `level-2-agency-humancy.md` (troubleshooting sections) | CLI error classes, `doctor.ts` checks |
| `multi-repo.md` | New content | `examples/config-multi-repo.yaml`, `generacy.env.template.hbs` (multi-repo section) |

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Broken internal links after restructure | High | Medium | Run `pnpm build` after each phase; Docusaurus will error on broken doc links |
| External links to old pages break | Medium | Medium | Redirect pages at old URLs; consider `@docusaurus/plugin-client-redirects` |
| Content drift from actual CLI behavior | Medium | High | Source content directly from CLI codebase (init steps, doctor checks, validate output) |
| Guide too long / overwhelming | Medium | Medium | Hub page provides navigation; each sub-page is self-contained and focused |
| Screenshots needed before UIs stable | Low | Low | Decided: text-only first, screenshots in follow-up PR |
| Level 3-4 stub pages feel incomplete | Low | Low | Clear "coming soon" messaging; links back to overview |

## Out of Scope

- Screenshot capture (follow-up PR once UIs are stable)
- Full usability testing with 5+ developers (post-publish activity)
- Level 3 and Level 4 detailed guides (stubs only)
- CLI reference documentation (separate spec)
- `@docusaurus/plugin-client-redirects` setup (manual redirect pages used instead; plugin can be added later)

## Estimated File Count

- **New files**: 13 (index.md, prerequisites.md, authentication.md, project-setup.md, configuration.md, dev-environment.md, verify-setup.md, first-workflow.md, adoption-levels.md, troubleshooting.md, multi-repo.md, level-3-local-orchestration.md, level-4-cloud.md)
- **Modified files**: 5 (installation.md rewrite, quick-start.md redirect, level-1-agency-only.md redirect, level-2-agency-humancy.md redirect, sidebars.ts, _category_.json)
- **Optional**: 2 (.markdown-link-check.json, docusaurus.config.ts footer updates)

# Feature Specification: Getting Started Guide

**Branch**: `255-6-1-getting-started` | **Date**: 2026-02-28 | **Status**: Draft

## Summary

Create a comprehensive, developer-facing "Getting Started" guide that lives in `docs/` and walks a new developer through the full Generacy onboarding flow — from prerequisites through a working setup with the VS Code extension, CLI, and orchestrator. The guide follows the progressive adoption model (Levels 1–4) and includes screenshots of the generacy.ai web interface and VS Code extension, a troubleshooting section, and cross-links to detailed component docs. This is the capstone documentation deliverable for Epic 6 and depends on all Epics 1–5 being substantially complete.

### Plan Reference

[onboarding-buildout-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md) — Issue 6.1

---
### Execution
**Phase:** 6 — Documentation
**Blocked by:**
- [ ] All Phase 1-5 issues substantially complete

---

## User Stories

### US1: New Developer — First Setup

**As a** developer adopting Generacy for the first time,
**I want** a single, linear guide that takes me from zero to a working setup,
**So that** I can start using Generacy without needing to piece together information from multiple sources.

**Acceptance Criteria**:
- [ ] Guide is reachable from the docs landing page (`docs/`) and linked from `README.md`
- [ ] Covers prerequisites (Node.js 20+, pnpm, Git, an AI coding assistant)
- [ ] Walks through `generacy init` (both interactive and non-interactive modes)
- [ ] Explains `.generacy/config.yaml` creation and key fields
- [ ] Covers VS Code extension install, sign-in (GitHub OAuth), and dashboard basics
- [ ] Includes at least one "hello world" workflow submission to verify the setup works
- [ ] A developer with no prior Generacy knowledge can follow the guide end-to-end and reach a working state

### US2: New Developer — Troubleshooting

**As a** developer who hits an error during onboarding,
**I want** a troubleshooting section with common problems and solutions,
**So that** I can unblock myself without filing a support request.

**Acceptance Criteria**:
- [ ] Troubleshooting section covers at least 8 common issues (auth failures, port conflicts, missing dependencies, config validation errors, extension not activating, Docker/container issues, Redis connection failures, environment variable problems)
- [ ] Each issue includes symptom, likely cause, and resolution steps
- [ ] Section is linkable (anchor-headed) so support can deep-link to specific items

### US3: New Developer — Progressive Adoption

**As a** developer evaluating Generacy,
**I want** to understand the progressive adoption levels and choose my starting point,
**So that** I can adopt incrementally without committing to the full stack upfront.

**Acceptance Criteria**:
- [ ] Guide explains Levels 1–4 (Agency-only → Agency+Humancy → Full local stack → Cloud deployment)
- [ ] Each level states what it adds, what dependencies it requires, and links to its detailed setup guide
- [ ] Guide recommends Level 1 as the default starting point

### US4: Returning Developer — Reference Navigation

**As a** developer who has already completed onboarding,
**I want** the guide to link to detailed docs for each component,
**So that** I can quickly navigate to the reference material I need.

**Acceptance Criteria**:
- [ ] Links to Agency overview (`docs/guides/agency/overview.md`)
- [ ] Links to Humancy overview (`docs/guides/humancy/overview.md`)
- [ ] Links to Generacy/orchestrator overview (`docs/guides/generacy/overview.md`)
- [ ] Links to architecture overview (`docs/architecture/overview.md`)
- [ ] Links to configuration reference, API reference, and plugin docs
- [ ] All links are verified and resolve correctly

---

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Create `docs/getting-started.md` as the primary guide entry point | P1 | Single-page guide; may split into sub-pages if length exceeds ~2000 words |
| FR-002 | Prerequisites section listing required tools and versions | P1 | Node.js 20+, pnpm 9+, Git 2.30+, VS Code 1.108+, Docker (optional for Levels 3–4) |
| FR-003 | Installation section covering `npm install -g @generacy-ai/cli` and VS Code extension install | P1 | Include both CLI and marketplace install methods |
| FR-004 | Project initialization walkthrough using `generacy init` | P1 | Show interactive prompts and resulting file structure (`.generacy/`, `.devcontainer/`, `.vscode/`) |
| FR-005 | Configuration section explaining `.generacy/config.yaml` schema and key fields | P1 | Reference the Zod-validated schema; explain `project`, `repos`, `defaults`, `orchestrator` blocks |
| FR-006 | Environment setup section for `generacy.env` (GitHub token, API keys) | P1 | Use the `.generacy/generacy.env.template` as the reference |
| FR-007 | VS Code extension walkthrough: install, sign in, dashboard, job detail, log streaming | P1 | Include annotated screenshots |
| FR-008 | Annotated screenshots of generacy.ai web interface (login, project setup, dashboard) | P1 | Minimum 3 screenshots; store in `docs/assets/getting-started/` |
| FR-009 | Annotated screenshots of VS Code extension (sidebar, dashboard, job detail, logs) | P1 | Minimum 4 screenshots; store in `docs/assets/getting-started/` |
| FR-010 | "Verify your setup" section with a test workflow submission | P1 | End-to-end smoke test proving the setup works |
| FR-011 | Troubleshooting section with common issues table | P1 | Minimum 8 issues; symptom / cause / resolution format |
| FR-012 | Progressive adoption overview (Levels 1–4) with links to detailed guides | P2 | Reference existing `level-1-agency-only.md` and `level-2-agency-humancy.md` |
| FR-013 | "Next steps" section linking to detailed component docs | P2 | Agency, Humancy, Generacy, architecture, plugins, API reference |
| FR-014 | Link from `README.md` and `docs/intro.md` to the getting-started guide | P2 | Ensure discoverability from repo root and docs landing |
| FR-015 | Multi-repo vs single-repo callouts where setup differs | P2 | `.devcontainer/` config differs; flag these branch points clearly |
| FR-016 | Copy-pasteable code blocks for all commands | P2 | Use fenced code blocks with shell language hints |
| FR-017 | Sidebar/ToC integration with Docusaurus docs site | P3 | Update `sidebars.js` or equivalent to include the new page |
| FR-018 | Estimated time annotations for each section (e.g., "~2 min") | P3 | Helps developers gauge total onboarding time |

---

## Guide Structure (Outline)

```
docs/getting-started.md
├── 1. Overview — What is Generacy? What will you set up?
├── 2. Prerequisites — Tools, versions, accounts
├── 3. Choose Your Level — Progressive adoption overview (Levels 1–4)
├── 4. Install the CLI — `npm install -g @generacy-ai/cli`
├── 5. Initialize Your Project — `generacy init` walkthrough
│   ├── Interactive mode
│   ├── Non-interactive mode (CI-friendly)
│   └── Resulting file structure
├── 6. Configure Your Environment — `.generacy/generacy.env`, tokens, keys
├── 7. Install the VS Code Extension — Marketplace install, sign-in, first look
│   ├── Screenshot: Extension sidebar
│   ├── Screenshot: Dashboard view
│   └── Screenshot: Job detail + logs
├── 8. Verify Your Setup — Submit a test workflow, confirm end-to-end
├── 9. Troubleshooting — Common issues and fixes
├── 10. Next Steps — Links to component guides, architecture, advanced config
└── Appendix: Multi-repo setup differences
```

---

## Screenshot Requirements

| ID | Subject | Source | Min Count |
|----|---------|--------|-----------|
| SS-001 | generacy.ai login / sign-in page | Web interface | 1 |
| SS-002 | generacy.ai project setup / dashboard | Web interface | 2 |
| SS-003 | VS Code extension sidebar (Workflows, Queue, Agents views) | VS Code | 1 |
| SS-004 | VS Code orchestration dashboard (read-only) | VS Code | 1 |
| SS-005 | VS Code job detail view with log streaming | VS Code | 1 |
| SS-006 | VS Code environment configuration helper prompts | VS Code | 1 |
| SS-007 | Terminal output of `generacy init` interactive flow | Terminal | 1 |

Screenshots should be:
- Stored in `docs/assets/getting-started/`
- PNG format, max 1200px wide
- Annotated with numbered callouts where UI elements need explanation
- Alt-text provided for accessibility

---

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | End-to-end completion rate | 90% of test users complete the guide without external help | Usability test with 5+ developers unfamiliar with Generacy |
| SC-002 | Time to working setup | ≤ 30 minutes from start to verified setup | Timed usability test (Level 1 path) |
| SC-003 | Troubleshooting coverage | ≥ 80% of onboarding support questions are answered by the troubleshooting section | Track support requests in first 30 days post-publish; compare against guide content |
| SC-004 | Link integrity | 100% of internal links resolve | Automated link checker in CI (e.g., `markdown-link-check`) |
| SC-005 | Screenshot freshness | All screenshots match current UI | Manual review on each release; screenshots regenerated if UI changes |
| SC-006 | Guide discoverability | Guide is reachable within 1 click from README and docs landing | Manual verification |

---

## Assumptions

- All Phase 1–5 deliverables (CLI, VS Code extension, config schema, dev container feature, CI/CD) are substantially complete before this guide is finalized.
- The `generacy init` command (Epic 4.5) is stable and produces the documented file structure.
- The VS Code extension (Epic 5.2/5.3) is published to the marketplace and functional for screenshots.
- The generacy.ai web interface is deployed and accessible for screenshot capture.
- GitHub OAuth is the primary authentication method documented in the guide.
- The Docusaurus docs site (`docs/`) is the canonical location for this guide.
- The progressive adoption model (Levels 1–4) from the architecture docs is the framing for the guide.
- Developers have access to a GitHub account for OAuth sign-in.

## Out of Scope

- **Enterprise/cloud deployment guide** — Level 4 cloud setup is referenced but detailed in its own doc.
- **API reference documentation** — Linked to but not authored as part of this spec.
- **Video tutorials or screencasts** — Text + screenshots only; video is a separate initiative.
- **Non-English translations** — Guide is English-only for initial release.
- **Plugin authoring guide** — Linked to but not part of the getting-started flow.
- **CI/CD pipeline setup for end-users** — The guide covers local setup; CI/CD integration is a separate doc.
- **Jira/Slack integration setup** — Advanced integrations documented separately.
- **Performance tuning or production configuration** — Beyond onboarding scope.
- **Writing or updating the detailed component guides** (Agency, Humancy, Generacy overviews) — This spec only links to them.

---

## Implementation Notes

### File Locations
- Primary guide: `docs/getting-started.md`
- Screenshots: `docs/assets/getting-started/*.png`
- Sidebar config update: `docs/sidebars.js` (or equivalent Docusaurus config)

### Writing Style
- Second person ("you"), active voice, present tense
- Short paragraphs (≤ 4 sentences)
- Every command in a fenced code block with `bash` language hint
- Callout boxes for warnings, tips, and multi-repo differences (use Docusaurus admonitions: `:::tip`, `:::warning`, `:::info`)
- No jargon without definition on first use

### Review Process
1. Technical review by a developer who did not write the guide
2. Usability test: fresh developer follows the guide end-to-end
3. Link check (automated)
4. Screenshot accuracy check against current UI

### Dependencies on Other Specs

| Spec | What It Provides |
|------|-----------------|
| 247-4-1-define-onboarding | Onboarding PR template files (`.generacy/`, `.devcontainer/`, `.vscode/`) — documented in Step 5 |
| 248-4-2-define-generacy | `.generacy/config.yaml` schema — documented in Step 5 & 6 |
| 249-4-5-generacy-cli | `generacy init` command — documented in Step 5 |
| 250-5-2-generacy-vs | VS Code extension MVP — documented in Step 7 & screenshots |
| 251-5-3-generacy-vs | Environment configuration helper — documented in Step 6 & screenshots |
| 252-5-4-publish-dev | Dev Container Feature — documented in multi-repo appendix |
| 244-1-5-register-vs | VS Code Marketplace publisher — prerequisite for Step 7 |

---

*Generated by speckit*

# Clarification Questions

## Status: Resolved

## Questions

### Q1: Guide Structure — Single Page vs Multi-Page
**Context**: FR-001 specifies `docs/getting-started.md` as a single-page guide with a note to "split into sub-pages if length exceeds ~2000 words." The existing docs already have a `docs/getting-started/` directory with `quick-start.md`, `installation.md`, `level-1-agency-only.md`, and `level-2-agency-humancy.md`. The outlined guide structure (10 sections + appendix) will almost certainly exceed 2000 words.
**Question**: Should the guide be authored as a single `docs/getting-started.md` file that replaces the existing `docs/getting-started/` directory, or should it be a new `docs/getting-started/index.md` that serves as the hub page with sub-pages for each major section? If sub-pages, should the existing files (`quick-start.md`, `installation.md`, `level-1-agency-only.md`, `level-2-agency-humancy.md`) be refactored into the new structure or kept alongside?
**Options**:
- A) Single file: Author everything in one `docs/getting-started.md`, replacing the existing directory entirely
- B) Hub + sub-pages (replace): Create `docs/getting-started/index.md` as the hub and refactor existing files into the new outline structure
- C) Hub + sub-pages (preserve): Create `docs/getting-started/index.md` as the hub, keep existing files, and add new sub-pages to fill gaps
- D) Single file + preserve: Author the main guide as `docs/getting-started.md` and keep the existing sub-pages as supplementary reference
**Answer**: B) Hub + sub-pages (replace). The guide outline has 10 sections + appendix and will far exceed 2000 words. The existing `docs/getting-started/` directory already uses a sub-page pattern. A clean `index.md` hub serves as the main entry point, with each major section as its own page. The existing files get refactored into the new outline rather than awkwardly coexisting alongside it.

---

### Q2: Relationship to Existing Quick Start Guide
**Context**: `docs/getting-started/quick-start.md` already provides a 5-minute Agency-focused quickstart. The new guide overlaps significantly (prerequisites, CLI install, `generacy init`, verification). The spec doesn't mention this existing guide.
**Question**: Should the new Getting Started guide supersede and replace the existing `quick-start.md`, or should the quick-start remain as a shorter alternative path alongside the comprehensive guide?
**Options**:
- A) Replace: The new guide fully replaces `quick-start.md`; content is merged into the new guide
- B) Coexist: Keep `quick-start.md` as a "5-minute quick start" and position the new guide as the comprehensive path
- C) Absorb and redirect: Move `quick-start.md` content into the new guide and leave a redirect/link at the old location
**Answer**: C) Absorb and redirect. The existing `quick-start.md` content overlaps heavily with the new guide. Absorbing it into the new structure preserves the content while eliminating redundancy. A redirect at the old location prevents broken links from anywhere referencing it.

---

### Q3: Screenshot Capture Timing and Placeholder Strategy
**Context**: The spec requires 7+ annotated screenshots (SS-001 through SS-007) from the generacy.ai web interface, VS Code extension, and terminal. However, the spec is blocked by Phases 1–5 being "substantially complete," and the VS Code extension may not be published to the marketplace yet. Screenshots of unstable UIs will need updating.
**Question**: Should the initial implementation use placeholder images with `[TODO: screenshot]` annotations and descriptive alt-text, or should the guide be authored as text-only initially and screenshots added in a follow-up pass once all UIs are stable?
**Options**:
- A) Placeholder images: Use labeled placeholder PNGs (e.g., grey boxes with text descriptions) so the guide structure is complete
- B) Text-only first: Write the guide without screenshots; add them in a follow-up PR once UIs are finalized
- C) Capture now, refresh later: Take screenshots of current UI state and flag them for refresh before final publish
**Answer**: B) Text-only first. Since this issue is blocked by Phases 1–5 being substantially complete, UIs will still be evolving. Writing text-only first avoids creating screenshots that immediately need replacing. Screenshots will be added in a follow-up PR once UIs are stable, keeping the initial PR focused on content quality.

---

### Q4: Screenshot Annotation Tooling
**Context**: FR-008 and FR-009 require "annotated screenshots with numbered callouts." The spec doesn't specify how annotations should be created or maintained. Hand-annotated PNGs are fragile (must be regenerated from scratch when UI changes), while text-based overlays or separate annotation layers are more maintainable.
**Question**: What tooling or approach should be used for screenshot annotations?
**Options**:
- A) Manual annotation: Use an image editor (e.g., Figma, Preview) to add numbered callouts directly on PNGs
- B) Markdown captions: Use plain screenshots with numbered markdown captions below each image describing the UI elements
- C) Automated via Playwright: Use Playwright to capture screenshots and programmatically overlay annotations, enabling easy regeneration
**Answer**: B) Markdown captions. Plain screenshots with numbered markdown captions below are the most maintainable approach for a docs site. Manual annotations on PNGs are fragile and must be fully recreated when UIs change. Playwright automation is over-engineered for documentation screenshots. Markdown captions are easy to update, version-control friendly, and accessible.

---

### Q5: `generacy init` — Scope of Walkthrough
**Context**: FR-004 says to walk through `generacy init` in both interactive and non-interactive modes. The CLI's `init/` command module has 8 source files, suggesting a complex multi-step flow. The spec doesn't clarify how deeply to document each prompt/option in the interactive flow versus providing a high-level summary.
**Question**: How detailed should the `generacy init` walkthrough be? Should every interactive prompt be shown with its options and explanations, or should it be a summary with a terminal screenshot showing the complete flow?
**Options**:
- A) Full detail: Document every prompt, option, and decision point with explanations of each choice
- B) Annotated screenshot + summary: Show one complete terminal screenshot of the interactive flow with a summary table of key decisions
- C) Guided defaults: Show only the "happy path" (accepting defaults) in detail, with a reference link to a full `generacy init` CLI reference for advanced options
**Answer**: C) Guided defaults. A getting-started guide should get people started, not be an exhaustive CLI reference. Show the happy path (accepting defaults or using `--yes`) in detail, then link to a full CLI reference for advanced options. The init command has 11 steps and many flags — documenting every prompt would overwhelm new users.

---

### Q6: Config YAML Documentation Depth
**Context**: FR-005 requires explaining `.generacy/config.yaml` schema and key fields. The config package already has a comprehensive 530-line `README.md` with Zod schema documentation. The getting-started guide could duplicate this, summarize it, or just link to it.
**Question**: How much config detail should be inline in the getting-started guide versus linked to the existing config reference?
**Options**:
- A) Minimal inline: Show the generated config file with brief comments, link to the full config reference for details
- B) Key fields inline: Explain the 4 main blocks (`project`, `repos`, `defaults`, `orchestrator`) with 1-2 sentences each, link to reference for field-level details
- C) Full inline: Reproduce the complete schema documentation within the getting-started guide for a self-contained experience
**Answer**: B) Key fields inline. The config package already has a comprehensive 530-line README. The getting-started guide should explain the 4 main blocks (`project`, `repos`, `defaults`, `orchestrator`) with 1–2 sentences each so users understand what was generated, then link to the existing config reference for field-level details. No need to duplicate.

---

### Q7: "Verify Your Setup" Workflow Definition
**Context**: FR-010 requires a "test workflow submission" to verify the setup works end-to-end. The spec doesn't define what this test workflow does, where its definition lives, or whether it requires a running orchestrator/backend.
**Question**: What should the verification workflow do, and what infrastructure does it assume is running?
**Options**:
- A) Local-only CLI check: Run `generacy doctor` or `generacy validate` to verify configuration without submitting a real workflow
- B) Minimal workflow submission: Submit a trivial workflow (e.g., "echo hello") that exercises the full submission path including the orchestrator
- C) VS Code extension test: Use the VS Code extension to submit a workflow and verify dashboard display, proving both CLI and extension work
- D) Tiered verification: Provide a verification step per adoption level — Level 1 uses CLI-only check, Level 2+ submits a workflow
**Answer**: D) Tiered verification. The product has progressive adoption levels, so verification should match. Level 1 uses `generacy doctor` / `generacy validate` for a local-only config check. Level 2+ can submit a minimal test workflow. This aligns with the progressive adoption model and doesn't force Level 1 users to need a running orchestrator.

---

### Q8: Authentication Documentation — GitHub OAuth Scope
**Context**: The spec lists GitHub OAuth as the primary authentication method and FR-006 mentions GitHub tokens in `generacy.env`. The spec doesn't clarify whether the guide documents: (a) OAuth sign-in only (for the VS Code extension / web UI), (b) personal access token (PAT) generation for CLI use, or (c) both. It also doesn't specify required GitHub OAuth scopes or PAT permissions.
**Question**: What authentication flows should the guide document, and should it specify the exact GitHub OAuth scopes / PAT permissions required?
**Options**:
- A) OAuth only: Document GitHub OAuth sign-in for VS Code extension and web UI; CLI uses the same OAuth token
- B) OAuth + PAT: Document OAuth for VS Code/web and a separate PAT for CLI/CI scenarios, with required scopes listed
- C) OAuth + PAT + API keys: Document all three — OAuth, PAT, and third-party API keys (Anthropic, etc.) with a unified credentials table
**Answer**: C) OAuth + PAT + API keys. The env template already requires `GITHUB_TOKEN` (PAT with repo/workflow scopes) and `ANTHROPIC_API_KEY`. Users need all of these for a working setup. A unified credentials table showing what's needed, where to get it, and which adoption levels require it is the clearest approach. OAuth for web/extension, PAT for CLI/CI, and API keys for agent operation are all part of the onboarding flow.

---

### Q9: Troubleshooting — Source of Common Issues
**Context**: FR-011 and US2 require documenting at least 8 common onboarding issues. The spec lists categories (auth failures, port conflicts, missing dependencies, config validation errors, extension not activating, Docker/container issues, Redis connection failures, environment variable problems) but doesn't provide the actual symptom/cause/resolution details.
**Question**: Where should the troubleshooting content come from? Should it be synthesized from existing support channels, inferred from the codebase's error handling, or left as a template to be filled in after usability testing?
**Options**:
- A) Codebase-driven: Derive issues from error messages and validation logic in the CLI, extension, and orchestrator source code
- B) Template with placeholders: Create the 8 issue entries with the listed categories and placeholder symptom/resolution text to be filled in during usability testing
- C) Best-guess + iterate: Write realistic troubleshooting entries based on the codebase and common patterns, then refine based on usability test feedback
**Answer**: C) Best-guess + iterate. The codebase has error handling, validation logic, and the existing guides already have troubleshooting sections (e.g., `quick-start.md` covers "Agency command not found" and "MCP connection issues"). Write realistic entries derived from the codebase's error paths and common patterns, then refine based on actual usability test feedback post-publish.

---

### Q10: Progressive Adoption Levels — Detail per Level
**Context**: US3 and FR-012 require explaining Levels 1–4. Level 1 and Level 2 already have dedicated guides (`level-1-agency-only.md`, `level-2-agency-humancy.md`). Levels 3 and 4 are referenced in the spec but don't appear to have existing dedicated guides.
**Question**: Should the getting-started guide include setup instructions for each level, or only describe what each level adds and link out? For Levels 3–4, should stub guides be created as part of this spec?
**Options**:
- A) Describe + link all: Provide a summary table for all 4 levels; link to existing Level 1–2 guides; link to placeholder pages for Levels 3–4
- B) Level 1 inline, rest linked: Walk through Level 1 setup in full detail within the guide; describe and link Levels 2–4
- C) All levels inline: Provide condensed setup instructions for all 4 levels within the guide (longest guide, most self-contained)
**Answer**: B) Level 1 inline, rest linked. The getting-started guide should walk through Level 1 (the recommended starting point) in full detail. Levels 2–4 get a summary description of what they add and links out. Existing Level 1 and Level 2 guides get refactored into the new structure (per Q1 answer). Stub pages for Levels 3–4 should be created as part of this work so links aren't broken.

---

### Q11: Docusaurus Sidebar Integration
**Context**: FR-017 (P3) mentions updating `sidebars.js` (actually `sidebars.ts` in this project). The existing sidebar already has a "Getting Started" category with `quick-start`, `installation`, `level-1-agency-only`, and `level-2-agency-humancy` items. Adding the new guide requires deciding its position relative to existing items.
**Question**: Should the new getting-started guide become the first item in the existing "Getting Started" sidebar category, or should it replace the category structure entirely?
**Options**:
- A) Prepend: Add the new guide as the first item in the existing "Getting Started" category, keeping all existing items below it
- B) Replace category: Restructure the "Getting Started" category to match the new guide's outline, removing or reorganizing existing items
- C) New top-level: Make the getting-started guide a top-level sidebar item (above the category) for maximum visibility, keeping the category for sub-pages
**Answer**: B) Replace category. Since the existing files are being refactored into the new guide structure (per Q1), the sidebar should reflect the new outline. The existing "Getting Started" category items (`quick-start`, `installation`, `level-1-agency-only`, `level-2-agency-humancy`) will be reorganized into the new structure, not left dangling alongside it.

---

### Q12: Multi-Repo vs Single-Repo — Default Path
**Context**: FR-015 requires multi-repo vs single-repo callouts. The guide outline includes an "Appendix: Multi-repo setup differences." The config package has both `config-single-repo.yaml` and `config-multi-repo.yaml` examples. The spec doesn't state which setup is the default "happy path" the guide walks through.
**Question**: Should the main guide walkthrough assume a single-repo or multi-repo setup as the default path?
**Options**:
- A) Single-repo default: Walk through single-repo as the primary path; multi-repo differences in the appendix
- B) Multi-repo default: Walk through multi-repo as the primary path since it's more common in enterprise settings
- C) User choice upfront: Present both options in Section 5 (Initialize Your Project) and let the reader choose, with parallel instructions
**Answer**: A) Single-repo default. Single-repo is simpler and the right starting point for most users. The config examples show `config-single-repo.yaml` is much more concise than `config-multi-repo.yaml`. Multi-repo differences belong in the appendix as documented in the guide outline. Users graduating to multi-repo can reference it when ready.

---

### Q13: `generacy.env.template` — Required vs Optional Variables
**Context**: FR-006 references `.generacy/generacy.env.template` as the source for environment configuration. The spec lists "GitHub token, API keys" but doesn't enumerate which environment variables are required for Level 1 vs which are only needed for higher levels.
**Question**: Should the guide document all environment variables from the template, or only the minimum required for the chosen adoption level?
**Options**:
- A) All variables: Document every variable in the template with required/optional annotations
- B) Level-gated: Show only the variables required for each adoption level, expanding as the reader progresses
- C) Required only: Document only the variables needed for Level 1 (the recommended starting point), with a link to the full env reference for advanced levels
**Answer**: C) Required only. For a getting-started guide, show only what's needed for Level 1: `GITHUB_TOKEN` and `ANTHROPIC_API_KEY`. The env template already has clear section headers and comments. Link to the full env reference for advanced variables like `REDIS_URL`, `POLL_INTERVAL_MS`, etc. that only apply to higher levels.

---

### Q14: Link Verification Strategy
**Context**: SC-004 requires 100% link integrity with an automated check in CI. The spec mentions `markdown-link-check` as an example. The guide will contain links to docs that may not yet exist (e.g., Level 3–4 guides, architecture overview, API reference, plugin docs). Broken links in CI would block merging.
**Question**: How should links to not-yet-created docs be handled to avoid CI failures while maintaining link integrity goals?
**Options**:
- A) Stub pages: Create minimal stub `.md` files for all linked-to pages that don't yet exist
- B) Conditional links: Use a link checker ignore list for known future pages, removing entries as pages are created
- C) Relative links only to existing pages: Only link to pages that currently exist; add remaining links in follow-up PRs as dependencies are completed
**Answer**: B) Conditional links. An ignore list for known future pages is practical CI hygiene. Stub pages create maintenance overhead and clutter the docs. Avoiding links entirely makes the guide less useful. An ignore list can be tracked and whittled down as dependencies land.

---

### Q15: Usability Testing Protocol
**Context**: SC-001 and SC-002 define success criteria requiring usability testing with 5+ developers and a ≤30-minute completion target. The spec doesn't define when usability testing happens, who the test participants are, or how results are captured.
**Question**: Is usability testing in scope for this spec's implementation, or is it a post-publish activity? If in-scope, what is the expected process?
**Options**:
- A) In-scope: Usability testing is part of the definition of done; the guide cannot be marked complete until tested with 5+ developers
- B) Post-publish: Usability testing happens after the guide is merged; results inform a follow-up iteration
- C) Review-gated: One developer walkthrough is required before merge (per the review process); full usability testing is post-publish
**Answer**: C) Review-gated. One developer walkthrough before merge is practical and validates the guide works end-to-end. Full usability testing with 5+ developers and the ≤30-minute target should be a post-publish activity that informs a follow-up iteration. Blocking merge on 5+ testers would significantly delay shipping.

---

### Q16: generacy.ai Web Interface — Current State and Access
**Context**: FR-008 requires annotated screenshots of the generacy.ai web interface (login, project setup, dashboard). The assumptions state "The generacy.ai web interface is deployed and accessible for screenshot capture." If the web interface is not yet deployed or is behind access controls, this blocks screenshot creation.
**Question**: Is the generacy.ai web interface currently deployed and accessible for screenshot capture? If not, what is the expected timeline, and should placeholder content be used?
**Options**:
- A) Available now: The web interface is deployed and screenshots can be captured immediately
- B) Not yet available: The web interface is not deployed; use placeholder images with descriptions
- C) Partially available: Some pages exist (e.g., login) but others (e.g., dashboard) are not ready; capture what's available, placeholder the rest
**Answer**: B) Not yet available. Given that this issue is blocked by Phases 1–5, the web interface likely isn't fully deployed yet. This aligns with the Q3 answer — use text-only content initially, add screenshots in a follow-up once the web interface is stable and accessible. If parts are available (e.g., login page), those can be captured opportunistically.

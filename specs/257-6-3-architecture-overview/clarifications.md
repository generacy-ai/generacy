# Clarification Questions

## Status: Pending

## Questions

### Q1: Document Location and Relationship to Existing Architecture Docs
**Context**: The spec says the document should live at `docs/architecture-overview.md` in the public `generacy` repo (FR-012). However, there is already an existing `docs/docs/architecture/overview.md` in the Docusaurus site that covers system architecture with Mermaid diagrams, component descriptions, and deployment architecture. This creates potential confusion — two architecture documents with overlapping scope but different audiences.
**Question**: Should this new adopter-focused architecture overview replace the existing `docs/docs/architecture/overview.md`, live alongside it as a separate page, or be integrated into the Docusaurus site at a different path? If they coexist, how do we prevent content drift between them?
**Options**:
- A) Replace existing: Remove the current architecture overview and replace it with this adopter-focused version, since the existing one exposes internal details (Redis, BullMQ, PostgreSQL) that the spec says are out of scope for adopters
- B) Separate page in Docusaurus: Add this as a new page (e.g., `docs/docs/architecture/adopter-overview.md`) alongside the existing one, with the existing page serving as an "internal architecture" reference
- C) Standalone markdown at repo root: Place it at `docs/architecture-overview.md` (outside Docusaurus) as specified, making it a standalone GitHub-rendered document independent of the docs site
- D) Replace and redirect: Replace the existing architecture overview with the adopter-focused version, and move internal architecture details to a separate "Architecture Internals" page
**Answer**:

### Q2: Diagram Format — Mermaid vs ASCII Art
**Context**: The spec says diagrams must render in GitHub markdown (FR-001) and the assumptions note that "Mermaid diagrams are preferred if the doc will be rendered on a platform that supports them." GitHub natively renders Mermaid in markdown files. However, the existing architecture overview already uses Mermaid extensively. If this document is placed in the Docusaurus site, Mermaid requires a plugin. The choice affects maintainability and rendering compatibility.
**Question**: Should the diagrams use Mermaid (which GitHub renders natively and Docusaurus supports via plugin) or ASCII art (universally compatible but harder to maintain)?
**Options**:
- A) Mermaid: Use Mermaid diagrams for all visuals — GitHub renders them natively, and the Docusaurus site already has Mermaid support configured
- B) ASCII art: Use ASCII art for maximum compatibility and zero rendering dependencies
- C) Both: Provide a primary Mermaid diagram with an ASCII fallback in a collapsible section for environments that don't render Mermaid
**Answer**:

### Q3: Depth of Workflow Customization Section
**Context**: The spec includes FR-006 (P2) covering workflow customization with YAML format, built-in actions, and variable interpolation. US4 requires listing available built-in actions and explaining local vs cloud execution. However, the spec also says a "detailed workflow authoring guide" is out of scope and this overview should just link to it. The existing canonical workflows (`speckit-feature.yaml`, `speckit-bugfix.yaml`, `speckit-epic.yaml`) use actions like `speckit.specify`, `verification.check`, `pr.create` with `${{ }}` interpolation — but documenting these in detail risks duplicating the future authoring guide.
**Question**: How deep should the workflow customization section go? Should it include a real YAML snippet from the canonical workflows, or only a simplified/hypothetical example?
**Options**:
- A) Real minimal example: Show a simplified excerpt from `speckit-feature.yaml` (e.g., 2-3 phases) to ground the explanation in reality, plus a list of built-in action namespaces without full parameter docs
- B) Hypothetical example: Show a generic YAML example (not from actual workflows) that illustrates the format without implying the canonical workflows are customizable
- C) Reference only: Describe the concepts textually (phases, actions, gates) with no YAML example, and link to the future authoring guide for all details
**Answer**:

### Q4: Label Protocol — Include All Labels or Only Adopter-Relevant Ones?
**Context**: The internal label protocol defines 20+ labels across trigger, phase, waiting-for, completed, agent status, and utility categories. Many of these (like `agent:in-progress`, `phase:specify`, `completed:validate`) are system-managed and adopters never interact with them directly. The spec says to separate "you manage" vs "system manages" labels (FR-003), but it's unclear whether adopters need to see all system-managed labels or only the ones they might observe on their issues.
**Question**: Should the label protocol table include all labels (comprehensive reference) or only the labels adopters will observe or interact with?
**Options**:
- A) All labels, categorized: Show every label but clearly categorize into "you add", "you observe (system-managed)", and "system-internal" groups
- B) Adopter-relevant only: Only show labels the adopter adds (triggers, `completed:*`) and labels they'll see that require action (`waiting-for:*`, `agent:error`), omitting pure system-internal labels
- C) Two-tier: Show adopter-interaction labels in the main table with full explanations, and include a collapsible "all labels" appendix for completeness
**Answer**:

### Q5: Configuration Reference Scope
**Context**: FR-007 (P2) calls for an orchestrator configuration reference covering env vars and watched repos YAML. The existing Docusaurus docs already have a `reference/config/generacy.md` page covering configuration. The spec says to "focus on what adopters configure, not internal architecture," but the boundary between adopter-facing config and internal config isn't defined. For example: queue type (Redis/memory), worker concurrency, CORS settings, database URL — are these "adopter config" or "internal"?
**Question**: What configuration parameters should be included in this document's configuration reference section?
**Options**:
- A) Minimal setup only: Only the configuration needed to get started — GitHub webhook URL, watched repos YAML, and API token. Link to the existing config reference for everything else
- B) Operational config: Include setup config plus operational parameters adopters commonly tune — worker concurrency, timeout values, logging level, mode (local/cloud)
- C) Comprehensive: Include all user-facing configuration with descriptions, treating this as the primary config reference for adopters (may overlap with existing config docs)
**Answer**:

### Q6: Review Cycle Detail — Spec Review vs Plan Review vs PR Feedback
**Context**: FR-005 covers review cycles for specs, plans, and PR feedback. The spec mentions `waiting-for:spec-review`, `waiting-for:address-pr-feedback`, etc. But it doesn't specify how much detail each review type should get. Some review types (like spec review) involve reading a generated specification and providing feedback via comments, while PR feedback involves standard GitHub PR review mechanics. The adopter's action differs for each.
**Question**: Should all review cycle types get equal treatment, or should the document emphasize the most common/important ones?
**Options**:
- A) Equal treatment: Give each review type (spec, plan, tasks, PR feedback) its own subsection with the same level of detail — what the adopter sees, what they should do, and how to resume
- B) Prioritized: Give full walkthroughs for spec review and PR feedback (the most common interaction points), and briefly mention plan/tasks review as optional gates
- C) Unified pattern: Explain the general review pattern once (system pauses → adopter reviews → adopter signals completion), then list each review type with its specific label and what to look for
**Answer**:

### Q7: Error Recovery Instructions
**Context**: FR-008 (P2) covers error handling — `agent:error` label, `needs:intervention`, and retry via re-labeling. From the implementation, when an error occurs the system posts a comment with error details, exit code, and suggested next steps. But the spec doesn't clarify how much troubleshooting guidance adopters should receive. Should this section just explain the mechanism, or provide a mini troubleshooting guide?
**Question**: How detailed should the error handling section be?
**Options**:
- A) Mechanism only: Explain what `agent:error` means, that the system posts error details, and that you can retry by removing the error label and re-adding the trigger label
- B) Mechanism + common scenarios: Cover the mechanism plus 3-4 common error scenarios (timeout, context overflow, test failures, merge conflicts) with specific recovery steps
- C) Mechanism + decision tree: Provide the mechanism explanation plus a simple decision tree or flowchart — "Is it a timeout? Do X. Is it a test failure? Do Y. Otherwise, check the error comment."
**Answer**:

### Q8: Progressive Adoption Levels in Architecture Overview
**Context**: The existing documentation describes 4 adoption levels (Level 1: Agency only, Level 2: +Humancy, Level 3: +Local orchestration, Level 4: Cloud). The existing architecture overview already has deployment diagrams for local (Levels 1-3) and cloud (Level 4). This new adopter-focused doc covers the orchestrator and workflow system, which are Level 3+. The spec doesn't mention how to handle the fact that much of what's described only applies at certain adoption levels.
**Question**: Should the architecture overview mention adoption levels, or assume the reader is at Level 3+ (using the orchestrator)?
**Options**:
- A) Assume Level 3+: Don't mention adoption levels; write the entire document assuming the reader has or wants an orchestrator setup, and link to the getting-started docs for other levels
- B) Brief context: Include a short note at the top explaining that this doc covers the orchestrated workflow (Level 3+), with a link to the adoption path docs for readers exploring simpler setups
- C) Progressive structure: Structure sections to show what works at each level — e.g., "Workflow Lifecycle" applies to Level 3+, but "Customizing Workflows" could apply to Level 2+ with local execution
**Answer**:

### Q9: Tone and Voice
**Context**: The spec doesn't define the tone for the document. Looking at existing docs, the Docusaurus architecture overview uses a technical reference tone ("We chose Redis with BullMQ because..."), while getting-started guides use a more conversational, instructional tone. Since this document targets adopters evaluating or onboarding to Generacy, the tone should match the audience — but the spec doesn't specify whether this is a reference document or a narrative walkthrough.
**Question**: What tone should the architecture overview use?
**Options**:
- A) Conversational tutorial: Use second-person ("When you label an issue..."), step-by-step narration, and a friendly onboarding tone similar to the getting-started guides
- B) Technical reference: Use third-person ("The orchestrator monitors..."), structured tables, and a neutral reference tone similar to the existing architecture docs
- C) Hybrid: Use conversational tone for the narrative walkthrough sections (lifecycle, clarification cycles) and reference tone for the tables and configuration sections
**Answer**:

### Q10: Stage Comments — Should They Be Documented?
**Context**: The orchestrator creates and maintains "stage comments" on GitHub issues that show progress through phases (Specification, Planning, Implementation). These are a significant part of the adopter experience — they appear on every processed issue as structured comments with checkmarks and status updates. However, the spec doesn't mention stage comments at all. Adopters will see these comments and may need to understand what they are.
**Question**: Should the architecture overview document explain stage comments that appear on issues during processing?
**Options**:
- A) Yes, include: Add a brief explanation of stage comments in the "Workflow Lifecycle" section — what they look like, what information they contain, and that they update automatically
- B) No, omit: Stage comments are a UI detail, not an architectural concept; they'll be self-explanatory when adopters see them
- C) Mention briefly: Include a one-line note that "the system posts progress updates as comments on your issue" without going into detail about the stage comment format
**Answer**:

### Q11: Cross-Linking Strategy with Existing Documentation
**Context**: The Docusaurus site already has architecture, guides, configuration reference, and getting-started docs. This new document will overlap in scope with several existing pages. The spec says to "link to quickstart" (Section 1) and "link to detailed workflow authoring guide when available" (FR-006), but doesn't define a broader cross-linking strategy. Without a clear strategy, the document could either be too self-contained (duplicating content) or too sparse (requiring readers to jump between multiple pages).
**Question**: How should this document reference other documentation?
**Options**:
- A) Self-contained with links: Make the document readable end-to-end without clicking any links, but add "Learn more" links at the end of each section for readers who want depth
- B) Hub-and-spoke: Keep this document as a high-level overview that frequently links to existing detailed docs (config reference, getting-started, workflow authoring guide)
- C) Self-contained standalone: Since the spec says adopters should understand the system "without additional reading," make this fully self-contained with no required external links
**Answer**:

### Q12: Webhook vs Polling — What to Tell Adopters
**Context**: The spec mentions "webhook setup" in the configuration reference (Section 9) and the architecture shows GitHub communicating with the orchestrator. Internally, the system uses a webhook + polling hybrid approach for reliability. Adopters need to set up a GitHub webhook for real-time processing. However, the spec doesn't clarify how much of the webhook setup should be covered here vs. in a quickstart/installation guide.
**Question**: How much webhook/GitHub integration setup detail should this architecture overview include?
**Options**:
- A) Conceptual only: Explain that the orchestrator receives events from GitHub via webhooks, but defer all setup instructions to the quickstart/installation guide
- B) Setup included: Include step-by-step webhook setup (create webhook, set URL, select events, configure secret) as part of the configuration reference section
- C) Overview + link: Explain the webhook concept and what events are needed, then link to the quickstart for actual setup steps
**Answer**:

# Clarifications: Onboarding Slash Command Suite

## Batch 1 — 2026-03-14

### Q1: Command Packaging & Distribution
**Context**: The spec says commands are `.claude/commands/onboard-*.md` files distributed via cluster-base or devcontainer feature. However, existing speckit commands (`/specify`, `/clarify`, `/plan`, etc.) are packaged as an agency plugin (`agency-plugin-spec-kit`) and distributed via the agency marketplace — not as raw `.claude/commands/` files. This difference in distribution mechanism affects where the code lives, how it's versioned, and how users get updates.
**Question**: Should the onboarding commands be implemented as a new agency plugin package (like `agency-plugin-onboard`) distributed via the marketplace, or as raw `.claude/commands/*.md` files committed directly to cluster-base?
**Options**:
- A: New agency plugin package (`agency-plugin-onboard`) distributed via marketplace — consistent with speckit commands
- B: Raw `.claude/commands/*.md` files in cluster-base — simpler, no plugin infrastructure needed
- C: Raw command files initially (B), with a plan to migrate to a plugin package later

**Answer**: *Pending*

### Q2: Plugin Catalog Source
**Context**: `/onboard-plugins` needs to present available Generacy & Agency plugins with descriptions and recommend plugins based on the detected tech stack. Currently the only known plugin is `agency-plugin-spec-kit`. Without a defined catalog, the command cannot present meaningful choices or make recommendations.
**Question**: What is the initial set of plugins that `/onboard-plugins` should present? Should it discover plugins dynamically from the agency marketplace, or use a hardcoded list? If hardcoded, what plugins should be included?
**Options**:
- A: Hardcoded list of known plugins (specify which ones)
- B: Dynamic discovery from the agency marketplace registry
- C: Hardcoded initially with a TODO to switch to dynamic discovery once the marketplace API supports it

**Answer**: *Pending*

### Q3: MCP Server Catalog Source
**Context**: `/onboard-mcp` needs to present available MCP servers and recommend them based on project needs. Existing `.mcp.json` files in the codebase reference `playwright` and `vscode-mcp-server`, but there's no defined catalog of recommended servers or mapping from project characteristics to server recommendations.
**Question**: What MCP servers should `/onboard-mcp` be able to recommend, and how should it determine which to suggest? Should it use a hardcoded recommendation map (e.g., "web project → Playwright") or reference an external catalog?
**Options**:
- A: Hardcoded recommendation map based on detected tech stack (specify the initial set of servers)
- B: Reference an external MCP server registry/catalog
- C: Hardcoded map initially, extensible via a config file in `.generacy/` for custom additions

**Answer**: *Pending*

### Q4: Tech Stack Document Output
**Context**: `/onboard-stack` generates a "tech stack summary document" but the spec doesn't define the file name, format, or location. This affects whether other commands or tools can programmatically consume the output, and whether it integrates with existing documentation conventions.
**Question**: What file name, format, and location should `/onboard-stack` use for the tech stack summary?
**Options**:
- A: `.generacy/stack.yaml` — structured YAML, machine-readable, consumed by other onboarding commands
- B: `docs/tech-stack.md` — human-readable markdown in the conventional docs location
- C: Both — a structured `.generacy/stack.yaml` for tooling and a `docs/tech-stack.md` for humans

**Answer**: *Pending*

### Q5: Readiness Scoring Methodology
**Context**: `/onboard-evaluate` reports a "readiness score with specific gaps identified" but the spec doesn't define the scoring methodology. Without a defined system, different runs could produce inconsistent assessments, and it's unclear what threshold constitutes "ready" vs "needs work."
**Question**: What scoring methodology should `/onboard-evaluate` use? What are the weighted categories and what score threshold indicates readiness?
**Options**:
- A: Checklist-based (X of Y items complete) with categories: environment, configuration, permissions, documentation — no numeric threshold, just a gap list
- B: Percentage score (0-100%) with weighted categories and a defined "ready" threshold (e.g., 80%)
- C: Traffic-light per category (red/yellow/green) with an overall status derived from worst category

**Answer**: *Pending*

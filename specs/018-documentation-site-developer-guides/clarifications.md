# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-20 03:30

### Q1: Documentation Framework
**Context**: The spec lists both Docusaurus and VitePress as options. This affects the entire project setup, theming, plugin ecosystem, and developer experience.
**Question**: Which documentation framework should we use?
**Options**:
- A: Docusaurus - React-based, strong ecosystem, versioning support, heavier
- B: VitePress - Vue-based, fast, lightweight, simpler but less features

**Answer**: A - Docusaurus. React-based with strong ecosystem, versioning support for multi-component documentation, and good TypeDoc integration for API docs.

### Q2: Hosting Platform
**Context**: The spec lists both Vercel and GitHub Pages. This affects deployment workflow, custom domain setup, and potential costs.
**Question**: Which hosting platform should we use?
**Options**:
- A: Vercel - automatic deployments, preview URLs, analytics built-in
- B: GitHub Pages - free, simple, already integrated with repo

**Answer**: B - GitHub Pages. Simpler setup, already integrated with the repository. Deployment configuration can be deferred until the documentation is ready to go live.

### Q3: Diagram Tooling
**Context**: The spec lists Mermaid and Excalidraw. This affects how diagrams are created, maintained, and rendered in the docs.
**Question**: Which diagram tool should we use for architecture documentation?
**Options**:
- A: Mermaid - text-based, version-controllable, auto-renders in markdown
- B: Excalidraw - visual editor, hand-drawn aesthetic, exports as images
- C: Both - Mermaid for technical diagrams, Excalidraw for conceptual overviews

**Answer**: C - Both. Mermaid for technical diagrams (sequence diagrams, component interactions, data flows) - version-controllable and renders inline in markdown. Excalidraw for conceptual diagrams (the Triad, adoption path visuals) - hand-drawn aesthetic that matches the philosophical brand.

### Q4: MVP Scope Priority
**Context**: The scope is comprehensive covering getting started guides, API reference, plugin docs, and architecture. We need to prioritize for an initial release.
**Question**: What should be the MVP priority for the first release?
**Options**:
- A: Getting Started guides first - help new users onboard quickly
- B: API Reference first - enable developers to integrate immediately
- C: Architecture docs first - help contributors understand the system
- D: All sections in parallel - basic content for each

**Answer**: A - Getting Started guides first. Aligns with the progressive adoption path (Level 1: Agency Only → Level 4: Cloud). Getting Started guides for Levels 1-2 will drive initial adoption. API reference and architecture docs can follow.

### Q5: API Doc Generation
**Context**: The spec mentions TypeDoc + OpenAPI for API docs. We need to confirm the source of truth for API documentation.
**Question**: Where should API documentation be generated from?
**Options**:
- A: TypeDoc from TypeScript source code comments
- B: OpenAPI specs written manually
- C: Both - TypeDoc for internal APIs, OpenAPI for REST endpoints

**Answer**: C - Both. TypeDoc for npm packages (@generacy-ai/agency, @generacy-ai/contracts, plugins). OpenAPI for Generacy service REST endpoints (orchestrator, worker).


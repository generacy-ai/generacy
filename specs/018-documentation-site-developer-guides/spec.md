# Feature Specification: Documentation site and developer guides

**Branch**: `018-documentation-site-developer-guides` | **Date**: 2026-01-20 | **Status**: Clarified

## Summary

Create comprehensive documentation for the Generacy ecosystem.

## Scope

### Getting Started Guides

1. **Quick Start** - 5 minute setup
2. **Level 1: Agency Only** - Local agent enhancement
3. **Level 2: Agency + Humancy** - Human oversight
4. **Level 3: Local Orchestration** - Full local stack
5. **Level 4: Cloud** - Team/enterprise deployment

### Reference Documentation

#### API Reference
- Agency tool catalog
- Humancy commands
- Generacy API endpoints
- Contracts schemas

#### Configuration Reference
- Agency config options
- Humancy settings
- Generacy service config
- Plugin config schemas

### Developer Guides

#### Plugin Development
- Agency plugin tutorial
- Humancy plugin tutorial
- Generacy plugin tutorial
- Plugin manifest reference
- Channel communication

#### Integration Guides
- GitHub integration
- Jira integration
- Custom issue trackers
- Custom agent platforms

### Architecture Documentation

- System overview diagram
- Component interaction
- Data flow diagrams
- Security model
- Deployment architecture

## Tech Stack

- **Documentation framework**: Docusaurus (React-based with strong ecosystem, versioning support for multi-component documentation, and good TypeDoc integration)
- **API docs**: TypeDoc for npm packages (@generacy-ai/agency, @generacy-ai/contracts, plugins) + OpenAPI for Generacy service REST endpoints (orchestrator, worker)
- **Diagrams**: Both Mermaid (for technical diagrams: sequence diagrams, component interactions, data flows) and Excalidraw (for conceptual diagrams: the Triad, adoption path visuals)
- **Hosting**: GitHub Pages (simpler setup, already integrated with the repository)

## Site Structure

```
docs/
├── getting-started/
│   ├── quick-start.md
│   ├── installation.md
│   └── first-workflow.md
├── guides/
│   ├── agency/
│   ├── humancy/
│   └── generacy/
├── plugins/
│   ├── developing-plugins.md
│   ├── agency-plugins.md
│   ├── humancy-plugins.md
│   └── generacy-plugins.md
├── reference/
│   ├── api/
│   ├── config/
│   └── cli/
└── architecture/
    ├── overview.md
    ├── contracts.md
    └── security.md
```

## Acceptance Criteria

- [ ] Documentation site deployed
- [ ] Getting started guides complete
- [ ] API reference auto-generated
- [ ] Plugin development guide complete
- [ ] Architecture diagrams included

## MVP Priority

**Getting Started guides first** - aligns with the progressive adoption path (Level 1: Agency Only → Level 4: Cloud). Getting Started guides for Levels 1-2 will drive initial adoption. API reference and architecture docs can follow in subsequent iterations.

## User Stories

### US1: New Developer Onboarding

**As a** developer new to Generacy,
**I want** step-by-step getting started guides,
**So that** I can quickly set up and start using the platform.

**Acceptance Criteria**:
- [ ] Quick Start guide enables setup in under 5 minutes
- [ ] Level 1 guide covers Agency-only local setup
- [ ] Level 2 guide covers Agency + Humancy integration

### US2: Plugin Developer

**As a** developer wanting to extend Generacy,
**I want** plugin development documentation,
**So that** I can build custom plugins for Agency, Humancy, or Generacy.

**Acceptance Criteria**:
- [ ] Plugin tutorial available for each component
- [ ] Plugin manifest reference documented
- [ ] Channel communication patterns explained

### US3: Integration Developer

**As a** developer integrating Generacy with external tools,
**I want** API reference documentation,
**So that** I can programmatically interact with Generacy services.

**Acceptance Criteria**:
- [ ] TypeDoc-generated API docs for npm packages
- [ ] OpenAPI-generated docs for REST endpoints
- [ ] Example code snippets included

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Docusaurus site setup with responsive design | P1 | |
| FR-002 | Getting Started guides (Quick Start, Levels 1-2) | P1 | MVP scope |
| FR-003 | TypeDoc integration for npm package documentation | P2 | |
| FR-004 | OpenAPI integration for REST endpoint documentation | P2 | |
| FR-005 | Mermaid diagram support for technical diagrams | P1 | |
| FR-006 | Excalidraw diagrams for conceptual content | P2 | |
| FR-007 | GitHub Pages deployment configuration | P1 | |
| FR-008 | Plugin development guides | P2 | |
| FR-009 | Architecture documentation with diagrams | P3 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Quick Start completion time | < 5 minutes | User testing |
| SC-002 | Documentation site accessibility | WCAG 2.1 AA | Automated audit |
| SC-003 | API documentation coverage | 100% public APIs | TypeDoc/OpenAPI generation |

## Assumptions

- Docusaurus 3.x is stable and suitable for the project
- GitHub Pages provides sufficient hosting for the documentation traffic
- Existing codebase has TypeScript comments suitable for TypeDoc generation

## Out of Scope

- Video tutorials (text/diagram-based only for MVP)
- Multi-language translations
- Level 3-4 getting started guides (deferred to later iteration)
- Interactive playground/sandbox environments

---

*Generated by speckit*

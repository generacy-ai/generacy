# Implementation Plan: Documentation site and developer guides

**Feature**: Create comprehensive documentation for the Generacy ecosystem
**Branch**: `018-documentation-site-developer-guides`
**Status**: Complete

## Summary

Build a Docusaurus-based documentation site with progressive getting started guides, auto-generated API reference, and architecture documentation. The site will be hosted on GitHub Pages and follow the progressive adoption path from Agency-only setup to full cloud deployment.

## Technical Context

### Language & Framework
- **Documentation**: Docusaurus 3.x (React-based)
- **Language**: TypeScript/MDX for documentation components
- **Build**: Node.js 20+ with npm workspaces

### Key Dependencies
- `@docusaurus/core` - Core Docusaurus framework
- `@docusaurus/preset-classic` - Classic theme preset
- `docusaurus-plugin-typedoc` - TypeDoc integration for API docs
- `@mdx-js/mdx` - MDX support for interactive docs
- `mermaid` - Technical diagram rendering

### External Services
- GitHub Pages - Static site hosting
- GitHub Actions - CI/CD for documentation deployment

## Project Structure

```
docs/                                    # Docusaurus documentation site root
├── docusaurus.config.ts                 # Main Docusaurus configuration
├── sidebars.ts                          # Sidebar navigation configuration
├── package.json                         # Documentation site dependencies
├── tsconfig.json                        # TypeScript configuration
├── static/
│   ├── img/
│   │   ├── logo.svg                     # Generacy logo
│   │   ├── favicon.ico                  # Browser favicon
│   │   └── diagrams/                    # Excalidraw exported diagrams
│   │       ├── triad-overview.png       # The Triad conceptual diagram
│   │       └── adoption-path.png        # Adoption levels visual
│   └── api/                             # Generated OpenAPI specs
│       └── orchestrator.yaml            # Orchestrator REST API spec
├── docs/
│   ├── intro.md                         # Introduction/landing page
│   ├── getting-started/
│   │   ├── _category_.json              # Category metadata
│   │   ├── quick-start.md               # 5-minute quick start
│   │   ├── installation.md              # Detailed installation guide
│   │   ├── level-1-agency-only.md       # Agency-only setup
│   │   └── level-2-agency-humancy.md    # Agency + Humancy integration
│   ├── guides/
│   │   ├── _category_.json
│   │   ├── agency/
│   │   │   ├── overview.md              # Agency overview
│   │   │   └── configuration.md         # Agency configuration
│   │   ├── humancy/
│   │   │   ├── overview.md              # Humancy overview
│   │   │   └── configuration.md         # Humancy configuration
│   │   └── generacy/
│   │       ├── overview.md              # Generacy overview
│   │       └── configuration.md         # Generacy configuration
│   ├── plugins/
│   │   ├── _category_.json
│   │   ├── developing-plugins.md        # Plugin development overview
│   │   ├── agency-plugins.md            # Agency plugin tutorial
│   │   ├── humancy-plugins.md           # Humancy plugin tutorial
│   │   ├── generacy-plugins.md          # Generacy plugin tutorial
│   │   └── manifest-reference.md        # Plugin manifest reference
│   ├── reference/
│   │   ├── _category_.json
│   │   ├── api/
│   │   │   └── index.md                 # API reference landing
│   │   ├── config/
│   │   │   ├── agency.md                # Agency config options
│   │   │   ├── humancy.md               # Humancy config options
│   │   │   └── generacy.md              # Generacy config options
│   │   └── cli/
│   │       └── commands.md              # CLI command reference
│   └── architecture/
│       ├── _category_.json
│       ├── overview.md                  # System overview with Mermaid diagrams
│       ├── contracts.md                 # Contract schemas documentation
│       └── security.md                  # Security model documentation
├── src/
│   ├── components/
│   │   ├── AdoptionLevel/
│   │   │   └── index.tsx                # Adoption level card component
│   │   └── DiagramEmbed/
│   │       └── index.tsx                # Excalidraw diagram embed component
│   ├── css/
│   │   └── custom.css                   # Custom styling overrides
│   └── pages/
│       └── index.tsx                    # Custom landing page
├── api/                                 # TypeDoc generated output directory
│   └── .gitkeep
└── blog/                                # Optional blog for updates
    └── .gitkeep

.github/workflows/
└── docs.yml                             # GitHub Actions workflow for docs deployment
```

## Implementation Phases

### Phase 1: Project Setup
Set up Docusaurus project structure with basic configuration and GitHub Pages deployment.

### Phase 2: Getting Started Guides (MVP)
Create the core getting started documentation following the progressive adoption path.

### Phase 3: API Reference Integration
Configure TypeDoc and OpenAPI integration for auto-generated API documentation.

### Phase 4: Plugin Development Guides
Create comprehensive plugin development tutorials for all three components.

### Phase 5: Architecture Documentation
Add system architecture documentation with Mermaid and Excalidraw diagrams.

## Key Technical Decisions

1. **Docusaurus 3.x over VitePress**: Better ecosystem support, built-in versioning, superior TypeDoc integration
2. **GitHub Pages over Vercel**: Simpler setup, free hosting, native GitHub integration
3. **Dual diagram tools**: Mermaid for technical diagrams (version-controllable), Excalidraw for conceptual visuals (brand aesthetic)
4. **TypeDoc + OpenAPI**: TypeDoc for npm package APIs, OpenAPI for REST endpoints - comprehensive coverage
5. **Progressive adoption focus**: Getting started guides aligned with Level 1-4 adoption path

## Dependencies

### Internal Dependencies
- Existing TypeScript source with JSDoc comments (for TypeDoc)
- Orchestrator REST API (for OpenAPI spec)

### External Dependencies
- Node.js 20+
- GitHub repository access
- GitHub Pages configuration

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| TypeDoc coverage gaps | Medium | Audit and add missing JSDoc comments |
| Docusaurus breaking changes | Low | Pin to stable 3.x version |
| GitHub Pages build limits | Low | Optimize build size, use efficient assets |

## Success Metrics

- Quick Start completion time < 5 minutes
- WCAG 2.1 AA accessibility compliance
- 100% public API documentation coverage
- Documentation site loads in < 3 seconds

---

*Generated by speckit*

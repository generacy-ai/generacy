# Change Log

All notable changes to the Generacy VS Code Extension will be documented in this file.

## [0.1.0] - 2026-01-22

### Initial Release

#### Local Mode Features (FREE)
- **Workflow Explorer**: Tree view for managing `.generacy/*.yaml` workflow files
- **Workflow Editor**: YAML editing with IntelliSense, schema validation, and diagnostics
- **Workflow Runner**: Local workflow execution with real-time output and environment configuration
- **Workflow Debugger**: Full Debug Adapter Protocol support with breakpoints, step-through execution, and state inspection

#### Cloud Mode Features (Paid)
- **Organization Dashboard**: Overview of connected organization, members, and usage
- **Workflow Queue**: View and manage active, pending, and completed cloud workflows
- **Integration Management**: GitHub App and other integration connections
- **Publishing**: Push local workflows to cloud with version management and rollback

#### Other Features
- GitHub OAuth authentication
- Template library with starter workflows
- Dry-run mode for validation
- Progressive authentication (anonymous → free → organization)
- Comprehensive error handling and user feedback

---

## Release Format

Versions follow [Semantic Versioning](https://semver.org/):
- **Major**: Breaking changes
- **Minor**: New features (backwards compatible)
- **Patch**: Bug fixes (backwards compatible)

Release categories:
- `Added` for new features
- `Changed` for changes in existing functionality
- `Deprecated` for soon-to-be removed features
- `Removed` for now removed features
- `Fixed` for any bug fixes
- `Security` for vulnerability fixes

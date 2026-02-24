# Feature Specification: Set up npm publishing for @generacy-ai packages

**Branch**: `242-1-1-set-up` | **Date**: 2026-02-24 | **Status**: Draft

## Summary

Establish automated npm package publishing infrastructure for the @generacy-ai organization supporting dual release streams: preview releases from `develop` branch and stable releases from `main` branch. This foundation enables consistent, reliable package distribution across the latency, agency, and generacy repositories with proper versioning, branch protection, and changesets integration.

## User Stories

### US1: Automated Preview Publishing

**As a** developer working on @generacy-ai packages,
**I want** automated preview releases when code merges to `develop`,
**So that** I can test integration changes across packages before stable release.

**Acceptance Criteria**:
- [ ] Merging to `develop` triggers automated npm publish with `@preview` dist-tag
- [ ] Preview versions follow format `1.0.0-preview.YYYYMMDD` or similar snapshot format
- [ ] `npm install @generacy-ai/latency@preview` installs latest preview version
- [ ] GitHub Actions workflow runs successfully for preview publish
- [ ] Published package includes correct metadata and dependencies

### US2: Stable Release Publishing

**As a** package maintainer,
**I want** controlled stable releases via changesets when merging to `main`,
**So that** consumers get predictable, semantic-versioned stable packages.

**Acceptance Criteria**:
- [ ] Merging to `main` triggers changesets release workflow
- [ ] Stable versions published with `@latest` dist-tag
- [ ] Version numbers follow semantic versioning (semver)
- [ ] `npm info @generacy-ai/latency` returns package metadata
- [ ] Changelog automatically generated from changesets
- [ ] Release tags created in git

### US3: Secure Publishing Configuration

**As a** DevOps engineer,
**I want** secure, organization-level npm authentication,
**So that** all repositories can publish without individual token management.

**Acceptance Criteria**:
- [ ] `NPM_TOKEN` configured as GitHub organization secret
- [ ] Token has publish permissions for @generacy-ai scope
- [ ] All three repositories (latency, agency, generacy) can access the token
- [ ] Token rotation process documented
- [ ] No tokens committed to repository code

### US4: Branch Protection and Workflow

**As a** repository maintainer,
**I want** protected `main` branches with required CI checks,
**So that** only validated code reaches stable releases.

**Acceptance Criteria**:
- [ ] Branch protection enabled on `main` for all public repos
- [ ] Pull requests required for merging to `main`
- [ ] CI checks must pass before merge
- [ ] `main` branch established with initial merge from `develop`
- [ ] Protection rules consistent across latency, agency, and generacy

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Configure npm organization `@generacy-ai` with appropriate permissions | P0 | Foundation requirement |
| FR-002 | Create `NPM_TOKEN` with publish access to @generacy-ai scope | P0 | Required for automation |
| FR-003 | Store `NPM_TOKEN` as GitHub organization secret | P0 | Accessible to all repos |
| FR-004 | Install and configure changesets in all three repositories | P1 | Version management |
| FR-005 | Create GitHub Actions workflow for preview publishing on `develop` merge | P1 | Preview stream |
| FR-006 | Create GitHub Actions workflow for stable publishing on `main` merge via changesets | P1 | Stable stream |
| FR-007 | Configure dist-tags: `@preview` for develop, `@latest` for main | P1 | Release differentiation |
| FR-008 | Implement versioning strategy for preview snapshots (date-based or commit-based) | P1 | Consistent preview versions |
| FR-009 | Enable branch protection on `main` across all public repositories | P1 | Quality control |
| FR-010 | Set branch protection rules: require PR, require CI status checks | P1 | Validation gates |
| FR-011 | Merge current `develop` to `main` to establish baseline | P2 | Branch synchronization |
| FR-012 | Document publish order: latency → agency → generacy | P2 | Dependency-aware publishing |
| FR-013 | Create publishing documentation for maintainers | P2 | Knowledge transfer |
| FR-014 | Configure package.json metadata (publishConfig, repository, etc.) | P1 | npm registry requirements |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Package discoverability | `npm info @generacy-ai/latency` returns valid metadata | Run npm info command |
| SC-002 | Preview publishing success rate | 100% of `develop` merges publish successfully | GitHub Actions logs |
| SC-003 | Stable publishing success rate | 100% of `main` merges with changesets publish successfully | GitHub Actions logs |
| SC-004 | Branch protection coverage | 100% of public repos have `main` protected | GitHub settings audit |
| SC-005 | Time to publish | Packages available on npm within 5 minutes of merge | Workflow duration metrics |
| SC-006 | Version correctness | All published versions follow semver and dist-tag conventions | npm registry inspection |
| SC-007 | Documentation completeness | Publishing process documented and accessible to all maintainers | Documentation review |

## Technical Architecture

### Repositories in Scope
1. **@generacy-ai/latency** - Foundation package (publish first)
2. **@generacy-ai/agency** - Depends on latency (publish second)
3. **@generacy-ai/generacy** - Depends on agency (publish third)

### Versioning Strategy
- **Preview releases**: `<major>.<minor>.<patch>-preview.<timestamp>` (e.g., `1.0.0-preview.20260224`)
- **Stable releases**: Semver via changesets (e.g., `1.0.0`, `1.0.1`, `1.1.0`)
- Changesets manage version bumps and changelog generation

### GitHub Actions Workflows

**Preview Workflow** (`.github/workflows/publish-preview.yml`):
```yaml
trigger: push to develop
steps:
  1. Checkout code
  2. Setup Node.js and pnpm
  3. Install dependencies
  4. Build package
  5. Generate preview version
  6. Publish with --tag preview
  7. Comment PR with published version
```

**Stable Workflow** (`.github/workflows/publish-stable.yml`):
```yaml
trigger: push to main
steps:
  1. Checkout code
  2. Setup Node.js and pnpm
  3. Install dependencies
  4. Build package
  5. Run changesets publish
  6. Create GitHub release
  7. Update changelog
```

### Branch Strategy
- **develop**: Default branch for active development
- **main**: Stable release branch (30-180 commits behind, needs sync)
- Feature branches merge to `develop` via PR
- `develop` merges to `main` for stable releases

## Assumptions

- npm organization `@generacy-ai` already exists or can be created
- Team has npm organization admin access to create publish tokens
- GitHub organization admins can create organization-level secrets
- All repositories use pnpm as package manager
- Repositories have build scripts that produce publishable artifacts
- CI/CD infrastructure (GitHub Actions) is available and configured
- Package names are available on npm registry (not squatted)
- Current code in `develop` is stable enough to establish `main` baseline
- Dependencies between packages (latency → agency → generacy) are correctly configured

## Out of Scope

- **Private package publishing**: Only public packages under @generacy-ai scope
- **Multi-registry support**: Only npm registry (no GitHub Packages, Artifactory, etc.)
- **Automated dependency updates**: Renovate/Dependabot configuration deferred
- **Package deprecation workflows**: Manual deprecation only
- **Beta/RC release channels**: Only preview and stable streams
- **Monorepo consolidation**: Each package remains in separate repository
- **Automated rollback**: Manual version rollback if issues arise
- **Performance testing**: Publishing workflow performance optimization deferred
- **Analytics/telemetry**: Package download tracking not included
- **Access control management**: npm organization member management is manual
- **License compliance scanning**: License validation outside scope
- **Security scanning**: npm audit integration deferred to separate initiative

## Implementation Phases

### Phase 1: Foundation (Immediate)
- Create/verify npm organization
- Generate and store NPM_TOKEN
- Configure GitHub organization secret
- Document token rotation process

### Phase 2: Repository Setup (Week 1)
- Install changesets in all repositories
- Configure package.json publishConfig
- Create preview publishing workflow
- Create stable publishing workflow
- Test workflows in latency repository

### Phase 3: Branch Management (Week 1)
- Enable branch protection on `main` branches
- Configure protection rules (PR required, CI required)
- Synchronize `develop` to `main` (initial merge)
- Verify CI passes on `main`

### Phase 4: Rollout (Week 2)
- Deploy workflows to agency repository
- Deploy workflows to generacy repository
- Execute first preview publish from each repo
- Execute first stable publish from latency
- Verify dependency chain (latency → agency → generacy)

### Phase 5: Documentation (Week 2)
- Document publishing process
- Create runbook for common issues
- Document version management with changesets
- Share knowledge with team

## Dependencies

- None (Phase 1 foundation task, no blockers)

## Related Issues

- Issue 1.2: Latency package publishing implementation
- Issue 1.3: Agency package publishing implementation
- Issue 1.4: Generacy package publishing implementation
- Parent: [onboarding-buildout-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| NPM_TOKEN exposure | High | Use GitHub secrets, implement rotation, audit access logs |
| Breaking changes in preview | Medium | Clear dist-tag separation, documentation warns preview is unstable |
| Publish order violation | Medium | Document dependency order, consider monorepo in future |
| Version conflicts | Medium | Changesets enforces semver, preview uses timestamps |
| CI failures block publishing | Low | Require passing tests, maintain high test reliability |
| `main` branch divergence | Low | Regular develop→main merges, branch protection prevents drift |

---

*Generated by speckit on 2026-02-24*

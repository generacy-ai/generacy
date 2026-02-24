# Research: npm Publishing Infrastructure

**Feature**: 242-1-1-set-up
**Date**: 2026-02-24

## Overview

This document provides technical research and decision-making rationale for establishing npm publishing infrastructure for the @generacy-ai organization.

---

## Changesets Deep Dive

### What is Changesets?

Changesets is a versioning and changelog management tool designed for monorepos, though it works equally well with single-package repos. It provides:

1. **Intent-based versioning**: Developers declare what changed and the semver impact
2. **Changelog generation**: Automatic changelog from changeset descriptions
3. **Workspace support**: Handles dependencies between packages in monorepos
4. **Snapshot releases**: Preview versions without consuming semver versions

### How Changesets Works

#### Developer Workflow

```bash
# 1. Make code changes
vim src/feature.ts

# 2. Create changeset (run at repo root)
pnpm changeset

# Interactive prompts:
# - Which packages changed? (multi-select in monorepo)
# - What type of change? patch/minor/major
# - Describe the change (becomes changelog entry)

# 3. Result: .changeset/random-words-here.md
```

**Changeset File Format**:
```markdown
---
"@generacy-ai/latency": patch
---

Fix type inference for plugin configuration
```

#### Release Workflow

**Option 1: Manual (not used in this setup)**
```bash
pnpm changeset version  # Bump versions, update CHANGELOGs
git add .
git commit -m "Version packages"
pnpm changeset publish  # Publish to npm
git push --follow-tags
```

**Option 2: Automated via GitHub Actions (our approach)**

On merge to main:
1. Changesets Action runs
2. If changesets exist → Create "Version Packages" PR
3. PR contains:
   - Version bumps in package.json
   - CHANGELOG.md updates
   - Consumed changeset files deleted
4. Merging PR triggers publish

### Snapshot Releases

**Command**: `pnpm changeset version --snapshot preview`

**Behavior**:
- Generates version like `1.0.0-preview-20260224143022`
- Does NOT consume changesets (they remain for stable release)
- Does NOT update CHANGELOG.md
- Uses current base version + snapshot suffix

**Use Case**: Preview releases on develop branch

**Publish**: `pnpm changeset publish --no-git-tag --tag preview`
- `--no-git-tag`: Don't create git tags for snapshots
- `--tag preview`: Publish to npm with `@preview` dist-tag

### Configuration Options

**`.changeset/config.json`**:

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.1.1/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "develop",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

**Key Fields**:

- **changelog**: Changelog generator to use
  - `@changesets/cli/changelog` - Default, simple format
  - `@changesets/changelog-github` - Includes GitHub usernames/PR links
  - Custom: Create your own generator

- **commit**: Whether to auto-commit version changes
  - `false` - Manual commit (used in CI workflows)
  - `true` - Auto-commit (used for local releases)

- **fixed**: Packages that always version together
  - Example: `[["@myorg/pkg-a", "@myorg/pkg-b"]]`
  - All packages bump to same version

- **linked**: Packages that share version numbers but can have independent changes
  - Similar to fixed but more flexible

- **access**: Default npm access level
  - `"public"` - Required for scoped packages on public npm
  - `"restricted"` - Private packages (requires paid npm org)

- **baseBranch**: Branch used as comparison base
  - `"develop"` - Track changes from develop
  - `"main"` - Track changes from main

- **updateInternalDependencies**: How to bump internal workspace deps
  - `"patch"` - Always bump to patch
  - `"minor"` - Always bump to minor
  - `"major"` - Only bump if dependency had major change

- **ignore**: Packages to exclude from versioning
  - Example: `["@myorg/internal-tooling"]`

### Changesets + GitHub Action

**`changesets/action@v1`** provides:

1. **Automatic PR Creation**: Detects changesets, creates version PR
2. **Automatic Publishing**: Publishes when version PR is merged
3. **Idempotent**: Safe to re-run
4. **Comments**: Can comment on PRs with published versions

**Basic Usage**:

```yaml
- name: Create Release PR or Publish
  uses: changesets/action@v1
  with:
    version: pnpm changeset version
    publish: pnpm changeset publish
    commit: "chore: version packages"
    title: "chore: version packages"
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Advanced Options**:

```yaml
- uses: changesets/action@v1
  with:
    version: pnpm changeset version
    publish: pnpm exec changeset publish
    commit: "chore: release"
    title: "chore: release packages"
    createGithubReleases: true  # Create GitHub releases
    cwd: "./packages"  # Run in subdirectory
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

---

## npm Dist-Tags

### What are Dist-Tags?

Dist-tags are labels for different release channels in npm. They allow multiple versions to coexist with different "latest" pointers.

**Default Tag**: `latest` (what `npm install` uses)

**Common Tags**:
- `latest` - Stable releases
- `next` - Beta/RC releases
- `canary` - Nightly/bleeding-edge
- `preview` - Preview releases (our usage)

### Publishing with Tags

```bash
# Publish to @latest (default)
npm publish

# Publish to @preview
npm publish --tag preview

# Publish to @next
npm publish --tag next
```

### Installing with Tags

```bash
# Install latest (default)
npm install @generacy-ai/latency

# Install preview
npm install @generacy-ai/latency@preview

# Install specific version
npm install @generacy-ai/latency@1.0.0-preview.20260224143022
```

### Viewing Tags

```bash
# List all tags for a package
npm dist-tag ls @generacy-ai/latency

# Output:
# latest: 1.0.0
# preview: 1.0.0-preview.20260224143022
```

### Managing Tags

```bash
# Add a tag
npm dist-tag add @generacy-ai/latency@1.0.0 stable

# Remove a tag
npm dist-tag rm @generacy-ai/latency preview

# Change what a tag points to
npm dist-tag add @generacy-ai/latency@1.1.0 latest
```

### Dist-Tag Strategy for @generacy-ai

| Tag | Version Format | Updated When | Use Case |
|-----|----------------|--------------|----------|
| `@latest` | `1.0.0` | Merge to main | Stable releases for production |
| `@preview` | `1.0.0-preview.YYYYMMDDHHmmss` | Merge to develop | Preview releases for testing |

**Why Two Tags?**
- Separates stable from experimental
- Users explicitly opt-in to preview versions
- `npm install` defaults to stable
- Tooling can easily target preview channel

---

## npm Access Tokens

### Token Types

1. **Legacy Tokens** (deprecated)
   - Full access to account
   - Not recommended for automation

2. **Granular Access Tokens** (recommended)
   - **Automation**: For CI/CD pipelines
   - **Publish**: For publishing packages
   - **Read-only**: For installing private packages

### Creating Automation Token

1. Log in to npmjs.com
2. Navigate to Access Tokens (avatar → Access Tokens)
3. Generate New Token → Automation
4. Select permissions:
   - Read and write (for publishing)
   - Select packages (optional, for granular control)
5. Copy token (only shown once)

### Token Permissions

**Automation Tokens** can:
- Publish packages
- Deprecate packages
- Manage dist-tags
- Read package metadata

**Best Practices**:
- One token per CI system
- Rotate tokens regularly (annually)
- Use granular tokens (limit to specific packages if possible)
- Store in secrets management (GitHub Secrets, Vault, etc.)
- Monitor usage (npm shows last used date)

### Token Expiration

- **Automation tokens**: No expiration by default
- **Publish tokens**: 30-day expiration
- **Read-only tokens**: No expiration

**Recommendation**: Set a reminder to rotate tokens annually, even if they don't expire.

### Verifying Token

```bash
# Test token locally
npm whoami --registry=https://registry.npmjs.org

# Use token in CI
echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > ~/.npmrc
npm whoami
```

---

## GitHub Actions: Secrets Management

### Organization vs Repository Secrets

**Organization Secrets**:
- Shared across all repos in org
- Centralized management
- Can limit access to specific repos
- **Our usage**: `NPM_TOKEN` (used by all public repos)

**Repository Secrets**:
- Scoped to single repo
- Managed per-repo
- More granular control
- **Our usage**: Repo-specific tokens (if needed)

### Creating Organization Secret

1. Navigate to GitHub org settings
2. Secrets and variables → Actions
3. New organization secret
4. Name: `NPM_TOKEN`
5. Value: `npm_...` (paste token)
6. Repository access:
   - **Public repositories** (our choice)
   - Private repositories
   - Selected repositories

### Using Secrets in Workflows

```yaml
steps:
  - uses: actions/setup-node@v4
    with:
      node-version: 20
      registry-url: 'https://registry.npmjs.org'

  - run: npm publish
    env:
      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Note**: `NODE_AUTH_TOKEN` is the convention used by `actions/setup-node`.

### Security Best Practices

- Never log secret values
- Use `::add-mask::` if you must reference secrets
- Limit secret access to necessary repos
- Rotate secrets on suspected compromise
- Use GitHub's secret scanning

---

## Branch Protection

### Required Status Checks

**Purpose**: Ensure code quality before merge

**Our Configuration**:
- `lint` - Code style and static analysis
- `test` - Test suite pass
- `build` - Successful build

**Benefits**:
- Prevents breaking changes from merging
- Ensures consistent code quality
- Automates gate-keeping

### Require Pull Request Reviews

**Purpose**: Human oversight on changes to main

**Configuration**:
- Required reviewers: 1
- Dismiss stale reviews: Yes
- Require review from code owners: Optional (if CODEOWNERS exists)

### Restrict Force Pushes

**Purpose**: Prevent history rewriting

**Exception**: Allow force push for initial main/develop sync, then enable restriction.

### Status Check: "Require branches to be up to date"

**Enabled**: Ensures branch has latest main commits before merge

**Trade-off**:
- ✅ Prevents merge conflicts
- ✅ Ensures CI runs on final merge state
- ❌ Requires rebasing/merging main before merge (can be tedious)

**Recommendation**: Enable for main branch (stability critical)

---

## Monorepo vs Polyrepo Publishing

### Current Setup: Polyrepo (3 separate repos)

**Pros**:
- Independent CI/CD per repo
- Clear ownership boundaries
- Easier to understand for contributors
- No tooling complexity

**Cons**:
- Dependency coordination required
- Publish order must be enforced
- Cross-repo changes need multiple PRs
- Version drift possible

### Monorepo Alternative

**Pros**:
- Single CI run for all packages
- Atomic cross-package changes
- Automatic dependency resolution
- Tools like Turborepo, Nx optimize builds

**Cons**:
- More complex setup
- Larger repo size
- All-or-nothing CI (one failure blocks all)
- Migration effort

### Why Polyrepo for @generacy-ai

**Current State**: Already using polyrepo structure

**Rationale**:
1. **Separation of concerns**: Latency (core), Agency (tools), Generacy (orchestration) are distinct products
2. **Independent evolution**: Each can version independently
3. **Clear boundaries**: External consumers understand package relationships
4. **Existing structure**: Migration to monorepo is significant effort

**Mitigation for Cons**:
- Dependency verification in CI
- Documented publish order
- Automated dependency update PRs (Q8 clarification)

---

## Alternative: semantic-release

### What is semantic-release?

Automated versioning and publishing based on commit messages following Conventional Commits.

**Workflow**:
1. Write commits like: `feat: add new feature` or `fix: resolve bug`
2. semantic-release analyzes commits
3. Determines semver bump (feat → minor, fix → patch)
4. Publishes to npm

### Why Changesets Over semantic-release?

| Feature | Changesets | semantic-release |
|---------|------------|------------------|
| **Commit format** | Freeform (changeset describes change) | Strict (conventional commits) |
| **Changelog control** | Explicit (write description in changeset) | Automatic (from commit messages) |
| **Monorepo support** | Excellent (designed for it) | Complex (needs plugins) |
| **Preview releases** | Built-in (snapshot mode) | Requires configuration |
| **Learning curve** | Low (run `changeset`, follow prompts) | Medium (learn commit conventions) |
| **Flexibility** | High (can edit changesets before release) | Low (commits are immutable) |

**Decision**: Changesets chosen for:
- Better monorepo support
- More control over changelog
- Flexibility to fix mistakes before release
- Simpler contributor experience (no commit message discipline required)

---

## Idempotent Publishing

### What is Idempotency?

An operation is idempotent if running it multiple times produces the same result as running it once.

**Why Important for Publishing?**
- Workflows may fail mid-execution
- Need to re-run without causing issues
- Should handle "already published" gracefully

### Making npm publish Idempotent

**Problem**: `npm publish` fails if version already exists

```
npm ERR! code E403
npm ERR! 403 Forbidden - PUT https://registry.npmjs.org/@generacy-ai/latency - You cannot publish over the previously published versions
```

**Solution 1: Check before publish**

```bash
# Check if version exists on npm
if npm view @generacy-ai/latency@$(node -p "require('./package.json').version") version 2>/dev/null; then
  echo "Version already published, skipping"
  exit 0
fi

npm publish
```

**Solution 2: Catch error and verify**

```bash
# Attempt publish, catch error
if ! npm publish 2>publish-error.log; then
  # Check if error is "already published"
  if grep -q "cannot publish over" publish-error.log; then
    echo "Version already published, skipping"
    exit 0
  else
    # Real error, fail
    cat publish-error.log
    exit 1
  fi
fi
```

**Solution 3: Use npm-publish-automation library**

```bash
# Use package that handles idempotency
npx npm-publish-if-needed
```

**Recommendation**: Solution 1 (explicit check) is clearest and most reliable.

---

## Preview Version Freshness

### Problem: How do consumers know which preview is latest?

**Scenario**:
```
@generacy-ai/latency@1.0.0-preview.20260224143022
@generacy-ai/latency@1.0.0-preview.20260225091504
@generacy-ai/latency@1.0.0-preview.20260225160832
```

**Solution 1: Use dist-tag (our approach)**

```bash
npm install @generacy-ai/latency@preview
# Always gets the most recent preview published
```

**How it works**:
- Each publish updates the `@preview` dist-tag to point to latest
- Users don't need to know exact version
- npm handles "latest preview" resolution

**Solution 2: Version sorting**

```bash
npm view @generacy-ai/latency versions --json | jq '.[] | select(contains("preview"))' | sort -r | head -1
```

**Downside**: Requires tooling, not user-friendly

### Preview Tag Management in CI

```yaml
- name: Publish Preview
  run: |
    pnpm changeset publish --no-git-tag --tag preview

# The --tag preview ensures:
# 1. Packages are published with @preview tag
# 2. @preview tag is updated to latest published version
# 3. @latest tag is NOT updated (stable releases only)
```

---

## Cross-Package Dependency Management

### The Challenge

**Scenario**:
1. Latency publishes `1.0.0-preview.20260224143022`
2. Agency depends on `@generacy-ai/latency`
3. How does Agency update to test new latency preview?

### Solution 1: Manual Updates (baseline)

```bash
# In agency repo
pnpm add @generacy-ai/latency@preview
git commit -am "chore: update latency to latest preview"
```

**Pros**: Simple, explicit control
**Cons**: Manual, easy to forget, not automated

### Solution 2: Automated Dependency Update PRs (Q8 decision)

**Workflow**:
1. Latency publishes preview
2. Latency workflow triggers repository_dispatch to agency
3. Agency workflow runs:
   - Updates package.json to latest preview
   - Runs CI tests
   - Creates PR if tests pass
   - Tags PR with `dependencies` label

**Implementation**:

**In latency/.github/workflows/publish-preview.yml**:
```yaml
- name: Trigger Agency Update
  if: success()
  uses: peter-evans/repository-dispatch@v2
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    repository: generacy-ai/agency
    event-type: latency-preview-published
    client-payload: |
      {
        "version": "${{ steps.get-version.outputs.version }}"
      }
```

**In agency/.github/workflows/dependency-update.yml**:
```yaml
on:
  repository_dispatch:
    types: [latency-preview-published]

jobs:
  update-dependency:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Update Latency Dependency
        run: |
          pnpm add @generacy-ai/latency@${{ github.event.client_payload.version }}

      - name: Run Tests
        run: pnpm test

      - name: Create PR
        uses: peter-evans/create-pull-request@v5
        with:
          branch: deps/latency-preview-${{ github.event.client_payload.version }}
          title: "chore: update @generacy-ai/latency to ${{ github.event.client_payload.version }}"
          body: |
            Automated dependency update triggered by latency preview publish.

            **Version**: ${{ github.event.client_payload.version }}
            **Tests**: ✅ Passing
          labels: dependencies, automated
```

**Pros**:
- Fully automated
- Tests run before PR created
- Clear visibility of dependency updates
- Catches breaking changes early

**Cons**:
- More complex CI setup
- Requires cross-repo workflows
- Can create PR noise if many previews published

**Recommendation**: Implement in Phase 2 or 3 (after basic publishing works)

---

## npm Package Metadata Best Practices

### Essential package.json Fields

```json
{
  "name": "@generacy-ai/latency",
  "version": "0.0.0",
  "description": "Core latency framework for Generacy",
  "license": "MIT",
  "author": "Generacy AI",
  "repository": {
    "type": "git",
    "url": "https://github.com/generacy-ai/latency.git"
  },
  "bugs": {
    "url": "https://github.com/generacy-ai/latency/issues"
  },
  "homepage": "https://github.com/generacy-ai/latency#readme",
  "keywords": [
    "latency",
    "generacy",
    "mcp",
    "agent-framework"
  ],
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "publishConfig": {
    "access": "public"
  }
}
```

### Fields Explained

**name**: Scoped package name
- Must match npm org scope
- Lowercase, hyphen-separated

**version**: Managed by changesets
- Start at `0.0.0` or `0.1.0`
- Changesets updates this

**description**: Short description for npm search

**license**: Open source license
- `MIT` is most permissive
- `Apache-2.0` for patent protection
- `ISC` similar to MIT

**repository**: Links to source code
- Helps users find issues/PRs
- Shows on npm package page

**keywords**: For npm search discoverability

**main**: CommonJS entry point (Node.js)

**types**: TypeScript definitions

**exports**: Modern entry points
- Supports ESM/CJS dual publish
- Per-export type definitions
- Subpath exports (e.g., `@pkg/core/utils`)

**files**: Explicit file inclusion
- Prevents accidental publish of src, tests, etc.
- Always includes: package.json, README.md, LICENSE

**publishConfig.access**: Required for public scoped packages

---

## Provenance and Supply Chain Security

### npm Provenance (New Feature)

npm now supports build provenance, linking published packages to source code and CI workflows.

**Benefits**:
- Verifies package was built in CI (not on developer's machine)
- Links package to exact commit and workflow run
- Increases trust for consumers

**Enabling Provenance**:

```yaml
- name: Publish with Provenance
  run: npm publish --provenance
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Requirements**:
- GitHub Actions (or other supported CI)
- Public repository (or enterprise plan)
- npm version 9.5.0+

**Viewing Provenance**:
```bash
npm view @generacy-ai/latency --json | jq .provenance
```

**Recommendation**: Enable provenance in Phase 3 workflows for supply chain transparency.

---

## Version Number Strategy

### Semantic Versioning (semver)

**Format**: `MAJOR.MINOR.PATCH`

- **MAJOR**: Breaking changes (v1 → v2)
- **MINOR**: New features, backward compatible
- **PATCH**: Bug fixes, backward compatible

### Pre-release Versions

**Format**: `MAJOR.MINOR.PATCH-PRERELEASE.IDENTIFIER`

Examples:
- `1.0.0-alpha.1` - Alpha release
- `1.0.0-beta.3` - Beta release
- `1.0.0-rc.1` - Release candidate
- `1.0.0-preview.20260224143022` - Preview/snapshot (our format)

### Initial Version Strategy

**Option 1: Start at 0.x.y**
- Signals "not stable yet"
- Breaking changes allowed in minor versions
- Move to 1.0.0 when stable

**Option 2: Start at 1.0.0**
- Signals confidence
- Full semver rules apply immediately
- Easier for consumers (no 0.x confusion)

**Recommendation for @generacy-ai**:

Given that the codebase is already mature (latency has 273 tests, agency has working MCP server):

- **latency**: Start at `1.0.0` (core framework is stable)
- **agency**: Start at `1.0.0` (proven in production use)
- **generacy**: Start at `0.1.0` (orchestration still evolving)

Changesets will handle bumping from there.

---

## Rollback and Deprecation

### Unpublishing Packages

**npm Policy**: Can only unpublish within 72 hours of publish

```bash
npm unpublish @generacy-ai/latency@1.0.0
```

**After 72 hours**: Cannot unpublish, use deprecation instead

### Deprecating Versions

```bash
# Deprecate a specific version
npm deprecate @generacy-ai/latency@1.0.0 "This version has a critical bug, use 1.0.1 instead"

# Deprecate all versions (package retirement)
npm deprecate @generacy-ai/latency "Package has been renamed to @generacy-ai/core"
```

**User Experience**:
```bash
npm install @generacy-ai/latency@1.0.0
npm WARN deprecated @generacy-ai/latency@1.0.0: This version has a critical bug, use 1.0.1 instead
```

### Rolling Back Releases

**Scenario**: Published 1.0.1 with critical bug

**Steps**:
1. Within 72 hours: `npm unpublish @generacy-ai/latency@1.0.1`
2. After 72 hours:
   - `npm deprecate @generacy-ai/latency@1.0.1 "Critical bug, use 1.0.2"`
   - Publish fixed version 1.0.2
   - Update dist-tags: `npm dist-tag add @generacy-ai/latency@1.0.0 latest`

**Prevention**: Rigorous CI testing, preview releases for early testing

---

## Monitoring and Observability

### Key Metrics

**Publish Success Rate**:
- Track: Number of successful vs failed publish workflows
- Alert: If success rate < 95% over 7 days

**Time to Availability**:
- Measure: Time from merge to package available on npm
- Target: < 5 minutes

**Changesets Adoption**:
- Track: Percentage of PRs that include changesets
- Target: 80%+ (for PRs changing code)

**Preview Version Usage**:
- Track: npm download stats for @preview tag
- Insight: Are previews being tested?

### Monitoring Setup

**GitHub Actions**:
- Built-in notifications (email on workflow failure)
- Status badges in README
- Slack/Discord webhooks for alerts

**npm Stats**:
```bash
# View download counts
npm info @generacy-ai/latency --json | jq .downloads

# Track over time with npm-stat
npx npm-stat @generacy-ai/latency
```

**Custom Dashboard** (future):
- Track publish frequency
- Dependency graph (which packages depend on what)
- Version adoption (how many users on latest vs old versions)

---

## Lessons from Other Projects

### Example: React

**Strategy**:
- Stable releases: `react@18.2.0` on `@latest`
- Experimental: `react@0.0.0-experimental-abc123` on `@experimental`
- Canary: `react@18.3.0-canary-abc123` on `@canary`

**Takeaway**: Multiple channels for different stability levels

### Example: Vite

**Strategy**:
- Uses changesets
- Preview releases on `@beta` tag
- Monorepo with 10+ packages
- Automated releases via GitHub Actions

**Takeaway**: Changesets scales well to multi-package projects

### Example: Turborepo

**Strategy**:
- Monorepo with multiple packages
- Changesets for versioning
- Releases cut manually (no auto-publish on main)
- Publishes to `@latest` only after human approval

**Takeaway**: Some projects prefer manual release trigger

### Our Approach vs Industry

| Aspect | @generacy-ai | Industry Standard |
|--------|--------------|-------------------|
| Versioning | Changesets | Changesets or semantic-release |
| Channels | @latest + @preview | @latest + @next/@beta |
| Automation | Fully automated | Mix of auto and manual |
| Monorepo | Polyrepo | Mix (trending toward monorepo) |

---

## Future Enhancements

### Phase 2+ Considerations

1. **Automated Dependency Updates**
   - Implement cross-repo update PRs (Q8 clarification)
   - Use Renovate or Dependabot

2. **Preview Retention Policy**
   - Currently: No cleanup (Q6: keep indefinitely)
   - Future: May want to unpublish old previews (after 90 days?)

3. **Changelog Customization**
   - Current: Default changesets changelog
   - Future: Use `@changesets/changelog-github` for PR links and contributors

4. **Private Packages**
   - Current: All public
   - Future: May have internal-only packages (e.g., shared configs)

5. **npm Package Provenance**
   - Add `--provenance` flag for supply chain transparency

6. **Version Badges in README**
   - Auto-update README with latest version badges

7. **Release Notes Automation**
   - Generate GitHub releases from changesets
   - Include migration guides for breaking changes

---

## Conclusion

This research documents the technical foundation for npm publishing infrastructure. The chosen approach (changesets + dual release streams + polyrepo) balances automation, flexibility, and maintainability for the @generacy-ai organization.

**Key Success Factors**:
1. Clear documentation for contributors
2. Robust CI with idempotent workflows
3. Dependency verification to prevent broken publishes
4. Human oversight on stable releases (via Version PR)

**Next Steps**: Implement Phase 1-6 of the plan, validate with test publishes, and iterate based on real-world usage.

---

*Research completed: 2026-02-24*
*Feature: 242-1-1-set-up*

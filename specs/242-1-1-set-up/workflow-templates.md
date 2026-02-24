# GitHub Actions Workflow Templates

**Feature**: 242-1-1-set-up
**Date**: 2026-02-24

## Overview

This document provides complete, production-ready GitHub Actions workflow templates for all three repositories (latency, agency, generacy). These templates implement the dual release stream strategy with preview and stable publishing channels.

---

## Template 1: CI Workflow (All Branches)

**Purpose**: Validate PRs and pushes with lint, test, and build checks

**File**: `.github/workflows/ci.yml`

**Used by**: latency, agency, generacy (identical across all repos)

```yaml
name: CI

on:
  pull_request:
    branches: ["**"]
  push:
    branches: [develop, main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run linter
        run: pnpm lint

  typecheck:
    name: Type Check
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run type checking
        run: pnpm typecheck

  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run tests
        run: pnpm test

  build:
    name: Build
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build packages
        run: pnpm build

  # Summary job that all branch protections should depend on
  ci-success:
    name: CI Success
    runs-on: ubuntu-latest
    needs: [lint, typecheck, test, build]
    if: always()
    steps:
      - name: Check all jobs
        run: |
          if [[ "${{ contains(needs.*.result, 'failure') }}" == "true" ]]; then
            echo "One or more CI jobs failed"
            exit 1
          fi
          if [[ "${{ contains(needs.*.result, 'cancelled') }}" == "true" ]]; then
            echo "One or more CI jobs were cancelled"
            exit 1
          fi
          echo "All CI jobs passed"
```

**Notes**:
- Uses `concurrency` to cancel outdated workflow runs
- `ci-success` job provides single status check for branch protection
- All jobs run in parallel (no dependencies between them)

---

## Template 2: Preview Publish (develop branch only)

**Purpose**: Publish snapshot versions to npm with @preview tag when changesets exist

**File**: `.github/workflows/publish-preview.yml`

### Template 2A: Latency (no dependencies)

```yaml
name: Publish Preview

on:
  push:
    branches: [develop]

concurrency:
  group: publish-preview-${{ github.ref }}
  cancel-in-progress: false  # Don't cancel, let publishes complete

jobs:
  publish:
    name: Publish Preview Packages
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      id-token: write  # For npm provenance
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history for changesets

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Check for pending changesets
        id: check-changesets
        run: |
          # Check if any .md files exist in .changeset/ (excluding README)
          if ls .changeset/*.md 2>/dev/null | grep -v README; then
            echo "has-changesets=true" >> $GITHUB_OUTPUT
            echo "Found pending changesets"
          else
            echo "has-changesets=false" >> $GITHUB_OUTPUT
            echo "No pending changesets, skipping publish"
          fi

      - name: Create snapshot versions
        if: steps.check-changesets.outputs.has-changesets == 'true'
        run: |
          # Generate snapshot versions with timestamp
          pnpm changeset version --snapshot preview
          echo "Generated preview versions:"
          git diff package.json packages/*/package.json

      - name: Build packages
        if: steps.check-changesets.outputs.has-changesets == 'true'
        run: pnpm build

      - name: Publish to npm
        if: steps.check-changesets.outputs.has-changesets == 'true'
        run: |
          # Publish with preview tag and provenance
          pnpm changeset publish --no-git-tag --tag preview
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
          NPM_CONFIG_PROVENANCE: true

      - name: Get published versions
        if: steps.check-changesets.outputs.has-changesets == 'true'
        id: versions
        run: |
          # Extract published versions from package.json files
          VERSIONS=$(node -e "
            const glob = require('glob');
            const fs = require('fs');
            const packages = glob.sync('packages/*/package.json');
            const versions = packages.map(p => {
              const pkg = JSON.parse(fs.readFileSync(p));
              return \`- **\${pkg.name}**: \${pkg.version}\`;
            });
            console.log(versions.join('\\n'));
          ")
          echo "versions<<EOF" >> $GITHUB_OUTPUT
          echo "$VERSIONS" >> $GITHUB_OUTPUT
          echo "EOF" >> $GITHUB_OUTPUT

      - name: Find associated PR
        if: steps.check-changesets.outputs.has-changesets == 'true'
        id: find-pr
        uses: actions/github-script@v7
        with:
          script: |
            const commit = context.sha;
            const { data: prs } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
              owner: context.repo.owner,
              repo: context.repo.repo,
              commit_sha: commit
            });
            if (prs.length > 0) {
              return prs[0].number;
            }
            return null;

      - name: Comment on PR
        if: steps.check-changesets.outputs.has-changesets == 'true' && steps.find-pr.outputs.result != 'null'
        uses: actions/github-script@v7
        with:
          script: |
            const prNumber = ${{ steps.find-pr.outputs.result }};
            const body = `## 🚀 Preview Packages Published

            The following preview packages have been published to npm:

            ${{ steps.versions.outputs.versions }}

            Install with:
            \`\`\`bash
            npm install <package-name>@preview
            \`\`\`

            Or install specific version:
            \`\`\`bash
            npm install <package-name>@<version>
            \`\`\`

            Published from commit: ${context.sha.substring(0, 7)}
            `;

            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: prNumber,
              body: body
            });
```

### Template 2B: Agency (depends on latency)

Same as Template 2A, but add this step before "Publish to npm":

```yaml
      - name: Verify latency dependency
        if: steps.check-changesets.outputs.has-changesets == 'true'
        run: |
          # Check if @generacy-ai/latency packages exist on npm with preview tag
          echo "Verifying latency dependencies are published..."

          # Extract latency dependencies from package.json files
          LATENCY_DEPS=$(node -e "
            const glob = require('glob');
            const fs = require('fs');
            const packages = glob.sync('packages/*/package.json');
            const deps = new Set();
            packages.forEach(p => {
              const pkg = JSON.parse(fs.readFileSync(p));
              Object.keys(pkg.dependencies || {}).forEach(dep => {
                if (dep.startsWith('@generacy-ai/latency')) {
                  deps.add(dep);
                }
              });
            });
            console.log(Array.from(deps).join(' '));
          ")

          if [ -n "$LATENCY_DEPS" ]; then
            for pkg in $LATENCY_DEPS; do
              echo "Checking $pkg..."
              if ! npm view $pkg@preview version &>/dev/null; then
                echo "❌ Error: $pkg@preview not found on npm"
                echo "Agency requires latency packages to be published first"
                exit 1
              fi
              VERSION=$(npm view $pkg@preview version)
              echo "✅ $pkg@preview found: $VERSION"
            done
          else
            echo "No latency dependencies found"
          fi
```

### Template 2C: Generacy (depends on latency and agency)

Same as Template 2B, but check both latency and agency:

```yaml
      - name: Verify dependencies
        if: steps.check-changesets.outputs.has-changesets == 'true'
        run: |
          echo "Verifying @generacy-ai dependencies are published..."

          # Extract all @generacy-ai dependencies
          DEPS=$(node -e "
            const glob = require('glob');
            const fs = require('fs');
            const packages = glob.sync('packages/*/package.json');
            const deps = new Set();
            packages.forEach(p => {
              const pkg = JSON.parse(fs.readFileSync(p));
              Object.keys(pkg.dependencies || {}).forEach(dep => {
                if (dep.startsWith('@generacy-ai/')) {
                  deps.add(dep);
                }
              });
            });
            console.log(Array.from(deps).join(' '));
          ")

          if [ -n "$DEPS" ]; then
            for pkg in $DEPS; do
              echo "Checking $pkg..."
              if ! npm view $pkg@preview version &>/dev/null; then
                echo "❌ Error: $pkg@preview not found on npm"
                echo "Please ensure all dependencies are published before publishing generacy"
                exit 1
              fi
              VERSION=$(npm view $pkg@preview version)
              echo "✅ $pkg@preview found: $VERSION"
            done
          else
            echo "No @generacy-ai dependencies found"
          fi
```

---

## Template 3: Stable Release (main branch)

**Purpose**: Create "Version Packages" PR or publish stable releases when merged

**File**: `.github/workflows/release.yml`

### Template 3A: Latency (no dependencies)

```yaml
name: Release

on:
  push:
    branches: [main]

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false  # Let releases complete

jobs:
  release:
    name: Release Packages
    runs-on: ubuntu-latest
    permissions:
      contents: write  # For creating releases and tags
      pull-requests: write  # For creating version PR
      id-token: write  # For npm provenance
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history for changesets

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build packages
        run: pnpm build

      - name: Create Release PR or Publish
        id: changesets
        uses: changesets/action@v1
        with:
          version: pnpm changeset version
          publish: pnpm changeset publish
          commit: "chore: version packages"
          title: "chore: version packages"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
          NPM_CONFIG_PROVENANCE: true

      - name: Create GitHub Releases
        if: steps.changesets.outputs.published == 'true'
        uses: actions/github-script@v7
        with:
          script: |
            const published = JSON.parse('${{ steps.changesets.outputs.publishedPackages }}');

            for (const package of published) {
              const tagName = `${package.name}@${package.version}`;
              const releaseName = `${package.name} v${package.version}`;

              // Extract changelog for this version
              // (Simplified - in production, parse CHANGELOG.md)
              const body = `Release of ${package.name} version ${package.version}`;

              await github.rest.repos.createRelease({
                owner: context.repo.owner,
                repo: context.repo.repo,
                tag_name: tagName,
                name: releaseName,
                body: body,
                draft: false,
                prerelease: false
              });

              console.log(`Created release for ${tagName}`);
            }
```

### Template 3B: Agency (with dependency verification)

Add this step before "Create Release PR or Publish":

```yaml
      - name: Verify latency dependency
        run: |
          echo "Verifying latency dependencies for stable release..."

          LATENCY_DEPS=$(node -e "
            const glob = require('glob');
            const fs = require('fs');
            const packages = glob.sync('packages/*/package.json');
            const deps = new Map();
            packages.forEach(p => {
              const pkg = JSON.parse(fs.readFileSync(p));
              Object.keys(pkg.dependencies || {}).forEach(dep => {
                if (dep.startsWith('@generacy-ai/latency')) {
                  const version = pkg.dependencies[dep];
                  deps.set(dep, version);
                }
              });
            });
            console.log(JSON.stringify(Array.from(deps.entries())));
          ")

          if [ "$LATENCY_DEPS" != "[]" ]; then
            echo "$LATENCY_DEPS" | jq -r '.[] | @tsv' | while IFS=$'\t' read -r pkg version; do
              echo "Checking $pkg@$version..."

              # Check if exact version exists (not preview)
              if ! npm view "$pkg@$version" version &>/dev/null; then
                echo "❌ Error: $pkg@$version not found on npm"
                echo "Please ensure latency stable release is published first"
                exit 1
              fi

              echo "✅ $pkg@$version found"
            done
          fi
```

### Template 3C: Generacy (check both latency and agency)

```yaml
      - name: Verify dependencies
        run: |
          echo "Verifying @generacy-ai dependencies for stable release..."

          DEPS=$(node -e "
            const glob = require('glob');
            const fs = require('fs');
            const packages = glob.sync('packages/*/package.json');
            const deps = new Map();
            packages.forEach(p => {
              const pkg = JSON.parse(fs.readFileSync(p));
              Object.keys(pkg.dependencies || {}).forEach(dep => {
                if (dep.startsWith('@generacy-ai/')) {
                  const version = pkg.dependencies[dep];
                  deps.set(dep, version);
                }
              });
            });
            console.log(JSON.stringify(Array.from(deps.entries())));
          ")

          if [ "$DEPS" != "[]" ]; then
            echo "$DEPS" | jq -r '.[] | @tsv' | while IFS=$'\t' read -r pkg version; do
              echo "Checking $pkg@$version..."

              if ! npm view "$pkg@$version" version &>/dev/null; then
                echo "❌ Error: $pkg@$version not found on npm"
                echo "Publish order: latency → agency → generacy"
                exit 1
              fi

              echo "✅ $pkg@$version found"
            done
          fi
```

---

## Template 4: Dependency Update Automation (Optional)

**Purpose**: Automatically update dependencies when upstream packages publish preview versions

**File**: `.github/workflows/dependency-update.yml`

**Used by**: agency (watches latency), generacy (watches latency + agency)

```yaml
name: Dependency Update

on:
  repository_dispatch:
    types:
      - upstream-preview-published
  workflow_dispatch:
    inputs:
      package:
        description: 'Package name'
        required: true
      version:
        description: 'Package version'
        required: true

jobs:
  update:
    name: Update Dependency
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Get package info
        id: package-info
        run: |
          if [ "${{ github.event_name }}" == "repository_dispatch" ]; then
            echo "package=${{ github.event.client_payload.package }}" >> $GITHUB_OUTPUT
            echo "version=${{ github.event.client_payload.version }}" >> $GITHUB_OUTPUT
          else
            echo "package=${{ github.event.inputs.package }}" >> $GITHUB_OUTPUT
            echo "version=${{ github.event.inputs.version }}" >> $GITHUB_OUTPUT
          fi

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Update dependency
        run: |
          pnpm add -w "${{ steps.package-info.outputs.package }}@${{ steps.package-info.outputs.version }}"

      - name: Run tests
        id: test
        continue-on-error: true
        run: pnpm test

      - name: Create Pull Request
        uses: peter-evans/create-pull-request@v6
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          branch: deps/${{ steps.package-info.outputs.package }}-${{ steps.package-info.outputs.version }}
          delete-branch: true
          commit-message: "chore: update ${{ steps.package-info.outputs.package }} to ${{ steps.package-info.outputs.version }}"
          title: "chore: update ${{ steps.package-info.outputs.package }} to ${{ steps.package-info.outputs.version }}"
          body: |
            ## Dependency Update

            Automated update triggered by upstream preview publish.

            **Package**: `${{ steps.package-info.outputs.package }}`
            **Version**: `${{ steps.package-info.outputs.version }}`
            **Tests**: ${{ steps.test.outcome == 'success' && '✅ Passing' || '❌ Failing' }}

            ${{ steps.test.outcome == 'failure' && '⚠️ Tests failed. Please review changes before merging.' || '' }}

            ---
            *This PR was automatically created by the dependency-update workflow.*
          labels: |
            dependencies
            automated
            preview
```

**Trigger from upstream repo** (add to publish-preview.yml):

```yaml
      - name: Trigger downstream updates
        if: steps.check-changesets.outputs.has-changesets == 'true'
        uses: peter-evans/repository-dispatch@v3
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          repository: generacy-ai/agency  # Or generacy
          event-type: upstream-preview-published
          client-payload: |
            {
              "package": "${{ steps.package-info.outputs.name }}",
              "version": "${{ steps.package-info.outputs.version }}"
            }
```

---

## Template 5: Publish Notification (Slack/Discord)

**Purpose**: Send notifications to team chat when packages are published

**File**: Can be added as a job to `publish-preview.yml` or `release.yml`

### Slack Notification

```yaml
      - name: Notify Slack
        if: success()
        uses: slackapi/slack-github-action@v1
        with:
          webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}
          payload: |
            {
              "text": "📦 Preview packages published to npm",
              "blocks": [
                {
                  "type": "section",
                  "text": {
                    "type": "mrkdwn",
                    "text": "*Preview Packages Published*\n\n${{ steps.versions.outputs.versions }}"
                  }
                },
                {
                  "type": "context",
                  "elements": [
                    {
                      "type": "mrkdwn",
                      "text": "Repository: <https://github.com/${{ github.repository }}|${{ github.repository }}>"
                    },
                    {
                      "type": "mrkdwn",
                      "text": "Commit: <https://github.com/${{ github.repository }}/commit/${{ github.sha }}|${{ github.sha }}>"
                    }
                  ]
                }
              ]
            }
```

### Discord Notification

```yaml
      - name: Notify Discord
        if: success()
        uses: tsickert/discord-webhook@v5.3.0
        with:
          webhook-url: ${{ secrets.DISCORD_WEBHOOK_URL }}
          content: |
            📦 **Preview Packages Published**

            ${{ steps.versions.outputs.versions }}

            Repository: ${{ github.repository }}
            Commit: ${{ github.sha }}
```

---

## Template 6: Package Verification Script

**Purpose**: Shared script to verify package published correctly

**File**: `scripts/verify-publish.sh` (in each repo)

```bash
#!/bin/bash
set -euo pipefail

PACKAGE=$1
VERSION=$2
TAG=${3:-latest}

echo "Verifying $PACKAGE@$VERSION (tag: $TAG)"

# Wait for npm registry to propagate (max 2 minutes)
MAX_ATTEMPTS=24
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  if npm view "$PACKAGE@$VERSION" version &>/dev/null; then
    echo "✅ Package $PACKAGE@$VERSION found on npm"

    # Verify dist-tag
    CURRENT_TAG_VERSION=$(npm dist-tag ls "$PACKAGE" | grep "^$TAG:" | cut -d' ' -f2)

    if [ "$CURRENT_TAG_VERSION" == "$VERSION" ]; then
      echo "✅ Tag $TAG points to $VERSION"
      exit 0
    else
      echo "⚠️  Tag $TAG points to $CURRENT_TAG_VERSION (expected $VERSION)"
      exit 1
    fi
  fi

  ATTEMPT=$((ATTEMPT + 1))
  echo "Package not yet available, waiting... ($ATTEMPT/$MAX_ATTEMPTS)"
  sleep 5
done

echo "❌ Package $PACKAGE@$VERSION not found after 2 minutes"
exit 1
```

**Usage in workflow**:

```yaml
      - name: Verify publish
        run: |
          chmod +x scripts/verify-publish.sh
          ./scripts/verify-publish.sh "@generacy-ai/latency" "1.0.0-preview.20260224143022" "preview"
```

---

## Workflow Permissions Reference

### Minimum Required Permissions

**CI Workflow**:
```yaml
permissions:
  contents: read  # Checkout code
```

**Preview Publish Workflow**:
```yaml
permissions:
  contents: read  # Checkout code
  pull-requests: write  # Comment on PR
  id-token: write  # npm provenance
```

**Stable Release Workflow**:
```yaml
permissions:
  contents: write  # Create tags and releases
  pull-requests: write  # Create Version PR
  id-token: write  # npm provenance
```

---

## Workflow Testing Checklist

Before enabling these workflows in production:

- [ ] Test CI workflow on a PR
- [ ] Test preview publish with a test changeset
- [ ] Verify @preview tag is updated on npm
- [ ] Test stable release workflow on main
- [ ] Verify "Version Packages" PR is created
- [ ] Merge Version PR and verify publish
- [ ] Verify @latest tag is updated on npm
- [ ] Test dependency verification (fail case)
- [ ] Test PR comment creation
- [ ] Test idempotency (re-run failed workflow)

---

## Troubleshooting Common Issues

### Issue: "Unable to resolve action `changesets/action@v1`"

**Solution**: Ensure repository has internet access and can reach GitHub Actions marketplace.

### Issue: "npm publish failed with 403"

**Causes**:
1. Invalid NPM_TOKEN
2. Token doesn't have publish permissions
3. Organization doesn't allow publish from this account

**Solution**: Verify token and permissions on npmjs.com

### Issue: "Version already published"

**Expected**: Workflow should handle this gracefully (idempotency)

**Solution**: Add error handling to check if version exists before failing

### Issue: "Changesets version generates wrong snapshot format"

**Solution**: Ensure using `--snapshot preview` flag, not just `--snapshot`

### Issue: "PR comment not created"

**Causes**:
1. No associated PR found
2. Missing `pull-requests: write` permission

**Solution**: Check workflow permissions and PR association logic

---

*Templates version: 1.0*
*Feature: 242-1-1-set-up*
*Date: 2026-02-24*

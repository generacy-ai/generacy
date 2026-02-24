# Clarification Questions

## Status: Resolved

## Questions

### Q1: Preview Version Format
**Context**: The spec mentions "1.0.0-preview.YYYYMMDD or similar snapshot format" but doesn't specify the exact format. The versioning strategy is critical for consumers to understand freshness and for npm to properly order versions.

**Question**: What exact format should preview versions use?

**Options**:
- A) Date-based: `1.0.0-preview.20260224` - Human-readable, shows when published, but multiple publishes same day could conflict
- B) Datetime-based: `1.0.0-preview.20260224-143022` - Includes time, avoids same-day conflicts, still readable
- C) Commit-based: `1.0.0-preview.abc1234` - Traceable to exact commit, but less readable for freshness
- D) Sequential: `1.0.0-preview.0`, `1.0.0-preview.1` - Clean version ordering, but requires state tracking

**Answer**: **B (Datetime-based)** - `1.0.0-preview.20260224143022`

This aligns with changesets' built-in snapshot mode which produces timestamp-based versions. It's human-readable for freshness, traceable, and avoids same-day publish conflicts. Changesets snapshot will generate this format natively with `--snapshot preview`.

---

### Q2: Changesets Workflow Trigger
**Context**: The spec states stable releases happen "when merging to `main`" but changesets typically requires a "Version Packages" PR to be created and merged. This affects whether every merge to main publishes or only merges that include changeset files.

**Question**: How should the changesets workflow be triggered for stable releases?

**Options**:
- A) Automatic on any push to main: Every merge to `main` creates changeset PR automatically if changes detected
- B) Manual changesets PR: Maintainers manually run `changeset version` and merge the resulting PR to trigger publish
- C) Changeset files required: Only merges that include `.changeset/*.md` files trigger the version/publish workflow
- D) Tag-based: Stable releases only happen when git tags are pushed (e.g., `v1.0.0`)

**Answer**: **C (Changeset files required)**

This is the standard changesets workflow:
1. Developers include `.changeset/*.md` files in their PRs describing the change
2. On merge to `main`, the changesets GitHub Action creates a "Version Packages" PR
3. Merging that PR triggers the actual publish

This gives maintainers control over when versions bump and what the changelog says, while still being automated.

---

### Q3: Preview Publishing on Every Develop Merge
**Context**: US1 states "automated preview releases when code merges to `develop`" but doesn't clarify if this happens for ALL merges or only when package code changes. Publishing on every merge (including docs-only changes) could create noise.

**Question**: Should preview releases publish on every develop merge or only when package code changes?

**Options**:
- A) Every merge: All merges to develop trigger preview publish, regardless of changed files
- B) Code changes only: Only publish when files in `src/` or `lib/` directories change
- C) Changeset-based: Only publish preview when `.changeset/*.md` files are present
- D) Manual trigger: Preview publishes only when explicitly triggered via workflow_dispatch

**Answer**: **C (Changeset-based)**

Only publish preview versions when `.changeset/*.md` files are present in the merge. This avoids noise from docs-only or config-only changes, while still being automated. On merge to develop, the CI runs `changeset version --snapshot preview` + publish, but only if pending changesets exist. No changesets = no publish = no noise.

---

### Q4: Branch Protection Required Status Checks
**Context**: FR-010 requires "CI status checks" to pass, but doesn't specify which checks. This determines what must pass before merging to main.

**Question**: Which specific CI checks should be required for main branch protection?

**Options**:
- A) Build only: Only the build workflow must pass
- B) Build + Tests: Build and test suite must both pass
- C) Build + Tests + Lint: Build, tests, and linting must all pass
- D) All workflows: Every configured workflow must pass before merge

**Answer**: **C (Build + Tests + Lint)**

The buildout plan already specifies "lint, test, build on PR" for every repo. All three should be required. This is standard practice and all three checks will already exist in the CI workflows.

---

### Q5: Initial Main Branch Synchronization Strategy
**Context**: The spec mentions main is "30-180 commits behind" develop and needs synchronization. The method chosen affects whether history is preserved and if there are merge conflicts to resolve.

**Question**: How should the initial develop → main synchronization be handled?

**Options**:
- A) Fast-forward merge: Merge develop into main preserving all commit history (may have conflicts)
- B) Squash merge: Squash all develop commits into single commit on main (clean history, loses granularity)
- C) Reset main to develop: Hard reset main to match develop exactly (simplest, rewrites main history)
- D) Cherry-pick stable commits: Manually select stable commits from develop (most control, most effort)

**Answer**: **C (Reset main to develop)**

Main currently only has 2 commits ("Added empty readme" and "Add autodev configuration"). There's nothing to preserve. A force-push of develop to main is the cleanest approach — it sets up a clean baseline for the release streams. This is a one-time operation before branch protection is enabled.

---

### Q6: Preview Package Retention Policy
**Context**: Preview packages will accumulate over time on npm registry. Without a retention policy, the registry could fill with outdated preview versions.

**Question**: Should there be a retention or cleanup policy for preview packages?

**Options**:
- A) No cleanup: Keep all preview versions indefinitely on npm
- B) Time-based cleanup: Automatically unpublish preview versions older than X days (e.g., 30 days)
- C) Count-based retention: Keep only the last N preview versions per package
- D) Manual cleanup: Document process for maintainers to manually unpublish old previews

**Answer**: **A (No cleanup)**

npm packages are small metadata and cost nothing. npm's unpublish policy (72-hour window) makes automated cleanup impractical anyway. Preview versions accumulate slowly — this won't be a problem for a long time, if ever. Revisit if it becomes an issue.

---

### Q7: Failed Publish Recovery
**Context**: The spec mentions "manual version rollback" in out-of-scope but doesn't specify what happens if a publish workflow fails mid-process (e.g., published to npm but GitHub release failed).

**Question**: What is the recovery procedure if a publish workflow partially fails?

**Options**:
- A) Retry automatically: Workflow automatically retries failed steps up to N times
- B) Manual intervention required: Workflow fails and maintainer manually completes remaining steps
- C) Rollback on failure: Any failure triggers automatic unpublish and version rollback
- D) Continue from failure: Workflow can be re-run and skips already-completed steps

**Answer**: **D (Continue from failure)**

Design workflows to be idempotent. Use `npm publish --provenance` with `--skip-duplicate` (or catch "already published" errors gracefully). If a workflow fails mid-publish, re-running it should skip already-published packages and continue with the rest. This is the simplest and most reliable approach.

---

### Q8: Cross-Package Dependency Updates
**Context**: When latency publishes a new preview version, agency and generacy may want to test against it. The spec doesn't address how dependent packages update their dependencies to new preview versions.

**Question**: How should dependent packages (agency, generacy) consume new preview versions of their dependencies?

**Options**:
- A) Automatic updates: Workflow automatically updates dependencies to latest preview and creates PR
- B) Manual updates: Developers manually update package.json to reference new preview versions
- C) Range-based: Use version ranges like `^1.0.0-preview` to automatically get latest
- D) Pinned previews: Explicitly pin to specific preview versions, update via PR when needed

**Answer**: **A (Automatic updates)**

When latency publishes a new preview version, a follow-up workflow should create a PR in agency/generacy bumping the dependency. This keeps each repo's CI green with explicit version pins rather than relying on npm ranges (which don't work reliably with prerelease versions). The PR gives maintainers visibility and a chance to catch breakage before merging.

---

### Q9: Publish Order Enforcement
**Context**: FR-012 documents the publish order (latency → agency → generacy) but doesn't specify if this is enforced by tooling or just documented as best practice.

**Question**: Should the publish order be enforced by automation or remain a documented guideline?

**Options**:
- A) No enforcement: Document the order but rely on maintainers to follow it
- B) Workflow dependencies: Use GitHub Actions workflow dependencies to enforce order
- C) Dependency checks: Workflows check that dependencies are published before publishing
- D) Monorepo migration: Move packages to monorepo to handle ordering automatically (out of scope per spec)

**Answer**: **C (Dependency checks)**

Each repo's publish workflow should verify its `@generacy-ai/*` dependencies are published at the expected version before proceeding. This is lightweight, works across repos, and fails fast with a clear error message. Full workflow dependency orchestration across repos would be over-engineering at this stage.

---

### Q10: Package Access Level
**Context**: The spec states "only public packages" in out-of-scope, but doesn't explicitly confirm that all three packages should be published as public (free) packages on npm.

**Question**: Should all @generacy-ai packages be published with public access on npm?

**Options**:
- A) All public: All packages published with `--access public` flag
- B) Organization scoped: Rely on @generacy-ai organization settings for access control
- C) Package-specific: Allow some packages to be public and others private based on needs
- D) Initially private: Start with private packages and make public later

**Answer**: **A (All public)**

All three public repos (latency, agency, generacy) should publish with `--access public`. Scoped packages on npm default to restricted, so this must be explicit. The packages correspond to public repos and are intended for external developer consumption — there's no reason to restrict access.

---

### Q11: Workflow Notification Strategy
**Context**: When publishes succeed or fail, maintainers need to be notified. The spec mentions "Comment PR with published version" for previews but doesn't specify notification for stable releases or failures.

**Question**: How should maintainers be notified of publish workflow outcomes?

**Options**:
- A) GitHub notifications only: Rely on standard GitHub Actions email notifications
- B) PR comments: Comment on related PRs with publish status and versions
- C) Slack integration: Post publish status to dedicated Slack channel
- D) Multiple channels: Combine PR comments for success + Slack for failures

**Answer**: **B (PR comments)**

Comment on the associated PR with the published version(s) on success, or the failure details on error. This keeps notifications where the work happens, is zero-config, and doesn't require additional integrations. Slack integration can be added later if needed but isn't required for the MVP.

---

### Q12: Changesets Configuration
**Context**: FR-004 requires configuring changesets but doesn't specify the configuration approach. Changesets can be configured for different levels of automation and commit message formats.

**Question**: What changesets configuration should be used?

**Options**:
- A) Basic setup: Minimal config with default settings and manual changeset creation
- B) Conventional commits: Integrate with conventional commits to auto-generate changesets from commit messages
- C) Automated PRs: Configure changesets to automatically create "Version Packages" PRs
- D) Custom config: Specific changelog format, commit message format, and version bump rules (needs specification)

**Answer**: **C (Automated PRs)**

Use the standard `@changesets/cli` + `changesets/action` GitHub Action workflow:
- Developers add changeset files in PRs (`pnpm changeset`)
- On develop: snapshot versions are published automatically
- On main: the changesets bot creates a "Version Packages" PR with changelogs and version bumps
- Merging that PR triggers the stable publish

This is the recommended, well-documented changesets workflow and works well with monorepos using pnpm workspaces.


# Clarification Questions

## Status: Pending

## Questions

### Q1: Extension Publish Trigger Scope
**Context**: The spec says `extension-publish.yml` triggers on push to `develop` and `main`. However, the existing `publish-preview.yml` and `release.yml` workflows already trigger on these same branches (for npm packages). The publish workflow will run on every push to `develop`/`main` — not just when extension files change — since no `paths` filter is specified for push triggers (unlike the CI workflow which uses `paths: packages/generacy-extension/**` on PRs). This means merging a change to an unrelated package would still trigger extension publishing.
**Question**: Should `extension-publish.yml` use a `paths` filter (e.g., `packages/generacy-extension/**`) to only trigger publishing when extension files actually change, or should it trigger on every push to `develop`/`main` regardless of what changed?
**Options**:
- A) Add paths filter: Only trigger when extension files change. Prevents unnecessary marketplace publishes of identical versions, but means you must touch extension files to trigger a publish.
- B) No paths filter, but add a version-change check: Trigger on all pushes but add an early job step that compares the current `package.json` version against the marketplace version, skipping publish if unchanged.
- C) No paths filter (trigger on every push): Simpler workflow, but `vsce publish` of an already-published version will fail or no-op, which may cause noisy workflow failures.
**Answer**:

### Q2: Removing CI Exclusions — Other Excluded Packages
**Context**: FR-013 says to remove the `--filter '!generacy-extension'` exclusion from `ci.yml` typecheck and test steps. However, the test step also excludes `@generacy-ai/orchestrator` and `@generacy-ai/generacy` with their own filters. The spec only mentions removing the extension exclusion, but doesn't address whether these other exclusions should remain. Additionally, the extension currently has zero test files — `vitest run` will succeed with "no tests found" but may produce warnings.
**Question**: When removing the extension exclusion from `ci.yml`, should we only remove `--filter '!generacy-extension'` and leave the other package exclusions (`@generacy-ai/orchestrator`, `@generacy-ai/generacy`) intact?
**Options**:
- A) Only remove the extension exclusion: Leave other filters as-is. This is the minimal, scoped change described in the spec.
- B) Remove all exclusions: Clean up CI to run typecheck and test for all packages. This is a broader change and may surface unrelated failures.
**Answer**:

### Q3: Publish Workflow — Duplicate Version Handling
**Context**: The spec doesn't define what happens if a developer merges to `develop` or `main` without bumping the `package.json` version. Since version bumps are manual, it's plausible that multiple merges occur between version bumps. `vsce publish` will fail if the version already exists on the Marketplace. This would show as a red workflow run on GitHub.
**Question**: How should the publish workflow handle the case where the version in `package.json` has already been published to the Marketplace?
**Options**:
- A) Let it fail: Accept that the workflow will fail (red) if the version is unchanged. Developers should only merge extension changes when they've bumped the version.
- B) Skip publish gracefully: Add a pre-check that queries the Marketplace for the current version and skips the publish step if it already exists, marking the workflow as green/successful.
- C) Auto-increment patch version: Automatically append a build number or timestamp suffix for preview builds only (e.g., `0.1.0-preview.20260228`). Stable builds still require manual version bumps.
**Answer**:

### Q4: CI Workflow — Extension-Only Build vs Full Monorepo Build
**Context**: The spec says `extension-ci.yml` runs lint, build, typecheck, and test for the extension, but doesn't specify whether this is an isolated extension build or a full monorepo build. The extension may depend on other monorepo packages at build time. The existing `ci.yml` does a full `pnpm -r run build` across all packages. Running only `pnpm --filter generacy-extension run build` in the extension CI workflow could fail if dependencies aren't built first.
**Question**: Should `extension-ci.yml` build only the extension package (scoped filter) or run a full monorepo build first to ensure dependencies are available?
**Options**:
- A) Full monorepo build: Run `pnpm -r run build` (like `ci.yml` does) then run extension-specific lint/typecheck/test. Slower but reliable.
- B) Scoped build with dependencies: Use `pnpm --filter generacy-extension... run build` (the `...` includes transitive workspace dependencies). Faster, builds only what's needed.
- C) Extension-only build: Run `pnpm --filter generacy-extension run build`. Fastest but may fail if the extension imports from other workspace packages.
**Answer**:

### Q5: Git Tag Conflict Handling on Stable Publish
**Context**: The spec says the stable publish creates a git tag `extension-v{version}` (FR-010). If a stable publish fails after tagging but before the marketplace publish succeeds (or if the workflow is re-run via `workflow_dispatch`), the tag may already exist. The spec doesn't define how to handle tag conflicts.
**Question**: How should the workflow handle the case where the git tag `extension-v{version}` already exists?
**Options**:
- A) Force-update the tag: Use `git tag -f` to overwrite the existing tag. Simple but rewrites history for anyone who pulled the original tag.
- B) Skip tag creation: If the tag exists, skip the tagging step and continue with the rest of the workflow (publish, release). Log a warning.
- C) Fail the workflow: If the tag exists, the version has presumably been published before. Fail to prevent accidental republishing.
**Answer**:

### Q6: GitHub Release — Tag Name Format for Monorepo
**Context**: The spec uses `extension-v{version}` for git tags and GitHub Releases. However, the existing `release.yml` uses Changesets which creates tags like `@generacy-ai/package@version`. The `softprops/action-gh-release` action in the draft workflow uses `v1` while the spec references `v2`. Additionally, the release notes are "auto-generated" but it's unclear whether these should include only extension changes or all changes since the last extension release.
**Question**: Should the GitHub Release created on stable publish scope its auto-generated release notes to only extension-related commits, or include all commits since the previous extension tag?
**Options**:
- A) GitHub's default auto-generated notes: Use `generate_release_notes: true` which includes all commits between the previous tag and current tag. Simple, may include unrelated monorepo changes.
- B) Filtered release notes: Use a custom script or action to filter commits to only those touching `packages/generacy-extension/`. More accurate but adds complexity.
**Answer**:

### Q7: Workflow Dispatch — Branch Selection
**Context**: The spec says `workflow_dispatch` accepts a `channel` input (preview or stable), but doesn't specify which branch the workflow runs against. By default, `workflow_dispatch` runs on the branch selected in the GitHub Actions UI. A maintainer could accidentally run a "stable" publish from `develop` or a "preview" publish from `main`, potentially publishing untested or incorrect code.
**Question**: Should the workflow dispatch validate that the selected branch matches the channel (e.g., preview only from `develop`, stable only from `main`), or allow any branch/channel combination?
**Options**:
- A) Validate branch-channel pairing: Add a check that fails the workflow if `channel=stable` is run from a branch other than `main`, or `channel=preview` from a branch other than `develop`.
- B) Allow any combination: Trust maintainers to select the correct branch. Provides flexibility for hotfix scenarios where you might publish stable from a release branch.
- C) Default channel from branch: Ignore the `channel` input and auto-detect based on the branch (`develop` → preview, `main` → stable, other → fail).
**Answer**:

### Q8: Extension Lint Configuration
**Context**: The extension's `package.json` defines a lint script (`eslint src --ext .ts`), but there is no `.eslintrc` or `eslint.config.*` file in the extension package directory. The lint step may rely on a root-level ESLint config or may simply fail. The spec lists lint as a required CI step (FR-002) but doesn't address missing lint configuration.
**Question**: Does the extension have a working lint configuration (inherited from root or elsewhere), or does lint setup need to be created as part of this CI/CD work?
**Options**:
- A) Lint config exists at root: The extension inherits ESLint configuration from the monorepo root. Verify it works and proceed.
- B) Create extension-specific lint config: Add an ESLint config to the extension package as part of this spec.
- C) Skip lint in extension CI for now: Remove lint from the extension CI steps and add it as a follow-up task.
**Answer**:

### Q9: Concurrency Group — Cancel In-Progress Behavior
**Context**: The spec says to use concurrency groups with `cancel-in-progress: false` to prevent incomplete publishes (FR-012). However, this means if two merges to `develop` happen in quick succession, the second publish will queue and wait for the first to complete. With `cancel-in-progress: true`, the first (now outdated) publish would be cancelled in favor of the newer one. The spec explicitly says `false`, but the reasoning ("avoid race conditions") could also be served by `true` (since cancelling an in-progress publish and running a newer one avoids the race without publishing stale code).
**Question**: Should we use `cancel-in-progress: false` (queue and wait) or `cancel-in-progress: true` (cancel older publish in favor of newer) for the publish concurrency group?
**Options**:
- A) `cancel-in-progress: false` (as specified): Queue publishes sequentially. Ensures every merged version gets published. May be slow if multiple merges stack up.
- B) `cancel-in-progress: true`: Cancel older in-progress publish in favor of the latest. Faster, but a cancelled publish mid-`vsce publish` could leave the marketplace in an inconsistent state (though `vsce publish` is generally atomic).
**Answer**:

### Q10: VSCE PAT Authentication Method
**Context**: The draft workflow passes the PAT as both a CLI argument (`--pat ${{ secrets.VSCE_PAT }}`) and an environment variable (`VSCE_PAT`). The spec mentions authenticating via `VSCE_PAT` secret (FR-007) but doesn't specify the mechanism. Using `--pat` on the command line may expose the token in workflow logs if debug logging is enabled. The `vsce` CLI also supports authentication via the `VSCE_PAT` environment variable natively.
**Question**: Should the workflow authenticate `vsce` via the `--pat` CLI flag or the `VSCE_PAT` environment variable?
**Options**:
- A) Environment variable only: Set `VSCE_PAT` as an env var and run `vsce publish` without `--pat`. Avoids any risk of token appearing in logs. This is the `vsce` recommended approach.
- B) CLI flag: Use `--pat ${{ secrets.VSCE_PAT }}` explicitly. GitHub Actions masks secrets in logs, so the risk is minimal. More explicit about where auth comes from.
**Answer**:

### Q11: Extension Publish Path Filter vs Full Rebuild
**Context**: The `extension-publish.yml` workflow triggers on push to `develop`/`main`, but the spec also says the existing `ci.yml` will be updated to include the extension (FR-013). This means on a push to `develop` with extension changes, both `ci.yml` AND `extension-publish.yml` will run. The extension will be built and tested twice — once in `ci.yml` (as part of monorepo CI) and once in `extension-publish.yml` (before publishing). This is redundant but ensures publish never happens without validation.
**Question**: Is the intentional redundancy of running extension build/test in both `ci.yml` and `extension-publish.yml` acceptable, or should `extension-publish.yml` depend on `ci.yml` completing first (using `needs` or workflow chaining) to avoid duplicate work?
**Options**:
- A) Accept redundancy (as specified): Both workflows independently build and test. Simple, no cross-workflow dependencies, publish workflow is self-contained.
- B) Chain workflows: Make `extension-publish.yml` depend on `ci.yml` success via `workflow_run` trigger or `needs`. Avoids duplicate work but adds complexity and may slow down publishing.
**Answer**:

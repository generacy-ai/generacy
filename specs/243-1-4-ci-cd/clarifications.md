# Clarification Questions

## Status: Resolved

## Questions

### Q1: Dev Container Feature Integration Strategy
**Context**: The spec says preview and release workflows should publish the Dev Container Feature to GHCR, but the existing `publish-devcontainer-feature.yml` triggers on tag `feature/v*` — a completely different mechanism. The spec doesn't specify how to integrate: inline the devcontainers/action step directly into preview/release workflows, call the existing workflow via `workflow_call`, or keep the tag-based trigger and have preview/release create tags.
**Question**: How should the Dev Container Feature publish be integrated into the preview and release workflows?
**Options**:
- A) Inline steps: Add `devcontainers/action@v1` steps directly into `publish-preview.yml` and `release.yml`, and remove or deprecate the tag-triggered workflow
- B) Reusable workflow: Convert `publish-devcontainer-feature.yml` to a `workflow_call` reusable workflow and call it from preview/release workflows
- C) Tag dispatch: Have preview/release workflows create git tags (e.g., `feature/preview-*`, `feature/v*`) that trigger the existing tag-based workflow
**Answer**: **B) Reusable workflow.** Convert `publish-devcontainer-feature.yml` to a `workflow_call` reusable workflow. Preview and release workflows call it with the appropriate parameters. This keeps the publish logic in one place (DRY), avoids inline duplication (A), and avoids the indirection of tag dispatch (C).

### Q2: Dev Container Feature Preview Versioning
**Context**: The `devcontainers/action@v1` publishes features based on the `version` field in `devcontainer-feature.json`. For stable releases this maps to the `:1` major-version tag naturally. But for preview publishes, the spec says to use `:preview` tag. The devcontainers action doesn't natively support arbitrary tags like `:preview` — it generates OCI tags from the semver version field.
**Question**: How should the `:preview` tag be applied to the Dev Container Feature on GHCR? Should we use the devcontainers action with a modified version, use `docker tag` / `oras` to retag after publish, or use a different mechanism?
**Options**:
- A) Modify version before publish: Temporarily set `devcontainer-feature.json` version to a preview string (e.g., `0.0.0-preview`) so the action generates a `:preview` tag
- B) Manual GHCR tagging: After the devcontainers action runs, use `oras` or GHCR API to add a `:preview` tag to the published artifact
- C) Skip devcontainers action for preview: Use `oras push` directly to publish the feature with a `:preview` tag, bypassing the devcontainers action for previews only
**Answer**: **C) Skip devcontainers action for preview.** Use `oras push` directly for preview publishes with a `:preview` tag. Keep the devcontainers/action for stable releases where semver-based OCI tags map naturally. Modifying the version field (A) is fragile and the resulting tag may not be exactly `:preview`. Manual retagging (B) adds a dependency on oras anyway, so might as well use it directly.

### Q3: Changeset Detection Logic in Preview Workflow
**Context**: The current preview workflow checks for changesets using `ls .changeset/*.md`. However, `.changeset/README.md` always exists as a default file. The changeset-bot workflow already handles this correctly by excluding `README.md`. The preview workflow's glob `*.md` would match `README.md`, potentially reporting changesets exist when they don't — leading to empty snapshot publishes.
**Question**: Should the changeset detection in `publish-preview.yml` be fixed to exclude `README.md`, matching the pattern used in `changeset-bot.yml`?
**Options**:
- A) Yes, fix it: Use `find .changeset -name '*.md' ! -name 'README.md'` (consistent with changeset-bot)
- B) Use changeset CLI: Use `pnpm changeset status` to detect pending changesets (more robust, uses changeset's own logic)
**Answer**: **A) Yes, fix it.** Use `find .changeset -name '*.md' ! -name 'README.md'` — consistent with what `changeset-bot.yml` already does. This is simple, proven, and doesn't add a dependency on changeset CLI exit code behavior.

### Q4: npm Provenance Attestation
**Context**: The spec sets `id-token: write` permission on both preview and release workflows, and lists npm provenance in "Out of Scope" as "not yet enforced." However, neither workflow currently passes `--provenance` to the publish command. The permission is set but unused. npm provenance is a security best practice for public packages that creates a verifiable link between the published package and its source.
**Question**: Should npm provenance attestation be enabled now (by adding `--provenance` to publish commands), or should the `id-token: write` permission just be kept as a placeholder for future enablement?
**Options**:
- A) Enable now: Add `--provenance` flag to publish commands in both preview and release workflows
- B) Placeholder only: Keep `id-token: write` permission but don't add `--provenance` yet (enable in a follow-up)
- C) Remove permission: Remove `id-token: write` since it's unused, re-add when provenance is actually implemented
**Answer**: **A) Enable now.** The `id-token: write` permission is already set. Adding `--provenance` is a one-line change and is a security best practice for public packages. No reason to delay — the infrastructure is already in place.

### Q5: Release Workflow NODE_AUTH_TOKEN for npm
**Context**: The `release.yml` workflow sets `NPM_TOKEN` as an environment variable for the changesets action, but `actions/setup-node` with `registry-url` expects `NODE_AUTH_TOKEN` to configure `.npmrc`. The preview workflow correctly uses `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`. The release workflow is missing `registry-url` in the setup-node step and doesn't set `NODE_AUTH_TOKEN`, which means npm publish will likely fail due to missing authentication.
**Question**: Should the release workflow be updated to include `registry-url` in setup-node and pass `NODE_AUTH_TOKEN` to the changesets action, matching the preview workflow pattern?
**Options**:
- A) Yes, fix it: Add `registry-url: 'https://registry.npmjs.org'` to setup-node and use `NODE_AUTH_TOKEN` in the changesets action env
- B) Alternative: The changesets action may handle npm auth differently via its own `NPM_TOKEN` env var — verify this is working correctly first
**Answer**: **A) Yes, fix it.** This is a bug. The preview workflow correctly uses `registry-url` and `NODE_AUTH_TOKEN`. The release workflow should match. Without `registry-url` in setup-node, the `.npmrc` won't be configured and npm publish will fail.

### Q6: CI Trigger Overlap Between push and pull_request
**Context**: The `ci.yml` workflow triggers on both `pull_request` to `develop`/`main` and `push` to `develop`/`main`. When a PR is merged, both triggers fire: the `push` event for the merge commit and potentially the `pull_request` `closed` event. This means CI runs twice on merge — once is redundant. The spec says CI should run on PRs and the push trigger exists likely to ensure `develop`/`main` are always green, but this doubles runner usage.
**Question**: Is the dual trigger (push + pull_request) on `ci.yml` intentional? Should push-to-develop/main CI be kept (to catch direct pushes or verify post-merge), or removed since branch protection should prevent direct pushes?
**Options**:
- A) Keep both: Push trigger catches direct pushes and validates the merge result; the extra cost is acceptable
- B) Remove push trigger: Branch protection prevents direct pushes, so only PR-triggered CI is needed
- C) Add path filters: Keep push trigger but add path filters to skip CI on non-code changes (e.g., docs-only commits)
**Answer**: **A) Keep both.** Standard practice. The push trigger validates the actual merge result on the target branch (which can differ from the PR's CI due to concurrent merges). The cost is minimal. Admin bypass of branch protection is also a factor — the push trigger catches those.

### Q7: Stable Release Dev Container Feature Trigger Timing
**Context**: In the release workflow, `changesets/action@v1` operates in two modes: (1) when unreleased changesets exist, it creates a "Version Packages" PR; (2) when no changesets exist (i.e., the Version Packages PR was just merged), it publishes to npm. The Dev Container Feature should only be published to GHCR after npm publish succeeds (mode 2), not when the release PR is created (mode 1). The spec doesn't clarify how to distinguish these modes for the GHCR step.
**Question**: How should the release workflow determine when to publish the Dev Container Feature to GHCR?
**Options**:
- A) Check changesets/action output: The `changesets/action` outputs `published: true/false` — gate the GHCR step on `steps.changesets.outputs.published == 'true'`
- B) Separate job: Add a second job that depends on the release job and only runs when packages were published
**Answer**: **A) Check changesets/action output.** Gate the GHCR publish step on `steps.changesets.outputs.published == 'true'`. This is the simplest approach — the output exists exactly for this purpose.

### Q8: Handling Private Packages in Publish Commands
**Context**: The root `package.json` is marked `"private": true` and is not in the `packages/` directory, so `pnpm -r publish` won't try to publish it. However, the spec doesn't mention whether any workspace packages should be `"private": true` (e.g., `devcontainer-feature` which is published to GHCR not npm). If `devcontainer-feature` isn't marked private, `pnpm -r publish` could attempt to publish it to npm (where it doesn't belong).
**Question**: Should `devcontainer-feature` (and potentially other non-npm packages) be marked as `"private": true` in their `package.json` to prevent accidental npm publishing?
**Options**:
- A) Yes, mark private: Set `"private": true` in `packages/devcontainer-feature/package.json` to prevent npm publish
- B) Add to filter: Add `--filter '!devcontainer-feature'` to the publish commands alongside the existing `generacy-extension` filter
- C) Both: Mark as private and add to filter for defense-in-depth
**Answer**: **A) Yes, mark private.** Currently `packages/devcontainer-feature` has no `package.json`, so pnpm already can't publish it. However, adding a minimal `package.json` with `"private": true` now is good defense-in-depth in case one gets added later. No need for a publish filter since pnpm skips private packages automatically.

### Q9: Preview Publish Concurrency Queue Behavior
**Context**: The spec says preview publish concurrency should NOT cancel in-progress runs (FR-018) to ensure every merge publishes. The current workflow sets `cancel-in-progress: false`. However, with GitHub Actions concurrency groups, if `cancel-in-progress: false`, subsequent runs queue and wait — but only ONE run queues; additional runs replace the queued one. This means if 3 merges happen rapidly, only the 1st (running) and 3rd (last queued) would publish; the 2nd would be dropped.
**Question**: Is it acceptable that rapid consecutive merges to `develop` may skip intermediate preview publishes (only the latest queued run executes), or should each merge guarantee a publish?
**Options**:
- A) Acceptable: Skipping intermediate previews is fine since the latest always publishes and preview versions are transient
- B) Guarantee all: Remove the concurrency group entirely so every merge runs its own workflow independently (may cause version conflicts)
- C) Use unique groups: Use a unique concurrency group per commit SHA so no queueing occurs (parallel publishes, possible race conditions)
**Answer**: **A) Acceptable.** Preview versions are transient — consumers want the latest, not every intermediate version. Skipping an intermediate publish is harmless. Removing the concurrency group (B) risks npm version conflicts from parallel publishes.

### Q10: Changeset Bot — PR Status Check vs Annotation
**Context**: The current changeset-bot implementation emits a `::warning::` GitHub Actions annotation when no changeset is found. The spec says this should be non-blocking (P2). However, the spec also references branch protection requiring CI to pass (SC-002). If the changeset-bot workflow is added as a required status check, even a warning-only workflow would need to pass. The spec is ambiguous about whether changeset-bot should be a required status check.
**Question**: Should the changeset-bot workflow be configured as a required status check in branch protection, or should it remain purely informational (not required)?
**Options**:
- A) Required but always passing: Keep it as a required check that always succeeds (warning is informational only) — ensures the check runs on every PR
- B) Not required: Don't add it to branch protection — it runs automatically but doesn't block merge
**Answer**: **B) Not required.** Not every PR needs a changeset (docs, config, refactors). Making it required would create friction and require workaround empty changesets for non-code PRs. Keep it informational — the warning annotation is sufficient.

### Q11: CI Step Failure Strategy
**Context**: The spec says "CI fails fast on the first broken step" (US1 AC3). The current workflow runs all steps sequentially in a single job, so a failure at any step naturally stops execution. However, this means a lint failure prevents seeing build/test results. An alternative is a matrix strategy where lint, build, typecheck, and test run as parallel jobs — faster overall but doesn't "fail fast" in the sequential sense.
**Question**: Should CI steps remain sequential in a single job (current behavior, fails fast, simpler), or should they be split into parallel jobs (faster feedback for passing steps, but slower overall if one step blocks others)?
**Options**:
- A) Single sequential job: Keep current approach — simpler, fails fast, fewer runner minutes overall
- B) Parallel jobs with dependency: Split into lint → build → (typecheck + test), where typecheck and test run in parallel after build succeeds
- C) Fully parallel jobs: All steps run independently in parallel for fastest feedback on each check
**Answer**: **A) Single sequential job.** Matches the spec's "fails fast" requirement (US1 AC3). Simpler, fewer runner minutes, easier to debug. If CI time becomes a problem later, it's easy to split then.

### Q12: Release Workflow — npm Registry URL Configuration
**Context**: The `release.yml` workflow does not specify `registry-url` in the `setup-node` step, unlike `publish-preview.yml` which sets `registry-url: 'https://registry.npmjs.org'`. The `changesets/action@v1` may handle npm authentication via its own mechanism, but without `registry-url`, the `.npmrc` file won't be configured by setup-node. This could cause publish failures depending on how changesets/action configures npm auth.
**Question**: This is related to Q5 but focuses on the implementation: should `release.yml` mirror `publish-preview.yml`'s setup-node configuration with `registry-url`?
**Options**:
- A) Yes, add registry-url: Ensure consistent npm configuration across both publishing workflows
- B) Verify first: Test whether `changesets/action@v1` handles npm auth independently without setup-node's registry-url
**Answer**: **A) Yes, add registry-url.** Same issue as Q5 — this is a bug fix. Both publishing workflows should have consistent setup-node configuration with `registry-url: 'https://registry.npmjs.org'`.

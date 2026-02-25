# Clarification Questions

## Status: Pending

## Questions

### Q1: Workspace dependency resolution during npm publish
**Context**: `@generacy-ai/generacy` depends on `@generacy-ai/orchestrator` (workspace:*) and `@generacy-ai/workflow-engine` (workspace:*), and `@generacy-ai/orchestrator` depends on `@generacy-ai/workflow-engine` (workspace:^). When publishing to npm, `workspace:*` and `workspace:^` protocols are replaced with actual version ranges. The spec doesn't specify whether packages should be published in topological order or whether Changesets handles this automatically.
**Question**: Should the publish step explicitly enforce topological ordering (workflow-engine -> orchestrator -> generacy), or rely on Changesets' default behavior to resolve the workspace dependency graph?
**Options**:
- A) Rely on Changesets default: Changesets and pnpm handle workspace protocol replacement and publish ordering automatically. No explicit ordering needed.
- B) Explicit topological publish: Add explicit publish ordering in the workflow to ensure dependencies are published before dependents, avoiding potential race conditions.
**Answer**:

### Q2: CI behavior when lint/test/build scripts are missing in a package
**Context**: The spec uses `pnpm -r run lint`, `pnpm -r run test`, and `pnpm -r run build` to run scripts across all active workspace packages. By default, `pnpm -r run <script>` will silently skip packages that don't define the script. However, if a package defines the script but it fails, CI should catch that. The current packages all have these scripts, but future packages might not. The spec doesn't clarify whether `--if-present` should be used or whether missing scripts should be treated as errors.
**Question**: Should CI use `pnpm -r run --if-present` (silently skip packages missing a script) or fail if any active workspace package is missing lint/test/build scripts?
**Options**:
- A) Use `--if-present` (recommended): Silently skip packages that don't define a particular script. This is more resilient to adding new packages that may not yet have all scripts.
- B) Fail on missing scripts: Treat a missing script as an error to enforce that all packages must have lint, test, and build scripts.
**Answer**:

### Q3: Preview publish — git state after snapshot versioning
**Context**: The `changeset version --snapshot preview` command modifies `package.json` files in the working directory to apply snapshot versions. The spec doesn't specify whether these changes should be committed/discarded after publishing, or whether `--no-git-checks` alone is sufficient. If the workflow doesn't reset the git state, subsequent steps or workflow re-runs could behave unexpectedly.
**Question**: After `changeset version --snapshot preview` modifies package.json files, should the workflow explicitly reset git state (e.g., `git checkout -- .`) after publishing, or rely on the ephemeral nature of the GitHub Actions runner?
**Options**:
- A) Rely on ephemeral runner (recommended): GitHub Actions runners are disposable — the modified working directory is discarded after the job completes. No explicit cleanup needed.
- B) Explicit git reset: Add `git checkout -- .` after publishing to ensure a clean state, as a defensive measure for any downstream steps.
**Answer**:

### Q4: CI trigger scope — should CI run on ALL file changes or filter paths?
**Context**: The spec says CI triggers on PRs targeting develop/main and pushes to those branches, but doesn't specify path filters. Without path filters, CI will run on every PR including docs-only, spec-only, or config-only changes (e.g., editing README.md, CLAUDE.md, or files in specs/). This burns CI minutes unnecessarily but ensures nothing slips through.
**Question**: Should the CI workflow include path filters to skip runs for non-code changes (docs, specs, configs), or run on every PR regardless?
**Options**:
- A) No path filters — run on everything (recommended): Simpler to maintain, ensures nothing is missed, avoids the risk of stale path filter lists.
- B) Path filters to skip docs/specs: Add `paths-ignore` for `docs/**`, `specs/**`, `*.md`, `LICENSE`, etc. to save CI minutes on non-code PRs.
- C) Path filters to include only code: Add `paths` filter for `src/**`, `packages/**`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, etc.
**Answer**:

### Q5: Root eslint ignores packages/ — should CI lint packages separately or together?
**Context**: The root `.eslintrc.json` has `"ignorePatterns": ["dist/", "node_modules/", "packages/"]`, meaning `pnpm lint` at root only lints `src/` and `tests/`. The spec proposes running both `pnpm lint` (root) and `pnpm -r run lint` (per-package). Each package has its own eslint config. This is correct but the spec's CI workflow YAML doesn't call `pnpm -r run lint` — it only shows `pnpm lint` and then `pnpm -r run lint` as separate steps. Should these be validated as independent or could there be config conflicts?
**Question**: The spec's CI design running root lint + per-package lint separately is correct given root eslint ignores `packages/`. Should we also verify that packages without their own `.eslintrc` inherit correctly, or treat each package's lint config as independent?
**Options**:
- A) Treat as independent (recommended): Each package manages its own lint config. Root lint covers root src/. Per-package lint covers package src/. No cross-validation needed.
- B) Add shared eslint config: Create a shared eslint config package that root and all packages extend, ensuring consistency.
**Answer**:

### Q6: Build order — should root build before or after package builds?
**Context**: The spec's CI YAML runs `pnpm build` (root) before `pnpm -r run build` (packages). However, the root `package.json` has dependencies on `express`, `ioredis`, `uuid` and root `src/` contains router/worker/service code. It's unclear whether the root build depends on any package outputs or vice versa. If `@generacy-ai/generacy` or `@generacy-ai/orchestrator` imports from root, or root imports from packages, the build order matters.
**Question**: Does the root `src/` code have import dependencies on any of the workspace packages (or vice versa) that would require a specific build order?
**Options**:
- A) Root first, then packages: Root src/ is independent of packages. Build root first, then packages.
- B) Packages first, then root: Root imports from packages. Build packages first so root can resolve imports.
- C) Let pnpm handle ordering: Use `pnpm -r run build` for everything (including root) and let pnpm resolve the dependency graph.
**Answer**:

### Q7: NPM_TOKEN — should it be a granular token or automation token?
**Context**: The spec states `NPM_TOKEN` must be configured as a GitHub Actions secret but doesn't specify the npm token type. npm offers several token types: legacy (full access), granular (scoped to specific packages with read/write permissions), and automation tokens (bypass 2FA for CI). The choice affects security posture.
**Question**: What type of npm token should be used for the `NPM_TOKEN` secret?
**Options**:
- A) Granular access token (recommended): Scoped to `@generacy-ai/*` packages with read-write publish permissions. Most secure, limits blast radius.
- B) Automation token: Classic token type that bypasses 2FA requirements. Simpler but broader access.
- C) Document but don't prescribe: Note in the spec that token configuration is a manual step and let the team choose.
**Answer**:

### Q8: Concurrency controls — should workflows cancel in-progress runs?
**Context**: The spec doesn't mention GitHub Actions concurrency controls. Without them, multiple CI runs can queue up on the same branch (e.g., rapid pushes to a PR), and multiple publish workflows could race on develop or main. GitHub Actions supports `concurrency` groups that cancel in-progress runs when a new one starts.
**Question**: Should the workflows use GitHub Actions `concurrency` groups to cancel in-progress runs when new commits are pushed?
**Options**:
- A) Add concurrency controls (recommended): Use `concurrency: { group: "${{ github.workflow }}-${{ github.ref }}", cancel-in-progress: true }` for CI. For publish workflows, use concurrency groups without cancellation to prevent partial publishes.
- B) No concurrency controls: Let all workflow runs complete. Simpler but wastes CI minutes and could cause publish races.
**Answer**:

### Q9: Permissions — should workflows use least-privilege GITHUB_TOKEN permissions?
**Context**: The spec's workflow YAMLs don't specify `permissions` blocks. By default, GitHub Actions grants broad read-write permissions to the `GITHUB_TOKEN`. The existing `publish-devcontainer-feature.yml` already uses explicit permissions (`contents: read`, `packages: write`). Security best practice is to use least-privilege permissions.
**Question**: Should the new workflows explicitly declare minimal `GITHUB_TOKEN` permissions?
**Options**:
- A) Explicit least-privilege permissions (recommended): Add `permissions` blocks — CI needs `contents: read`, release needs `contents: write` + `pull-requests: write` for creating Version Packages PRs.
- B) Use defaults: Rely on repository-level default permissions. Simpler but less secure.
**Answer**:

### Q10: Changesets — what should `linked` configuration be?
**Context**: The spec sets `"linked": []` in `.changeset/config.json`. Changesets' `linked` option forces packages to always bump versions together (e.g., if one package gets a minor bump, all linked packages also get minor). Given the dependency chain (workflow-engine -> orchestrator -> generacy), linking them could ensure version consistency, but it also means a patch to workflow-engine forces a version bump on orchestrator and generacy even if they have no changes.
**Question**: Should any of the workspace packages be linked in Changesets config so their versions are bumped together?
**Options**:
- A) No linking (recommended): Let each package version independently. `updateInternalDependencies: "patch"` already ensures dependents get bumped when their dependencies change.
- B) Link the dependency chain: Link `workflow-engine`, `orchestrator`, and `generacy` so they always share the same version number.
- C) Link all @generacy-ai packages: Force all 5 publishable packages to share a single version number.
**Answer**:

### Q11: Preview publish — how to handle the generacy-extension in snapshot versioning
**Context**: The Changesets config ignores `generacy-extension`, but the `publish-preview.yml` workflow runs `pnpm -r publish`. Since `generacy-extension` doesn't have `publishConfig` and is a VS Code extension (not scoped `@generacy-ai/*`), running `pnpm -r publish` without a filter could attempt to publish it to npm and fail. The spec doesn't specify whether to filter the publish command.
**Question**: Should the publish commands in both preview and release workflows use a `--filter` to explicitly exclude `generacy-extension`, or rely on Changesets' `ignore` config to skip it?
**Options**:
- A) Rely on Changesets ignore config (recommended): Changesets won't bump the extension's version, so `pnpm -r publish` will skip it since its version won't change (npm rejects same-version publishes).
- B) Explicit filter: Use `pnpm -r --filter '!generacy-extension' publish` to explicitly exclude the extension from publish commands.
**Answer**:

### Q12: Should the `generacy` CLI package publish its `bin` field correctly?
**Context**: `@generacy-ai/generacy` has a `"bin": { "generacy": "./bin/generacy.js" }` field, meaning it installs a CLI command globally. The `files` field includes `"bin"` and `"dist"`. However, the spec doesn't address whether the bin script needs any special handling during publish (e.g., shebang lines, executable permissions). If `bin/generacy.js` doesn't have a proper shebang (`#!/usr/bin/env node`), the global install will fail.
**Question**: Should the spec include a verification step to ensure `bin/generacy.js` has a proper shebang line, or is this assumed to already be correct?
**Options**:
- A) Assume it's correct: The bin file is already part of the package and should have been verified during development. Don't add CI checks for this.
- B) Add a CI check: Add a step that verifies `bin/generacy.js` starts with `#!/usr/bin/env node` to catch issues before publish.
**Answer**:

### Q13: What GitHub Actions runner OS version to pin?
**Context**: The spec uses `runs-on: ubuntu-latest` which currently resolves to Ubuntu 22.04 but will eventually roll forward to newer versions. This could cause unexpected CI breakage if a new Ubuntu version changes system libraries or default tools. Some teams pin to a specific version (e.g., `ubuntu-22.04`) for reproducibility.
**Question**: Should the workflows use `ubuntu-latest` (auto-updating) or pin to a specific Ubuntu version?
**Options**:
- A) Use `ubuntu-latest` (recommended): Simpler, automatically gets security updates, and Node.js/pnpm don't depend on OS-specific libraries.
- B) Pin to `ubuntu-22.04`: Maximum reproducibility but requires manual updates when GitHub deprecates the version.
**Answer**:

### Q14: Should pnpm version be pinned in the workflows?
**Context**: The spec mentions "pnpm 9" and the lockfile is version 9.0, but the CI workflow uses `pnpm/action-setup@v4` without specifying a pnpm version. The action can auto-detect the version from `packageManager` field in `package.json`, but the root `package.json` doesn't have a `packageManager` field. Without pinning, the action may install the latest pnpm version which could be incompatible with the lockfile.
**Question**: Should the root `package.json` add a `packageManager` field (e.g., `"packageManager": "pnpm@9.x.x"`) or should the workflow pin the pnpm version explicitly?
**Options**:
- A) Add `packageManager` field to root package.json (recommended): Standard way to pin the package manager version. `pnpm/action-setup@v4` auto-detects it, and Corepack uses it too.
- B) Pin in workflow YAML only: Add `version: 9` to the `pnpm/action-setup` step. Keeps package.json unchanged but version info is only in CI config.
- C) Don't pin: Let the action install the latest pnpm. Risk of lockfile incompatibility.
**Answer**:

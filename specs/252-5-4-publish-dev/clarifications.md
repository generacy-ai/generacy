# Clarification Questions

## Status: Pending

## Questions

### Q1: Agency Package Identity
**Context**: The spec lists `@generacy-ai/agency` as a dependency (1.4) and the install script installs it globally. However, no `@generacy-ai/agency` package exists in the monorepo — the agency functionality in the generacy CLI references `@anthropic-ai/agency` (Anthropic's package). The install script currently runs `npm install -g @generacy-ai/agency@${AGENCYVERSION}`, which would fail if this package doesn't exist on npm.
**Question**: Which npm package should the dev container feature install for Agency MCP?
**Options**:
- A) `@anthropic-ai/agency`: Install Anthropic's official agency package, matching what the generacy CLI subprocess mode uses (`npx @anthropic-ai/agency`)
- B) `@generacy-ai/agency`: A new wrapper package will be created as part of issue 1.4 before this feature ships
- C) No global install: Agency should be invoked via `npx` at runtime rather than globally installed in the container
**Answer**:

### Q2: Preview npm Package Resolution
**Context**: The spec says the preview feature "installs `@preview`-tagged npm packages" (US2 AC), but the `install.sh` script uses `${VERSION}` (from the `version` option, default `"latest"`) and `${AGENCYVERSION}` (from `agencyVersion`, default `"latest"`). There is no mechanism in the feature to automatically resolve to preview-tagged npm packages — the consumer would need to manually set `version: "preview"` in their devcontainer.json options.
**Question**: Should the preview-published feature automatically install preview-tagged npm packages, or should consumers opt-in via feature options?
**Options**:
- A) Bake preview tags into the artifact: The preview publish workflow should modify `devcontainer-feature.json` to set default option values to `"preview"` before pushing the OCI artifact, so consumers of `:preview` automatically get preview npm packages
- B) Consumer opt-in: The `:preview` tag is just for the container feature itself; consumers must explicitly set `"version": "preview"` in their devcontainer.json options to get preview npm packages
- C) Hardcode in install.sh: The install script should detect if it's a preview build (e.g., via an environment variable or embedded marker) and use the `preview` npm tag automatically
**Answer**:

### Q3: TypeScript-Node Base Image Test Scenario
**Context**: US1 AC and FR-012 require validating the feature on "Python, Ubuntu, and TypeScript-Node base images." The test matrix in the spec includes `defaults_python` and `defaults_ubuntu` scenarios, but there is no scenario for a TypeScript-Node base image. The existing `scenarios.json` also lacks this scenario.
**Question**: Should a TypeScript-Node base image test scenario be added?
**Options**:
- A) Add scenario: Create a `defaults_typescript_node` scenario using `mcr.microsoft.com/devcontainers/typescript-node:22` to fully satisfy the acceptance criteria
- B) Skip for now: The Python and Ubuntu scenarios provide sufficient coverage since all are Debian-based; add TypeScript-Node testing later
**Answer**:

### Q4: Install Failure Behavior
**Context**: The install script (`install.sh`) runs tool installations sequentially but does not define a clear failure strategy. If one optional tool (e.g., Claude Code or Agency) fails to install, it's unclear whether the entire feature install should fail or whether it should continue with a warning. The `set -e` at the top of the script means any failure aborts the entire install.
**Question**: What should happen when an optional tool installation fails?
**Options**:
- A) Fail fast (current behavior): Keep `set -e` — any installation failure aborts the entire feature. This ensures a fully consistent environment but blocks container creation if any single tool has a transient npm failure.
- B) Graceful degradation: Wrap optional tool installs (Claude Code, Agency) in error handlers that log warnings but allow the feature to complete. Only fail on required tools (Node.js, GH CLI, Generacy CLI).
- C) Retry then fail: Add a retry mechanism (e.g., 2 retries with backoff) for npm installs before failing. Transient registry errors are common in CI.
**Answer**:

### Q5: Feature Version Bump Timing
**Context**: The feature's `devcontainer-feature.json` is currently at version `0.1.0`. The spec references `:1` tags (implying version `1.0.0`), but the semver tagging section clarifies that `devcontainers/action@v1` reads the version from `devcontainer-feature.json` and would currently produce `:0`, `:0.1`, `:0.1.0` tags. The implementation checklist includes bumping to `1.0.0` for stable, but it's unclear when this bump should happen relative to this feature's work.
**Question**: When should `devcontainer-feature.json` be bumped to `1.0.0`?
**Options**:
- A) As part of this PR: Bump to `1.0.0` now so the first stable publish produces the `:1` tag referenced in user stories and acceptance criteria
- B) After validation: Keep at `0.1.0` for the initial preview publish to validate the pipeline works, then bump to `1.0.0` in a follow-up PR before the first stable release to `main`
- C) Semantic decision: Only bump to `1.0.0` when the feature is considered production-ready; ship as `0.x` initially and accept that stable tags will be `:0`, `:0.1`, etc.
**Answer**:

### Q6: GHCR Visibility Automation
**Context**: FR-004 states GHCR package visibility must be set to public manually after first publish. The implementation checklist includes this as a manual step. However, the `gh` CLI can toggle package visibility programmatically (`gh api --method PATCH /orgs/{org}/packages/container/{package} -f visibility=public`). This could be added to the workflow to avoid a manual step that might be forgotten.
**Question**: Should the workflow attempt to set GHCR package visibility to public automatically?
**Options**:
- A) Keep manual: Leave as a documented one-time manual step — it only needs to happen once and automating it requires additional permissions (`packages: admin` or org-level token)
- B) Automate with fallback: Add a step to the workflow that attempts to set visibility to public, but doesn't fail if it lacks permissions. Log a warning if the step is skipped.
**Answer**:

### Q7: oras CLI Version Pinning
**Context**: The spec lists `oras` CLI version 1.2.0 as an assumption, and the publish workflow installs it. The workflow currently pins `VERSION="1.2.0"`. If a newer oras version introduces breaking changes or the 1.2.0 release is removed, the workflow would fail. Conversely, always using 1.2.0 means missing potential fixes.
**Question**: How should the oras CLI version be managed in the workflow?
**Options**:
- A) Pin to 1.2.0 (current): Keep the exact version pin for maximum reproducibility. Update manually when needed.
- B) Pin to major version: Use `1.x` range (e.g., download the latest `1.*` release) to get patch fixes automatically while avoiding major breaking changes
- C) Use latest: Always use the latest oras release for the most up-to-date fixes, accepting the risk of unexpected breakage
**Answer**:

### Q8: Changeset Detection for Preview Skip
**Context**: US4 AC states preview publish should be "skipped when no changesets are present (no-op merge)." The `publish-preview.yml` workflow checks for changesets by looking for files in `.changeset/` (excluding `README.md`). However, changesets could exist for packages unrelated to the dev container feature (e.g., a changeset for the orchestrator). In that case, the dev container feature would be republished even though nothing changed in it.
**Question**: Should the preview publish be scoped to only trigger when changesets affect feature-relevant packages?
**Options**:
- A) Any changeset triggers publish (current): Any changeset in the repo triggers a dev container feature republish. This is simple and ensures the feature always has the latest preview npm packages.
- B) Scoped changesets: Only trigger if changesets affect `@generacy-ai/generacy`, `@generacy-ai/agency`, or the `devcontainer-feature` package itself. This avoids unnecessary publishes but adds complexity.
**Answer**:

### Q9: Claude Code Version Pinning
**Context**: FR-007 installs Claude Code via `npm install -g @anthropic-ai/claude-code` (implicitly `@latest`). The "Out of Scope" section explicitly excludes "Feature option to install specific Claude Code versions." However, using `@latest` means different container builds could get different Claude Code versions, making environments non-reproducible. A major Claude Code update could also break workflows.
**Question**: Is the `@latest` strategy for Claude Code acceptable, or should the feature pin to a known-good version?
**Options**:
- A) Always latest (current): Accept that Claude Code version varies between builds. This ensures users always have the newest features and is explicitly the current design choice.
- B) Pin in install script: Hardcode a known-good Claude Code version in `install.sh` and update it periodically. More reproducible but requires manual maintenance.
- C) Add a feature option: Despite being listed as out of scope, add a `claudeCodeVersion` option (default `"latest"`) to give consumers control without changing the default behavior.
**Answer**:

### Q10: Multi-Repo Template Fix Scope
**Context**: The Known Issues section identifies a GHCR path mismatch in the multi-repo template (`ghcr.io/generacy-ai/features/generacy` → `ghcr.io/generacy-ai/generacy/generacy`). The single-repo template already has the correct path. The fix is a one-line change, but it's in a different package (`@generacy-ai/templates`) and may warrant its own changeset.
**Question**: Should the multi-repo template path fix be included in this PR or handled separately?
**Options**:
- A) Include in this PR: Fix the path in the multi-repo template as part of this feature work since it's directly related and trivial
- B) Separate PR: Create a separate issue/PR for the template fix to keep this PR focused on publishing infrastructure
**Answer**:

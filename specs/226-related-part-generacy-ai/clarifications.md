# Clarification Questions

## Status: Resolved

## Questions

### Q1: Agency Package Version Coupling
**Context**: FR-006 states that `@generacy-ai/agency` should use "same version as generacy package" (controlled by `$VERSION`). However, these are separate npm packages that may not always have matching version numbers, especially if one receives a patch release independently of the other.
**Question**: Should the `agency` package version always be pinned to the same version as `generacy`, or should there be a separate `agencyVersion` option? What happens if the user specifies a `version` that exists for `generacy` but not for `agency`?
**Options**:
- A) Same version always: Both packages are published in lockstep and will always have matching versions. If a version doesn't exist for one, the install should fail.
- B) Separate version option: Add an `agencyVersion` option that defaults to `"latest"` independently.
- C) Same version with fallback: Try the same version first, fall back to `latest` if the specified version doesn't exist for agency.
**Answer**: **B) Separate version option.** Agency lives in a separate repo at version `0.0.0`, while generacy is at `0.1.0`. These are independent release cycles — pinning them to the same version will break immediately. Add an `agencyVersion` option defaulting to `"latest"`.

### Q2: Claude Code Installation Method
**Context**: The spec references `https://claude.ai/install.sh` as the installation method for Claude Code. The existing internal Dockerfile at `tetrad-development/.devcontainer/Dockerfile` also installs Claude Code but may use a different method. The official install script's behavior (flags, non-interactive mode, versioning) is not fully specified.
**Question**: Should the feature use the `https://claude.ai/install.sh` script, or install Claude Code via npm (`npm install -g @anthropic-ai/claude-code`)? Does the install script support non-interactive/unattended installation reliably in a container build context?
**Options**:
- A) Official install script: Use `curl -fsSL https://claude.ai/install.sh | sh` — matches Anthropic's recommended approach.
- B) npm global install: Use `npm install -g @anthropic-ai/claude-code` — more predictable in a build context and consistent with how the other packages are installed.
- C) Match internal Dockerfile: Use whatever method the existing `tetrad-development/.devcontainer/Dockerfile` uses for consistency.
**Answer**: **B) npm global install.** Use `npm install -g @anthropic-ai/claude-code`. By the time we install Claude Code, Node.js is guaranteed present. npm install is more deterministic than piping a curl script, avoids user-switching complexity, and is consistent with how we install the other two packages. The existing Dockerfile uses the curl approach, but a devcontainer feature has different constraints (no guaranteed `USER` directive, need idempotency).

### Q3: Node.js Version Detection Granularity
**Context**: US3 says "if `node` is already on `$PATH`, Node.js installation is skipped." But the user may have Node.js 18 installed while requesting `nodeVersion: "22"`. The spec doesn't clarify whether the existing version should be validated against the requested version.
**Question**: If Node.js is already installed but at a different major version than the requested `nodeVersion`, should the feature skip installation (trust the existing version), install the requested version alongside it, or fail with an error?
**Options**:
- A) Skip always: If any Node.js is present, skip installation regardless of version. The user is responsible for their base image's Node version.
- B) Version check: Compare the installed major version against `nodeVersion`. Only skip if they match; install the requested version otherwise.
- C) Skip with warning: Skip installation but emit a warning if the detected version doesn't match the requested version.
**Answer**: **A) Skip always.** If Node.js is present, skip installation regardless of version. This is the standard devcontainer feature pattern — features are composable, and if a base image ships Node 18, that was a deliberate choice. The `installsAfter` declaration already handles ordering with the official Node feature.

### Q4: GitHub CLI Version Detection
**Context**: Similar to Node.js, the spec says to skip GitHub CLI installation if `gh` is on `$PATH`. But no minimum version is specified. Older versions of `gh` may lack features that Generacy tooling depends on.
**Question**: Is any version of `gh` acceptable, or should there be a minimum version check? If a minimum is required, what version?
**Options**:
- A) Any version: If `gh` exists on PATH, skip installation. No version requirement.
- B) Minimum version: Check for a minimum `gh` version (specify which) and install if the existing version is too old.
**Answer**: **A) Any version.** No minimum version needed. `gh auth setup-git` and `gh auth status` (the commands generacy uses) have been stable since gh 2.x. Any version on PATH is fine.

### Q5: Workflow File Location
**Context**: The spec says to create a GitHub Actions workflow for publishing (FR-011), but doesn't specify where the workflow file should live. The generacy repo currently has no `.github/workflows/` directory. The `tetrad-development` repo has `.github/` with label configs but no workflows either. For a monorepo, the workflow must be in the repo root's `.github/workflows/`.
**Question**: Should the publish workflow be placed in `/workspaces/generacy/.github/workflows/`, and is this the correct repository for hosting the devcontainer feature? Or should the feature and its workflow live in the `tetrad-development` repo since it relates to dev container infrastructure?
**Options**:
- A) Generacy repo: Place workflow at `.github/workflows/publish-devcontainer-feature.yml` in the generacy repo, alongside the feature source under `packages/devcontainer-feature/`.
- B) Tetrad-development repo: Move the entire feature package and workflow to the tetrad-development repo, since it's related to dev container infrastructure (issue #6 is in tetrad-development).
- C) Separate repo: Create a dedicated `devcontainer-feature` repository under the `generacy-ai` org, which is the conventional approach for devcontainer features.
**Answer**: **A) Generacy repo.** The feature source already lives at `packages/devcontainer-feature/` in the generacy repo, and the issue (#226) is filed here. The workflow goes at `.github/workflows/publish-devcontainer-feature.yml` in this repo.

### Q6: GHCR Package Visibility
**Context**: The spec mentions "manually mark GHCR package as public" as a post-publish step. This implies the package will initially be private. GHCR packages inherit the repository's visibility by default, and making a package public is a one-time manual action per package name.
**Question**: Is the manual public-marking step acceptable for v1, or should the workflow automate this? Also, does the GitHub org have permissions configured to allow public GHCR packages?
**Options**:
- A) Manual is fine: Document the one-time manual step in the README. It only needs to be done once per package name.
- B) Automate via API: Use `gh api` in the workflow to set package visibility to public after first publish.
**Answer**: **A) Manual is fine.** One-time manual step. Document it in the README. Automating it via API adds complexity for something done once per package name.

### Q7: Install Script Error Handling Strategy
**Context**: The spec requires `set -e` (fail-fast) and FR-007 says to "verify all installations succeeded." But the spec doesn't specify what should happen when an optional component fails. For example, if `installClaudeCode: true` but the Claude Code install script is temporarily unavailable, should the entire feature installation fail?
**Question**: Should failures in optional components (Claude Code, Agency) cause the entire feature installation to fail, or should they be treated as non-fatal warnings?
**Options**:
- A) Fail-fast for all: Any installation failure (including optional components) fails the entire feature. This is the safest approach — the user knows exactly what they got.
- B) Fail-fast for core, warn for optional: Node.js, GitHub CLI, and generacy are required. Claude Code and Agency failures emit a warning but don't fail the build.
- C) Fail-fast for all, with retry: Retry failed installations once before failing, to handle transient network issues.
**Answer**: **A) Fail-fast for all.** If a user sets `installClaudeCode: true` and it fails, they should know. Silent failures are worse than loud failures. Users can explicitly disable optional components via the feature options if they don't need them. `set -e` covers this naturally.

### Q8: npm Registry Authentication
**Context**: The spec assumes `@generacy-ai/generacy` and `@generacy-ai/agency` are published to the public npm registry. However, these packages are currently at v0.1.0 and the `packages/generacy/package.json` doesn't indicate public publishing configuration. If these packages are private or not yet published, the feature's `npm install -g` will fail.
**Question**: Are `@generacy-ai/generacy` and `@generacy-ai/agency` currently published to the public npm registry? If not, what is the timeline, and should the feature support authenticated npm registries (e.g., GitHub Packages)?
**Options**:
- A) Already public: Both packages are on the public npm registry and this is not a concern.
- B) Not yet public, will be: The packages will be published publicly before this feature ships. No auth needed.
- C) Private registry support needed: Add an option for configuring a custom npm registry URL and/or auth token for private packages.
**Answer**: **B) Not yet public, will be.** Both packages are pre-release (`generacy@0.1.0`, `agency@0.0.0`). They'll need to be published to public npm before this feature ships. No private registry support needed for v1.

### Q9: Non-Root User Detection Fallback
**Context**: The spec says Claude Code must be installed as a non-root user, detecting the user via `$_REMOTE_USER` or falling back to "the first non-root user in `/etc/passwd`." Parsing `/etc/passwd` to find the "first non-root user" is ambiguous — system users like `nobody`, `www-data`, `daemon` appear before real users and shouldn't be targeted.
**Question**: What is the correct fallback strategy for detecting the non-root user when `$_REMOTE_USER` is not set? Should there be a minimum UID threshold (e.g., UID >= 1000), or should the feature require `$_REMOTE_USER` to be set?
**Options**:
- A) UID threshold: Fall back to the first user with UID >= 1000 in `/etc/passwd`.
- B) Require _REMOTE_USER: If `$_REMOTE_USER` is not set, skip Claude Code installation with a warning.
- C) Configurable username option: Add a `username` option to the feature so users can explicitly specify the target user.
**Answer**: **A) UID >= 1000 threshold.** `$_REMOTE_USER` is the primary signal (set by the devcontainer spec). Falling back to the first user with UID >= 1000 is the standard convention used by official devcontainer features (e.g., `ghcr.io/devcontainers/features/common-utils`) to skip system accounts like `nobody` and `www-data`.

### Q10: Feature Versioning Strategy
**Context**: The spec uses `version: "0.1.0"` for the feature itself (in `devcontainer-feature.json`), and the publish workflow is triggered by `feature/v*` tags. It's unclear how the feature version in the JSON file relates to the git tag, and who/what is responsible for keeping them in sync.
**Question**: Should the git tag version (e.g., `feature/v0.1.0`) exactly match the version in `devcontainer-feature.json`? Is this enforced automatically, or is it the maintainer's responsibility to keep them in sync?
**Options**:
- A) Manual sync: The maintainer must update `devcontainer-feature.json` version before tagging. Document this in the README.
- B) Automated sync: The workflow extracts the version from the tag and patches `devcontainer-feature.json` before publishing.
- C) Tag-driven: The `devcontainers/action@v1` reads the version from the JSON file regardless of the tag name. The tag is just a trigger.
**Answer**: **C) Tag-driven.** The `devcontainers/action@v1` reads the version from `devcontainer-feature.json` and uses that for the OCI artifact tag. The git tag (`feature/v*`) is just a trigger. The maintainer must keep the JSON version updated, but the action doesn't validate they match — it trusts the JSON.

### Q11: Test Coverage for Option Combinations
**Context**: The spec mentions `scenarios.json` for test configurations but doesn't specify which option combinations should be tested. With 4 options (version, installAgency, installClaudeCode, nodeVersion), there are many possible combinations. Testing all combinations would be slow and expensive.
**Question**: Which specific option combinations should be covered in `scenarios.json`? At minimum, what are the critical test scenarios beyond the default configuration?
**Options**:
- A) Minimal: Default options only, plus one scenario with all optional installs disabled.
- B) Key variations: Default, all-disabled, each optional component disabled individually, and a non-default Node version.
- C) Comprehensive: All pairwise combinations of boolean options, plus version pinning and alternate Node versions.
**Answer**: **B) Key variations.** Test scenarios: (1) defaults on Python base, (2) defaults on Ubuntu base, (3) all optional installs disabled, (4) Claude Code disabled, (5) Agency disabled, (6) non-default Node version (e.g., 20). Good coverage without combinatorial explosion.

### Q12: Existing Node.js Feature Interaction
**Context**: US3/AC says the feature should work "when layered with the official `ghcr.io/devcontainers/features/node` feature." The `installsAfter` declaration (FR-010) ensures ordering, but if the official Node feature is used, this feature's `nodeVersion` option becomes redundant. There could also be conflicts with global npm package paths.
**Question**: When the official Node.js feature is already providing Node.js, should this feature's `nodeVersion` option be silently ignored (since Node is already present), or should it warn the user about the redundancy? Also, should global npm packages be installed using the Node.js provided by the other feature?
**Options**:
- A) Silent skip: Detect Node.js, skip installation, use whatever Node is available for npm installs. No warning.
- B) Warn on mismatch: Skip installation but warn if the detected Node version differs from `nodeVersion`.
- C) Document only: Document in the README that `nodeVersion` is ignored when layered with the official Node feature. No runtime check.
**Answer**: **A) Silent skip.** Detect Node.js, skip installation, use whatever Node is available. No warning needed — this is the standard behavior and the `installsAfter` ordering ensures the official Node feature runs first if present. Documenting the interaction in the README is sufficient.

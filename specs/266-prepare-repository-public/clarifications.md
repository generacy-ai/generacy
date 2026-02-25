# Clarification Questions

## Status: Pending

## Questions

### Q1: Copyright Year in LICENSE
**Context**: The spec says "The copyright year should reflect the year the project was first created" but doesn't specify what that year is. The git history would need to be inspected to determine the first commit date, and there's a choice between using the initial year only (e.g., "2025") vs. a range (e.g., "2025-2026").
**Question**: What copyright year(s) should appear in the LICENSE file?
**Options**:
- A) Year of first commit only (e.g., `Copyright (c) 2025 Generacy AI`): Simple, standard for newer projects
- B) Range from first commit to present (e.g., `Copyright (c) 2025-2026 Generacy AI`): Shows ongoing development, common in actively maintained projects
- C) Present year only (e.g., `Copyright (c) 2026 Generacy AI`): Simplest, avoids needing to look up history
**Answer**:

### Q2: Package Count Discrepancy
**Context**: The spec lists 13 packages under `packages/`, but the actual repository contains 14 packages. The spec is missing `packages/templates/` from its CODEOWNERS mapping table (it's listed in the directory table but the FR-003 requirement says "Map all 13 package directories"). This discrepancy could lead to an incomplete CODEOWNERS file.
**Question**: The repository has 14 packages (the spec table lists all 14 but FR-003 says "13"). Should CODEOWNERS map all 14 directories including `packages/templates/`?
**Options**:
- A) Map all 14 packages: Cover every package in the repo, including templates
- B) Exclude templates from CODEOWNERS: If templates don't need code review assignment
**Answer**:

### Q3: CODEOWNERS GitHub Team Handles
**Context**: The spec uses placeholder team handles like `@generacy-ai/core` and `@generacy-ai/plugins`, but notes these need to be "confirmed during implementation." The repository only references two individual users: `@christrudelpw` and `@mikezouhri`. GitHub CODEOWNERS will fail validation if referenced teams don't exist in the org.
**Question**: What owner handles should be used in CODEOWNERS? Do the GitHub teams `@generacy-ai/core` and `@generacy-ai/plugins` exist, or should we use individual user handles?
**Options**:
- A) Use individual handles (`@christrudelpw`, `@mikezouhri`): Works immediately without org team setup
- B) Use team handles (`@generacy-ai/core`, `@generacy-ai/plugins`): Requires teams to exist in the GitHub org first
- C) Use a single catch-all owner for now: Simplest approach, e.g., `* @christrudelpw @mikezouhri` with no per-directory mapping
**Answer**:

### Q4: CODEOWNERS Granularity for Plugins
**Context**: The spec suggests mapping package directories to owners, but doesn't specify whether the 7 plugin packages (`generacy-plugin-claude-code`, `generacy-plugin-cloud-build`, `generacy-plugin-copilot`, `github-actions`, `github-issues`, `jira`, `templates`) should each have individual owners or share a group owner like `@generacy-ai/plugins`.
**Question**: Should all plugin/integration packages share the same owner, or should specific plugins have different owners?
**Options**:
- A) All plugins share one owner group: Simpler to maintain, one team reviews all integrations
- B) Group by integration type (e.g., GitHub-related vs. others): `github-actions`, `github-issues` get one owner; `jira`, `cloud-build` get another
- C) Each plugin gets its own owner: Maximum specificity but higher maintenance burden
**Answer**:

### Q5: Security Contact Email Address
**Context**: The spec says SECURITY.md should offer GitHub Security Advisories (preferred) "or email" as a reporting channel, but doesn't specify what email address to use. A security contact email is important as a fallback when reporters can't or won't use GitHub's advisory system.
**Question**: What email address should be listed as the security contact in SECURITY.md?
**Options**:
- A) security@generacy.ai: Dedicated security alias (needs to be set up if not already)
- B) chris@generacy.ai: Use the existing admin's email directly
- C) GitHub Security Advisories only, no email: Simplify by using only the GitHub-native channel
**Answer**:

### Q6: Supported Versions Table Scope
**Context**: The spec says the SECURITY.md should list "which versions receive security patches (currently v0.1.x)." Since the project is pre-1.0 and all packages are at v0.1.0, it's unclear whether the supported versions table should cover just the current version or define a forward-looking policy.
**Question**: How should the supported versions table be structured for a v0.1.0 pre-release project?
**Options**:
- A) Only current version supported (v0.1.x: supported, older: not supported): Simple, accurate for current state
- B) Rolling "latest release" policy: State that only the latest released version receives patches, without listing specific versions
- C) Defer the table: State "This project is in early development. All security reports will be evaluated against the latest code on the default branch."
**Answer**:

### Q7: Secrets Scanning Tool Installation
**Context**: The spec recommends `gitleaks` but the development environment may not have it installed. The spec doesn't clarify whether to install it locally, use a Docker image, use npx, or use an alternative tool that's already available.
**Question**: How should the secrets scanning tool be installed and run in the development environment?
**Options**:
- A) Install `gitleaks` binary directly: Download and install the Go binary
- B) Use `gitleaks` via Docker: Run via `docker run` to avoid local installation
- C) Use `trufflehog` via Docker or binary: Alternative tool with different detection patterns
- D) Use any available tool: Let the implementer choose whichever is easiest to install
**Answer**:

### Q8: Handling False Positives from Secrets Scan
**Context**: The `.env.example` file contains values like `your-api-key-here` and `your-github-token` which are clearly placeholders but may trigger secrets scanners. The spec doesn't define a process for documenting false positives or creating an allowlist/baseline configuration for ongoing scanning.
**Question**: Should a `.gitleaksignore` or equivalent allowlist file be created to suppress known false positives for future scans?
**Options**:
- A) Yes, create `.gitleaksignore`: Document false positives so future CI scans don't re-flag them
- B) No, one-time scan only: Just run the scan, review results manually, don't create ongoing config
- C) Create allowlist only if false positives are found: Decide after seeing scan results
**Answer**:

### Q9: Scan Report Artifact
**Context**: The spec describes running `gitleaks detect --report-path gitleaks-report.json` and says to "document findings and remediation steps," but doesn't specify whether the scan report should be committed to the repository, stored elsewhere, or discarded after review.
**Question**: Should the secrets scan report be persisted, and if so, where?
**Options**:
- A) Commit to repo (e.g., `specs/266-prepare-repository-public/gitleaks-report.json`): Provides audit trail within the spec
- B) Do not commit: Report may contain sensitive path information; review and discard
- C) Commit a summary only: Add a brief summary of findings to the spec or PR description without the raw report
**Answer**:

### Q10: Additional Root Config Files in CODEOWNERS
**Context**: The spec says to map "root config files (`package.json`, `tsconfig.json`, etc.)" but doesn't enumerate all files. The repository root contains: `package.json`, `tsconfig.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `vitest.config.ts`, `.eslintrc.json`, `docker-compose.yml`, `docker-compose.override.yml`, `.mcp.json`, `.windsurfrules`, `CLAUDE.md`, `README.md`. Some of these (like `.mcp.json`, `.windsurfrules`, `CLAUDE.md`) are tool-specific configuration that may not need CODEOWNERS mapping.
**Question**: Which root-level config files should be explicitly mapped in CODEOWNERS?
**Options**:
- A) All root files via wildcard (`/* @owner`): Catch-all for any root file changes
- B) Only build/package config files: `package.json`, `tsconfig.json`, `pnpm-workspace.yaml`, `vitest.config.ts`, `.eslintrc.json`
- C) Explicit list of critical files: Enumerate each file individually for maximum control
**Answer**:

### Q11: Docker and Scripts Directories in CODEOWNERS
**Context**: The spec maps `packages/`, root `/src/`, `/docs/`, and `/.github/` but doesn't mention the `docker/`, `scripts/`, `tests/`, or `specs/` directories that also exist in the repository. These contain infrastructure and test code that may benefit from code ownership.
**Question**: Should the CODEOWNERS file also map `docker/`, `scripts/`, `tests/`, and `specs/` directories?
**Options**:
- A) Yes, map all directories: Comprehensive coverage ensures all PRs get reviewers
- B) Map only `docker/` and `scripts/`: Infrastructure code needs review; tests and specs are less critical
- C) No, only map what the spec explicitly lists: Keep CODEOWNERS minimal per the spec's scope
**Answer**:

### Q12: Pre-existing `.agency/`, `.generacy/`, `.specify/`, `.claude/` Directories
**Context**: The repository contains several tool-specific configuration directories (`.agency/`, `.generacy/`, `.specify/`, `.claude/`) that may contain sensitive configuration or should potentially be excluded from the public repository. The spec doesn't address whether these directories should be reviewed for sensitive content before the repo goes public.
**Question**: Should the tool configuration directories (`.agency/`, `.generacy/`, `.specify/`, `.claude/`) be audited for sensitive content, and should any be added to `.gitignore`?
**Options**:
- A) Audit all and add sensitive ones to `.gitignore`: Review each directory and exclude any with private config
- B) Out of scope: The spec only covers LICENSE, SECURITY.md, CODEOWNERS, and git history scanning
- C) Add all tool-config directories to `.gitignore` preemptively: These are local development tool configs and shouldn't be public
**Answer**:

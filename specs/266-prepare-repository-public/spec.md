# Feature Specification: Prepare Repository for Public Visibility

Add the required code artifacts and perform pre-publication audits before making the generacy repo public.

**Branch**: `266-prepare-repository-public` | **Date**: 2026-02-25 | **Status**: Draft

## Summary

The Generacy repository (a TypeScript monorepo for message routing and workflow orchestration) is being prepared for public visibility on GitHub. This requires adding standard open-source governance files (LICENSE, SECURITY.md, CODEOWNERS) and auditing the full git history for accidentally committed secrets. The repository already declares `"license": "MIT"` in `package.json` but lacks a formal LICENSE file, and has no security policy or code ownership configuration. GitHub Settings (branch protection, interaction limits, Actions permissions) are handled separately and are out of scope.

## User Stories

### US1: Open-Source License Clarity

**As a** potential contributor or user of Generacy,
**I want** a clear LICENSE file in the repository root,
**So that** I understand the terms under which I can use, modify, and distribute the software.

**Acceptance Criteria**:
- [ ] A `LICENSE` file exists at the repository root (`/LICENSE`)
- [ ] The license is MIT, consistent with the existing `package.json` `"license": "MIT"` declaration
- [ ] The license includes the correct copyright holder ("Generacy AI") and year
- [ ] The license text matches the canonical MIT license from the OSI

### US2: Security Vulnerability Reporting

**As a** security researcher who discovers a vulnerability in Generacy,
**I want** a documented security policy with clear reporting instructions,
**So that** I can responsibly disclose the issue through the proper channel.

**Acceptance Criteria**:
- [ ] A `SECURITY.md` file exists at the repository root (`/SECURITY.md`)
- [ ] The policy states which versions are supported for security updates
- [ ] The policy provides a private reporting channel (email or GitHub Security Advisories)
- [ ] The policy sets expectations for response time and disclosure timeline
- [ ] The policy explicitly asks reporters NOT to open public issues for security vulnerabilities

### US3: Automated Code Review Assignment

**As a** maintainer of the Generacy monorepo,
**I want** a CODEOWNERS file that maps directories to responsible owners,
**So that** pull requests are automatically assigned to the right reviewers.

**Acceptance Criteria**:
- [ ] A `.github/CODEOWNERS` file exists
- [ ] The file maps package directories under `packages/` to appropriate owners
- [ ] Root configuration files are mapped to core maintainers
- [ ] Documentation (`docs/`) is mapped to appropriate owners
- [ ] GitHub Actions workflows (`.github/`) are mapped to appropriate owners
- [ ] The CODEOWNERS syntax is valid (GitHub-compatible patterns)

### US4: Clean Git History

**As a** maintainer preparing the repository for public access,
**I want** the full git history audited and confirmed free of secrets,
**So that** no credentials, API keys, or sensitive data are exposed when the repository becomes public.

**Acceptance Criteria**:
- [ ] The entire git history has been scanned using an automated secrets detection tool
- [ ] Any detected secrets have been rotated/revoked regardless of whether they remain in history
- [ ] If secrets are found in history, they have been scrubbed using `git filter-repo` or BFG Repo Cleaner
- [ ] A re-scan confirms no secrets remain in any commit
- [ ] The `.env.example` file has been reviewed to confirm it contains only placeholder values
- [ ] The `.gitignore` correctly excludes `.env`, `.env.local`, and `.env.*.local` files

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add MIT LICENSE file to repository root | P1 | Must match `package.json` declaration. Copyright holder: "Generacy AI". Use canonical OSI text. |
| FR-002 | Add SECURITY.md to repository root | P1 | Include: supported versions table, private reporting instructions (GitHub Security Advisories), response timeline, coordinated disclosure policy. |
| FR-003 | Add `.github/CODEOWNERS` file | P1 | Map all 13 package directories, root `/src/`, `/docs/`, `/.github/`, and root config files to owners. |
| FR-004 | Scan full git history for secrets using automated tooling | P1 | Use `gitleaks`, `trufflehog`, or equivalent. Scan ALL branches and ALL commits. |
| FR-005 | Remediate any secrets found in git history | P1 | Rotate/revoke found credentials first, then scrub from history using `git filter-repo` or BFG if needed. |
| FR-006 | Verify `.env.example` contains only placeholder values | P2 | File currently includes `API_KEY`, `GITHUB_TOKEN`, `REDIS_URL` — confirm these are example-only values. |
| FR-007 | Verify `.gitignore` excludes all sensitive file patterns | P2 | Confirm `.env`, `.env.local`, `.env.*.local`, and credential files are excluded. Already covered in current `.gitignore`. |

## Implementation Details

### FR-001: LICENSE File

Create `/LICENSE` using the standard MIT license text. The copyright year should reflect the year the project was first created. The holder should be "Generacy AI" as declared in `package.json` `"author"` field.

### FR-002: SECURITY.md

The file should follow the [GitHub security policy format](https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository) and include:

1. **Supported Versions** — A table listing which versions receive security patches (currently v0.1.x).
2. **Reporting a Vulnerability** — Instructions to use GitHub Security Advisories (preferred) or email. Explicit instruction NOT to file public issues.
3. **Response Expectations** — Acknowledgment within 48 hours, triage within 7 days.
4. **Disclosure Policy** — Coordinated disclosure with a 90-day timeline.

### FR-003: .github/CODEOWNERS

The CODEOWNERS file should map the monorepo structure. The 13 packages under `packages/` are:

| Directory | Description |
|-----------|-------------|
| `packages/generacy/` | Headless workflow CLI |
| `packages/orchestrator/` | API server (Fastify) |
| `packages/workflow-engine/` | Shared workflow engine |
| `packages/knowledge-store/` | Knowledge store service |
| `packages/generacy-extension/` | VS Code extension |
| `packages/devcontainer-feature/` | Dev container feature |
| `packages/templates/` | Templates |
| `packages/generacy-plugin-claude-code/` | Claude Code plugin |
| `packages/generacy-plugin-cloud-build/` | Cloud Build plugin |
| `packages/generacy-plugin-copilot/` | Copilot plugin |
| `packages/github-actions/` | GitHub Actions plugin |
| `packages/github-issues/` | GitHub Issues plugin |
| `packages/jira/` | Jira plugin |

Additional paths to map: root `/src/`, `/docs/`, `/.github/`, and root config files (`package.json`, `tsconfig.json`, etc.).

Owner handles should be GitHub team or user references (e.g., `@generacy-ai/core`, `@generacy-ai/plugins`). Exact handles to be confirmed during implementation.

### FR-004/FR-005: Git History Audit

**Recommended tool**: `gitleaks` (widely adopted, supports custom rules, CI-friendly).

**Process**:
1. Install `gitleaks` (or use Docker image)
2. Run full scan: `gitleaks detect --source . --verbose --report-path gitleaks-report.json`
3. Review findings — classify as true positives or false positives
4. For true positives:
   a. Immediately rotate/revoke the exposed credential
   b. Scrub from history using `git filter-repo` or BFG Repo Cleaner
   c. Force-push the cleaned history (coordinate with all contributors)
5. Re-run scan to confirm clean history
6. Document findings and remediation steps

**Known areas of concern** (from `.env.example`):
- `API_KEY` — verify no real API keys appear in any commit
- `GITHUB_TOKEN` — verify no real tokens in history
- `REDIS_URL` — verify no production Redis URLs with credentials

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | LICENSE file present and valid | MIT license at repo root | File exists and matches OSI MIT template |
| SC-002 | SECURITY.md present and complete | All required sections present | File contains: supported versions, reporting instructions, response timeline, disclosure policy |
| SC-003 | CODEOWNERS file present and valid | All package directories mapped | File exists in `.github/`, covers all 13 packages + root paths, uses valid GitHub syntax |
| SC-004 | Git history clean of secrets | Zero true-positive findings | Automated scan with `gitleaks` or equivalent returns zero findings across all commits and branches |
| SC-005 | `.env.example` contains only placeholders | No real credentials | Manual review confirms all values are examples |
| SC-006 | `.gitignore` covers sensitive patterns | All env/credential patterns excluded | `.env`, `.env.local`, `.env.*.local` present in `.gitignore` |

## Assumptions

- The license is MIT, consistent with the existing `package.json` `"license": "MIT"` declaration
- The copyright holder is "Generacy AI" as stated in `package.json` `"author"` field
- GitHub Security Advisories will be the primary vulnerability reporting channel
- CODEOWNERS will use GitHub team handles (e.g., `@generacy-ai/core`) — exact handles to be confirmed during implementation
- The repository has a manageable git history size for full-history scanning
- If secrets are found in history and require scrubbing, a force-push is acceptable since the repo is not yet public
- Contributors will be notified if history rewriting occurs and will need to re-clone
- The `.gitignore` already correctly excludes environment and credential files (confirmed during exploration)

## Out of Scope

- GitHub Settings configuration (branch protection rules, PR restrictions, interaction limits, Actions permissions) — handled in a separate interactive session per issue context
- Adding `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, or other community health files beyond those specified in the issue
- Setting up GitHub issue templates or PR templates
- CI/CD pipeline changes or GitHub Actions workflow modifications
- npm package publishing configuration
- Documentation site deployment
- Dependabot or automated security scanning setup
- Signing commits or enforcing GPG/SSH signatures

## Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Real secrets found in git history | High — credentials could be exploited if repo goes public | Medium — `.env` is gitignored but mistakes happen | Run automated scan before making repo public; rotate any found credentials immediately |
| History rewriting breaks contributor workflows | Medium — contributors must re-clone | Low — repo is not yet public | Coordinate timing; notify all contributors before force-push |
| CODEOWNERS team handles don't exist yet in GitHub org | Low — PR auto-assignment won't work | Medium — org may not have teams configured | Verify team handles exist or use individual user handles as fallback |

## Dependencies

- Access to a secrets scanning tool (`gitleaks`, `trufflehog`, or equivalent) in the development environment
- Knowledge of the GitHub organization's team structure for CODEOWNERS
- Authority to rotate/revoke any credentials found in git history
- Ability to force-push to the repository if history rewriting is required

---

*Generated by speckit*

# Tasks: Prepare Repository for Public Visibility

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Static Files — LICENSE, SECURITY.md, CODEOWNERS

These three files are independent of each other and can be created in parallel.

### T001 [P] Add LICENSE file
**File**: `LICENSE` (new)
- Create MIT license file at repository root
- Use copyright line: `Copyright (c) 2026 The Generacy AI Authors`
- Use standard MIT license text (matches `"license": "MIT"` already in `package.json`)
- Verify the full license text matches the OSI-approved MIT template

### T002 [P] Add SECURITY.md
**File**: `SECURITY.md` (new)
- Create security policy document at repository root
- Include "Reporting a Vulnerability" section with:
  - Primary channel: GitHub Security Advisories (link to repo's security advisories page)
  - Fallback: `security@generacy.ai` email
- Include "Scope" section defining what constitutes a security issue vs. a bug
- Include "Supported Versions" section with early-development statement: "This project is in early development. All security reports will be evaluated against the latest code on the default branch."
- Include "Response Timeline" section: acknowledgment within 48 hours, target fix within 90 days
- Include "Disclosure Policy" section: coordinated disclosure after patch is available

### T003 [P] Add .github/CODEOWNERS
**File**: `.github/CODEOWNERS` (new)
- Create CODEOWNERS file in `.github/` directory (directory already exists)
- Add default owner: `* @generacy-ai/core`
- Map 6 core packages to `@generacy-ai/core`:
  - `/packages/generacy/`
  - `/packages/orchestrator/`
  - `/packages/workflow-engine/`
  - `/packages/knowledge-store/`
  - `/packages/generacy-extension/`
  - `/packages/devcontainer-feature/`
- Map 7 plugin packages to `@generacy-ai/plugins`:
  - `/packages/generacy-plugin-claude-code/`
  - `/packages/generacy-plugin-cloud-build/`
  - `/packages/generacy-plugin-copilot/`
  - `/packages/github-actions/`
  - `/packages/github-issues/`
  - `/packages/jira/`
  - `/packages/templates/`
- Map infrastructure directories to `@generacy-ai/core`:
  - `/src/`, `/docs/`, `/docker/`, `/scripts/`, `/tests/`, `/specs/`, `/.github/`
- Add clear section comments for readability

---

## Phase 2: Tool-Config Directory Audit

### T004 Audit tool-config directories for sensitive content
**Directories**:
- `.agency/` — `agency.config.json`
- `.claude/` — `autodev.json`
- `.generacy/` — `speckit-feature.yaml`, `speckit-bugfix.yaml`
- `.specify/` — `templates/*.md`
- Verify no API keys, tokens, credentials, or connection strings in any file
- Determine if any directories need to be added to `.gitignore`
- **Expected result**: All directories are safe (confirmed during planning); no `.gitignore` changes needed

---

## Phase 3: Secrets Audit with Gitleaks

This phase must run after Phase 1 so that the new files are committed and included in the scan. Tasks within Phase 3 are sequential.

### T005 Install gitleaks binary
**Action**: Download and install gitleaks
- Download pre-built Linux amd64 binary from gitleaks GitHub releases (v8.22.x)
- Extract to `/tmp/gitleaks` (or similar local path)
- Verify binary runs: `/tmp/gitleaks version`

### T006 Create .gitleaks.toml configuration
**File**: `.gitleaks.toml` (new)
- Create gitleaks configuration at repository root
- Extend default gitleaks rules
- Set project title: `"Generacy Gitleaks Configuration"`
- Add allowlist paths: `node_modules`, `pnpm-lock.yaml`, `package-lock.json`, `.env.example`

### T007 Run full git history scan
**Action**: Execute gitleaks scan
- Run: `/tmp/gitleaks detect --source /workspaces/generacy --verbose --report-format json --report-path /tmp/gitleaks-report.json`
- Review all findings in the report
- Classify each finding as true positive or false positive
- **If true positives found**: remediate with `git filter-repo` or BFG Repo Cleaner (blocks T008)
- **If only false positives**: proceed to T008

### T008 Create .gitleaksignore with false positive fingerprints
**File**: `.gitleaksignore` (new)
- Populate with fingerprint hashes from confirmed false positives in the gitleaks report
- Add comments explaining each false positive (e.g., placeholder values in `.env.example`)
- Re-run gitleaks scan to confirm clean output with the ignore file in place

### T009 Update .gitignore with gitleaks report exclusion
**File**: `.gitignore` (modified)
- Add `gitleaks-report.json` entry to `.gitignore`
- Place under a new `# Gitleaks` comment section

---

## Phase 4: Verification & PR

### T010 Run final verification
**Action**: Verify all deliverables
- [ ] `LICENSE` file exists at repo root with correct MIT text, year (2026), and holder ("The Generacy AI Authors")
- [ ] `SECURITY.md` exists at repo root with GitHub Security Advisories link, `security@generacy.ai`, and early-development version policy
- [ ] `.github/CODEOWNERS` exists with mappings for all packages, infrastructure directories, and default owner
- [ ] `.gitleaks.toml` exists at repo root with project-specific configuration
- [ ] `.gitleaksignore` exists (populated after scan)
- [ ] `.gitignore` updated with `gitleaks-report.json`
- [ ] Gitleaks scan completed against full git history with zero unresolved true positives

### T011 Prepare PR description with scan summary
**Action**: Create PR
- Summarize gitleaks scan findings in PR description (per plan: summary only, not raw JSON)
- List all new/modified files
- Note prerequisite: GitHub teams `@generacy-ai/core` and `@generacy-ai/plugins` must exist in the `generacy-ai` org before merging
- Note prerequisite: Verify `security@generacy.ai` email alias exists and forwards correctly

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 and Phase 2 can run in parallel (no dependencies between them)
- Phase 3 (secrets audit) can begin independently of Phase 1/2 for the scan itself, but T006 (gitleaks config) and T008/T009 (gitleaks ignore/gitignore) should be committed alongside Phase 1 files
- Phase 4 depends on all prior phases completing

**Parallel opportunities within phases**:
- **Phase 1**: T001, T002, T003 can all run in parallel (independent files, no shared dependencies)
- **Phase 3**: T005 and T006 can run in parallel; T007 depends on T005; T008 depends on T007; T009 can run in parallel with T006

**Critical path**:
```
T001 ─┐
T002 ─┤
T003 ─┼─► T010 → T011
T004 ─┤
T005 → T007 → T008 ─┤
T006 ─────────────────┤
T009 ─────────────────┘
```

**External prerequisites** (not tasks, but must be verified before merge):
- GitHub teams `@generacy-ai/core` and `@generacy-ai/plugins` exist in the `generacy-ai` org
- Email alias `security@generacy.ai` is configured and forwarding

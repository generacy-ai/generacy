# Tasks: Register VS Code Marketplace Publisher

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] Description`
- **[P]**: Can run in parallel (different files, no dependencies)

---

## Phase 1: Azure DevOps Organization Setup

### T001 Create Azure DevOps Organization
**Manual Setup** (Web Interface)
- Navigate to https://dev.azure.com
- Sign in with chris@generacy.ai Microsoft account
- Create new organization named `generacy-ai`
- Record organization URL (https://dev.azure.com/generacy-ai)
- Verify organization accessible

### T002 Add Co-Administrator to Azure DevOps
**Manual Setup** (Web Interface)
- In Azure DevOps organization settings
- Add @mikezouhri as organization administrator
- Verify both admins can access https://dev.azure.com/generacy-ai
- Confirm admin permissions in organization settings

---

## Phase 2: VS Code Marketplace Publisher Registration

### T003 Register Publisher Account
**Manual Setup** (Web Interface)
- Navigate to https://marketplace.visualstudio.com/manage
- Sign in with chris@generacy.ai (same Microsoft account)
- Click "Create Publisher"
- Enter publisher details:
  - Publisher ID: `generacy-ai` (try alternates: generacy, generacyai if unavailable)
  - Display Name: "Generacy"
  - Description: "AI-powered development workflow tooling"
  - Logo: Skip for initial setup
  - Website: Skip for initial setup
- Link to Azure DevOps organization `generacy-ai`
- Complete email verification if prompted

### T004 Verify Publisher Registration
**Manual Verification** (Web Interface)
- Confirm publisher profile visible at https://marketplace.visualstudio.com/publishers/generacy-ai
- Verify display name shows "Generacy"
- Verify description appears correctly
- Check for no pending verification steps
- Record exact publisher ID registered (if different from generacy-ai)

---

## Phase 3: Personal Access Token (PAT) Generation

### T005 Generate Marketplace Publishing PAT
**Manual Setup** (Web Interface)
- Navigate to https://dev.azure.com/generacy-ai/_usersSettings/tokens
- Click "New Token"
- Configure token settings:
  - Name: `VSCE_PAT_Marketplace_Publishing`
  - Organization: generacy-ai (ensure "All accessible organizations" NOT selected)
  - Expiration: 1 year from creation date (365 days)
  - Scopes: Custom defined → Marketplace: Manage only
- Generate token and immediately copy to secure temporary location
- Record exact expiration date (YYYY-MM-DD format)
- Verify token appears in Azure DevOps token list

---

## Phase 4: GitHub Organization Secret Configuration

### T006 Create GitHub Organization Secret
**Manual Setup** (Web Interface)
- Navigate to https://github.com/organizations/generacy-ai/settings/secrets/actions
- Click "New organization secret"
- Configure secret:
  - Name: `VSCE_PAT` (exact case-sensitive name)
  - Value: Paste PAT from T005
  - Repository access: "All repositories"
- Save secret
- Verify secret appears in organization secrets list
- Verify repository access shows "All repositories"

### T007 Secure PAT Cleanup
**Manual Security Task**
- Delete PAT value from clipboard
- Delete PAT from any temporary notes/files
- Confirm no copies of PAT remain outside GitHub secret
- Verify PAT only stored in GitHub organization secrets

---

## Phase 5: Documentation

### T008 Create Publishing Documentation Directory
**File**: `/docs/publishing/` (in generacy repo)
- Create `/docs/publishing/` directory structure
- Ensure directory is in correct repo (generacy, not agency)

### T009 Write Marketplace Setup Documentation
**File**: `/docs/publishing/vscode-marketplace-setup.md`
- Create comprehensive setup documentation with sections:
  - **Overview**: Purpose and scope of publisher account
  - **Publisher Details**: ID, display name, description, profile URL
  - **Azure DevOps Organization**: Name, URL, purpose
  - **Access Control**:
    - Direct publisher access (christrudelpw, mikezouhri)
    - How to request access
  - **Personal Access Token (PAT)**:
    - Current expiration date (from T005)
    - Scopes granted (Marketplace: Manage)
    - Rotation process (link to T011 checklist)
  - **GitHub Secret**: Name (VSCE_PAT), scope (org-level), repos that use it
  - **Verification Process**: How to test authentication (reference T012)
  - **Troubleshooting**: Common issues and solutions
  - **Links**:
    - Publisher profile URL
    - Azure DevOps org URL
    - GitHub secrets management URL
  - **Future Improvements**:
    - Shared team email migration
    - Branding additions
    - Automated PAT rotation

### T010 [P] Update Generacy Repo README
**File**: `README.md` (in generacy repo)
- Check if publishing documentation section exists
- If yes, add link to `/docs/publishing/vscode-marketplace-setup.md`
- If no, skip or create minimal section linking to docs

### T011 Document PAT Rotation Process
**File**: `/docs/publishing/vscode-marketplace-setup.md`
- Add detailed PAT rotation checklist to documentation:
  - Navigate to Azure DevOps tokens page
  - Generate new PAT with same scopes and 1-year expiration
  - Update GitHub organization secret `VSCE_PAT`
  - Test authentication with vsce login
  - Verify with vsce ls-publishers
  - Delete/revoke old PAT from Azure DevOps
  - Create new rotation tracking issue
  - Update expiration date in documentation

---

## Phase 6: Verification & PAT Rotation Setup

### T012 Install and Verify vsce CLI
**Command Line** (Local Machine)
- Install vsce globally: `npm install -g @vscode/vsce`
- Verify installation: `vsce --version`
- Confirm vsce is accessible in PATH

### T013 Test Publisher Authentication
**Command Line** (Local Machine)
- Run: `vsce login generacy-ai`
- When prompted, paste VSCE_PAT value from GitHub secret
- Verify login succeeds without errors
- Run: `vsce ls-publishers`
- Confirm `generacy-ai` appears in publishers list

### T014 [Optional] Dry-Run Publish Test
**Command Line** (Local Machine)
- Create or navigate to test extension directory
- If needed, create sample extension: `yo code`
- Run: `vsce publish --dry-run`
- Verify package validation completes without errors
- Confirm no actual publish occurs (dry-run only)

### T015 Calculate PAT Expiration Date
**Manual Task**
- From T005, retrieve PAT creation date
- Calculate expiration: creation date + 365 days
- Calculate rotation reminder date: expiration - 14 days
- Format dates as YYYY-MM-DD
- Record both dates for T016

### T016 Create PAT Rotation Tracking Issue
**GitHub Issue** (generacy repo)
- Create new issue with details:
  - Title: "Rotate VSCE_PAT — expires [YYYY-MM-DD]"
  - Description:
    - Link to `/docs/publishing/vscode-marketplace-setup.md`
    - Link to https://dev.azure.com/generacy-ai/_usersSettings/tokens
    - Include PAT rotation checklist (from T011)
  - Labels: maintenance, infrastructure
  - Milestone: None (or Q1/Q2/Q3/Q4 based on expiration quarter)
  - Assignees: @christrudelpw, @mikezouhri
  - Due date: 2 weeks before PAT expiration (from T015)
- Verify issue created and visible
- Confirm assignees and due date set correctly

---

## Phase 7: Post-Implementation Verification

### T017 Validate All Success Criteria
**Verification Checklist**
- [ ] Publisher account `generacy-ai` (or alternate) registered and accessible
- [ ] Azure DevOps organization `generacy-ai` exists with 2 admins
- [ ] PAT generated with Marketplace: Manage scope and 1-year expiration
- [ ] GitHub organization secret `VSCE_PAT` configured with "All repositories" access
- [ ] `vsce login generacy-ai` succeeds (from T013)
- [ ] Documentation complete at `/docs/publishing/vscode-marketplace-setup.md` (from T009)
- [ ] PAT rotation tracking issue created with due date (from T016)

### T018 Verify Documentation Quality
**Documentation Review**
- Review `/docs/publishing/vscode-marketplace-setup.md`:
  - All sections completed with accurate information
  - All links work correctly (publisher profile, Azure DevOps, GitHub secrets)
  - PAT expiration date recorded
  - Access control list accurate
  - Rotation process documented clearly
  - Markdown renders properly in GitHub
  - No sensitive information (PAT values) in documentation

### T019 Security Audit
**Security Verification**
- Confirm PAT has minimal required scopes (Marketplace: Manage only)
- Verify PAT limited to generacy-ai organization (not "All accessible organizations")
- Confirm GitHub secret `VSCE_PAT` uses organization-level scope
- Verify no PAT copies exist outside GitHub secrets
- Check no PAT values committed to git history
- Confirm both admins have access recovery mechanisms

### T020 Notify Stakeholders and Update Dependencies
**Communication and Tracking**
- Notify @christrudelpw and @mikezouhri of completion
- Record actual publisher ID in project notes (if different from generacy-ai)
- Update issue 1.6 (Agency extension CI/CD) noting publisher is ready
- Update issue 1.7 (Generacy extension CI/CD) noting publisher is ready
- Confirm `VSCE_PAT` secret name for use in CI/CD workflows
- Archive any temporary setup notes or credentials

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (Azure DevOps) must complete before Phase 2 (Publisher Registration)
- Phase 2 must complete before Phase 3 (PAT Generation)
- Phase 3 must complete before Phase 4 (GitHub Secret)
- Phases 1-4 must complete before Phase 5 (Documentation)
- Phases 1-5 must complete before Phase 6 (Verification)
- All phases must complete before Phase 7 (Post-Implementation)

**Parallel opportunities within phases**:
- T010 (Update README) can run in parallel with T009 if README structure is known
- T014 (Dry-run test) is optional and can be skipped without affecting other tasks

**Critical path**:
T001 → T002 → T003 → T004 → T005 → T006 → T007 → T008 → T009 → T011 → T012 → T013 → T015 → T016 → T017 → T018 → T019 → T020

**Manual Setup Tasks (No Code)**:
- All tasks in Phases 1-4 are manual web interface operations
- Phase 5 involves documentation writing (manual file creation)
- Phase 6 involves CLI verification commands
- Phase 7 is validation and communication

**Estimated Timeline**:
- Phase 1: ~10 minutes (T001-T002)
- Phase 2: ~15 minutes (T003-T004)
- Phase 3: ~5 minutes (T005)
- Phase 4: ~10 minutes (T006-T007)
- Phase 5: ~20 minutes (T008-T011)
- Phase 6: ~15 minutes (T012-T016)
- Phase 7: ~10 minutes (T017-T020)
- **Total**: ~85 minutes (including optional dry-run test)

**Risk Mitigation**:
- T004: If publisher name unavailable, try alternates (generacy, generacyai)
- T007: Critical security step—verify no PAT copies remain
- T013: If authentication fails, verify secret name and value match
- T016: Ensure due date is 2 weeks before expiration for adequate notice

**Future Maintenance**:
- Annual PAT rotation (follow T011 checklist when T016 issue triggers)
- Periodic review of publisher profile (quarterly)
- Add admins as team grows
- Migrate to shared team email when provisioned

---

**Status**: Ready for Implementation
**Complexity**: Low (infrastructure setup, no coding)
**Risk Level**: Low (well-documented processes)
**Estimated Effort**: ~1.5 hours (including verification and documentation)

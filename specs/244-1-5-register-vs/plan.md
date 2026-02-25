# Implementation Plan: Register VS Code Marketplace Publisher

**Feature**: 244-1-5-register-vs
**Date**: 2026-02-24
**Status**: Ready for Implementation

## Summary

This is an infrastructure and account setup task to establish the `generacy-ai` publisher on the VS Code Marketplace. This one-time setup enables automated publishing of VS Code extensions through CI/CD pipelines for both the Agency (issue 1.6) and Generacy (issue 1.7) extensions.

**Approach**: Manual account creation and configuration through web interfaces, followed by documentation. No code implementation required—this is purely operational setup with documentation deliverables.

## Technical Context

### Platform & Tools
- **VS Code Marketplace**: Extension publishing platform (marketplace.visualstudio.com)
- **Azure DevOps**: Required for PAT generation (dev.azure.com)
- **GitHub Secrets**: Organization-level secret storage for CI/CD
- **vsce CLI**: VS Code Extension Manager (for verification only)

### Key Accounts & Identities
- **Publisher ID**: `generacy-ai` (matches GitHub org and npm scope)
- **Display Name**: "Generacy"
- **Azure DevOps Org**: `generacy-ai` (new organization)
- **Microsoft Account**: `chris@generacy.ai` (initial setup, migrate to shared email later)
- **Account Admins**: @christrudelpw, @mikezouhri

### Dependencies
- None (Phase 1 Foundation task, can start immediately)
- **Enables**: Issues 1.6 (Agency extension CI/CD) and 1.7 (Generacy extension CI/CD)

## Architecture Overview

This is an infrastructure setup task with no application architecture. The setup creates the following relationship:

```
Microsoft Account (chris@generacy.ai)
    ↓
Azure DevOps Organization (generacy-ai)
    ↓
Personal Access Token (VSCE_PAT, 1-year expiration)
    ↓
GitHub Organization Secret (VSCE_PAT)
    ↓
CI/CD Workflows (agency repo, generacy repo)
    ↓
VS Code Marketplace Publisher (generacy-ai)
```

### Access Control Model
- **Direct Publisher Access**: @christrudelpw, @mikezouhri (for manual operations, profile updates)
- **CI/CD Access**: All repos in generacy-ai GitHub org (via org-level secret)
- **PAT Scope**: Marketplace publishing only (principle of least privilege)

## Implementation Phases

### Phase 1: Azure DevOps Organization Setup
**Duration**: ~10 minutes
**Prerequisites**: Microsoft account (chris@generacy.ai)

**Steps**:
1. Navigate to https://dev.azure.com
2. Sign in with chris@generacy.ai
3. Create new organization: `generacy-ai`
4. Add @mikezouhri as organization administrator
5. Verify organization URL: https://dev.azure.com/generacy-ai

**Deliverables**:
- Azure DevOps organization `generacy-ai` created and accessible
- Both admins have access verified

**Validation**:
- Both @christrudelpw and @mikezouhri can access https://dev.azure.com/generacy-ai
- Organization settings show both users as administrators

---

### Phase 2: VS Code Marketplace Publisher Registration
**Duration**: ~15 minutes
**Prerequisites**: Azure DevOps organization from Phase 1

**Steps**:
1. Navigate to https://marketplace.visualstudio.com/manage
2. Sign in with chris@generacy.ai (same Microsoft account)
3. Click "Create Publisher"
4. Fill in publisher details:
   - **Publisher ID**: `generacy-ai` (try in order: generacy-ai, generacy, generacyai)
   - **Display Name**: Generacy
   - **Description**: "AI-powered development workflow tooling"
   - **Logo**: Skip for initial setup
   - **Website**: Skip for initial setup
5. Link to Azure DevOps organization: `generacy-ai`
6. Complete email verification if prompted
7. Note the exact publisher ID that was successfully registered

**Deliverables**:
- Publisher account created and verified
- Publisher profile page accessible

**Validation**:
- Publisher profile visible at https://marketplace.visualstudio.com/publishers/generacy-ai (or alternate name)
- Profile shows correct display name and description
- No errors or pending verification steps

**Fallback Plan**:
If `generacy-ai` is unavailable, try names in priority order:
1. `generacy-ai` (required for extension IDs generacy-ai.agency, generacy-ai.generacy)
2. `generacy`
3. `generacyai`

If all are taken, escalate to stakeholders for decision on alternate name.

---

### Phase 3: Personal Access Token (PAT) Generation
**Duration**: ~5 minutes
**Prerequisites**: Azure DevOps organization and publisher account from Phases 1-2

**Steps**:
1. Navigate to https://dev.azure.com/generacy-ai/_usersSettings/tokens
2. Click "New Token"
3. Configure PAT:
   - **Name**: `VSCE_PAT_Marketplace_Publishing`
   - **Organization**: generacy-ai
   - **Expiration**: 1 year from creation date (365 days)
   - **Scopes**: Custom defined
     - **Marketplace**: Manage (publish/update/unpublish extensions)
   - Ensure "All accessible organizations" is NOT selected (limit to generacy-ai only)
4. Generate token and **immediately copy to secure temporary location**
5. Record exact expiration date (format: YYYY-MM-DD)

**Deliverables**:
- PAT generated with correct scopes and expiration
- Token value securely stored temporarily (for Phase 4)
- Expiration date recorded

**Security Notes**:
- The token will be shown only once—copy immediately
- Do not commit token to version control
- Do not share token in Slack/email
- Token will be stored as GitHub secret in Phase 4, then temporary copy should be deleted

**Validation**:
- Token displays in Azure DevOps user settings with correct name and expiration
- Token value copied to clipboard/secure note

---

### Phase 4: GitHub Organization Secret Configuration
**Duration**: ~5 minutes
**Prerequisites**: PAT from Phase 3, GitHub organization admin access

**Steps**:
1. Navigate to https://github.com/organizations/generacy-ai/settings/secrets/actions
2. Click "New organization secret"
3. Configure secret:
   - **Name**: `VSCE_PAT`
   - **Value**: Paste PAT from Phase 3
   - **Repository access**: All repositories (enables agency and generacy repos)
4. Save secret
5. **Delete temporary copy of PAT** from clipboard/notes

**Deliverables**:
- `VSCE_PAT` organization secret created
- Secret accessible to all repos in generacy-ai org
- No temporary copies of PAT remaining

**Validation**:
- Secret shows in organization secrets list as `VSCE_PAT`
- Repository access shows "All repositories"
- Original PAT text deleted from temporary storage

---

### Phase 5: Documentation
**Duration**: ~20 minutes
**Prerequisites**: All setup steps completed (Phases 1-4)

**Steps**:
1. Create `/docs/publishing/` directory in generacy repo
2. Create `/docs/publishing/vscode-marketplace-setup.md` with the following sections:
   - **Overview**: Purpose and scope of publisher account
   - **Publisher Details**: ID, display name, description, profile URL
   - **Azure DevOps Organization**: Organization name, URL, purpose
   - **Access Control**:
     - Who has direct publisher access (christrudelpw, mikezouhri)
     - How to request access
   - **Personal Access Token (PAT)**:
     - Current expiration date
     - Scopes granted
     - Rotation process (see Phase 6)
   - **GitHub Secret**: Name, scope (org-level), which repos use it
   - **Verification Process**: How to test authentication (see Phase 6)
   - **Troubleshooting**: Common issues and solutions
   - **Links**:
     - Publisher profile URL
     - Azure DevOps organization URL
     - GitHub secrets management URL
   - **Future Improvements**:
     - Migrate to shared team email (dev@generacy.ai or extensions@generacy.ai)
     - Add branding (logo, website URL)
     - Set up automated PAT rotation/alerting

3. Add entry to generacy repo README (if publishing docs section exists) linking to setup doc

**Deliverables**:
- `/docs/publishing/vscode-marketplace-setup.md` created and committed
- Documentation includes all critical information for future maintenance
- Links verified and working

**Documentation Template** (excerpt):
```markdown
# VS Code Marketplace Publisher Setup

## Overview
This document describes the `generacy-ai` publisher account setup for publishing VS Code extensions to the marketplace.

## Publisher Details
- **Publisher ID**: generacy-ai
- **Display Name**: Generacy
- **Description**: AI-powered development workflow tooling
- **Profile URL**: https://marketplace.visualstudio.com/publishers/generacy-ai

## Azure DevOps Organization
- **Organization Name**: generacy-ai
- **URL**: https://dev.azure.com/generacy-ai
- **Purpose**: Hosts Personal Access Token for marketplace publishing

## Access Control
### Direct Publisher Access
- @christrudelpw (chris@generacy.ai) - Primary owner
- @mikezouhri - Co-administrator

[... continue with remaining sections ...]
```

**Validation**:
- Documentation file exists at correct path
- All sections completed with accurate information
- Links work correctly
- Markdown renders properly in GitHub

---

### Phase 6: Verification & PAT Rotation Setup
**Duration**: ~15 minutes
**Prerequisites**: All previous phases completed

**Steps**:

**Part A: Verify Authentication (Dry-Run)**
1. On local machine, install vsce if not already present:
   ```bash
   npm install -g @vscode/vsce
   ```
2. Verify vsce installation:
   ```bash
   vsce --version
   ```
3. Test authentication with PAT:
   ```bash
   vsce login generacy-ai
   # When prompted, paste the VSCE_PAT value from GitHub secret
   ```
4. If login succeeds, verify publisher access:
   ```bash
   vsce ls-publishers
   # Should show generacy-ai in the list
   ```
5. **Optional**: Create minimal test extension and run dry-run publish:
   ```bash
   # In a test directory:
   yo code  # Create sample extension (or use existing)
   cd test-extension
   vsce publish --dry-run
   # Should validate package without publishing
   ```

**Part B: Set Up PAT Rotation Tracking**
1. Calculate PAT expiration date (1 year from creation)
2. Create GitHub issue in generacy repo:
   - **Title**: "Rotate VSCE_PAT — expires YYYY-MM-DD"
   - **Description**:
     - Link to setup documentation
     - Link to PAT management URL
     - Rotation checklist (generate new PAT, update GitHub secret, test, delete old PAT)
   - **Labels**: maintenance, infrastructure
   - **Milestone**: None (or Q1/Q2/Q3/Q4 based on expiration)
   - **Assignees**: @christrudelpw, @mikezouhri
   - **Due date**: 2 weeks before PAT expiration
3. Document rotation process in setup documentation

**Deliverables**:
- vsce authentication verified (login succeeds)
- PAT rotation tracking issue created
- Rotation process documented

**Validation**:
- `vsce login generacy-ai` succeeds without errors
- `vsce ls-publishers` shows generacy-ai
- Dry-run publish completes validation (if test extension created)
- GitHub issue exists with correct due date and assignees

**PAT Rotation Checklist** (to include in issue and docs):
```markdown
## PAT Rotation Checklist
1. [ ] Navigate to https://dev.azure.com/generacy-ai/_usersSettings/tokens
2. [ ] Generate new PAT with same scopes and 1-year expiration
3. [ ] Update GitHub organization secret `VSCE_PAT` with new value
4. [ ] Test authentication: `vsce login generacy-ai` (paste new PAT)
5. [ ] Verify: `vsce ls-publishers` shows generacy-ai
6. [ ] Delete old PAT from Azure DevOps (revoke)
7. [ ] Create new rotation tracking issue for next year
8. [ ] Update expiration date in documentation
```

---

## Key Technical Decisions

### Decision 1: Publisher ID Selection
**Decision**: Use `generacy-ai` as publisher ID
**Rationale**:
- Consistency across platforms (GitHub org, npm scope, publisher ID)
- Required for extension IDs `generacy-ai.agency` and `generacy-ai.generacy`
- Clearly indicates organizational ownership vs. personal account

**Alternatives Considered**:
- `generacy`: Shorter, but less explicit about organization
- `generacyai`: No hyphen, harder to read

**Trade-offs**: Hyphenated name is slightly longer but more readable and consistent with existing identity

---

### Decision 2: Azure DevOps Organization Creation
**Decision**: Create new organization `generacy-ai` rather than using personal account
**Rationale**:
- Organizational ownership and governance
- Enables multiple administrators
- Professional appearance and branding
- Easier to transfer ownership in future if needed

**Alternatives Considered**:
- Personal Microsoft account: Simpler setup but creates bus factor risk
- Existing organization: None exists yet

**Trade-offs**: Small additional setup time for long-term organizational benefits

---

### Decision 3: GitHub Secret Scope (Organization-Level)
**Decision**: Store `VSCE_PAT` as organization-level secret
**Rationale**:
- Both `agency` repo (1.6) and `generacy` repo (1.7) need access for their CI/CD
- Reduces duplication and maintenance overhead
- Single source of truth for PAT value
- Consistent with plan specification ("Store as GitHub org secret")

**Alternatives Considered**:
- Repository-level secrets: More secure but requires duplication and separate rotation
- Environment-specific secrets: Adds complexity for minimal security benefit in this case

**Trade-offs**: Broader access scope, but all repos in org are trusted and this is acceptable per plan

---

### Decision 4: PAT Expiration (1 Year)
**Decision**: Set PAT expiration to 1 year with annual rotation
**Rationale**:
- Balance between security (regular rotation) and operational overhead
- Aligns with common industry practice for service tokens
- Sufficient time to establish automated rotation process before next renewal
- GitHub issue tracking provides adequate reminder mechanism

**Alternatives Considered**:
- 90 days: Too frequent, high operational overhead for manual rotation
- Maximum/no expiration: Security risk, not aligned with best practices

**Trade-offs**: Annual rotation is still manual work, but acceptable for initial setup

---

### Decision 5: Verification Method (Dry-Run)
**Decision**: Verify using `vsce publish --dry-run` rather than actual test publish
**Rationale**:
- Validates authentication, permissions, and packaging
- No pollution of marketplace with test extensions
- Faster and cleaner than publish-then-unpublish cycle
- Full end-to-end publish will happen naturally with issues 1.6 and 1.7

**Alternatives Considered**:
- Authentication-only test: Doesn't validate full publish workflow
- Actual test publish: Creates unnecessary public extension record

**Trade-offs**: Slightly less comprehensive than full publish, but sufficient for setup verification

---

### Decision 6: Documentation Location
**Decision**: Store setup docs at `/docs/publishing/vscode-marketplace-setup.md` in generacy repo
**Rationale**:
- Generacy repo is primary public coordination repo (per plan issue 1.1)
- `/docs/publishing/` path allows for future npm publishing docs alongside
- Consistent with plan specification
- Accessible to all team members with repo access

**Alternatives Considered**:
- Agency or other extension repo: Wrong scope (org-level setup, not extension-specific)
- Wiki: Less discoverable, harder to version control

**Trade-offs**: Documentation lives in repo that may not be cloned as frequently, but appropriate for infrastructure docs

---

### Decision 7: Initial Microsoft Account (chris@generacy.ai)
**Decision**: Use chris@generacy.ai for initial setup, plan migration to shared email later
**Rationale**:
- Enables immediate progress without waiting for shared email setup
- Chris is primary stakeholder and appropriate owner
- Clear migration path documented in setup docs
- Mikezouhri added as co-admin provides redundancy

**Alternatives Considered**:
- Wait for shared email setup: Blocks progress unnecessarily
- Use personal email: Wrong ownership model for organizational asset

**Trade-offs**: Temporary individual ownership, but mitigated by co-admin and documented migration plan

---

### Decision 8: PAT Rotation Tracking (GitHub Issues)
**Decision**: Use GitHub issue with due date for PAT rotation reminders
**Rationale**:
- Team already uses GitHub for project tracking
- Due dates trigger notifications
- Issue can contain rotation checklist and links
- Visible in project management views
- No new tools or systems required

**Alternatives Considered**:
- Calendar reminders: Easy to miss, no checklist or context
- Documentation-only: Passive, requires manual checking
- Automated alerting: Out of scope for initial setup

**Trade-offs**: Still requires manual process, but provides clear tracking and visibility

---

## Risk Mitigation Strategies

### Risk 1: Publisher Name Unavailable
**Likelihood**: Low
**Impact**: Medium (blocks setup, requires stakeholder decision on alternate name)

**Mitigation**:
- Pre-verified priority order: generacy-ai → generacy → generacyai
- If all unavailable, escalate immediately to stakeholders
- Document actual name registered in all relevant docs and issues 1.6/1.7

**Contingency**:
- Consider variations like generacy-dev, generacy-tools, generacyio
- Evaluate impact on extension IDs (may need to update 1.6 and 1.7 plans)

---

### Risk 2: PAT Expiration Missed
**Likelihood**: Medium (1-year expiration, manual rotation)
**Impact**: High (breaks CI/CD publishing for all extensions)

**Mitigation**:
- GitHub issue with due date 2 weeks before expiration
- Both admins assigned to issue
- Expiration date prominently documented
- Documented rotation checklist reduces error risk

**Contingency**:
- If PAT expires: Generate new PAT immediately (same process as Phase 3-4)
- Test authentication and update secret within 1 hour
- Post-incident: Evaluate automated alerting implementation

**Future Improvement**:
- Implement automated PAT expiration monitoring (webhook or GitHub Action)
- Alert in Slack when <30 days remaining

---

### Risk 3: PAT Leaked or Compromised
**Likelihood**: Low (stored as GitHub secret, limited access)
**Impact**: High (unauthorized publishing, potential supply chain attack)

**Mitigation**:
- Store only as GitHub organization secret (never committed to code)
- Minimal scope (marketplace publishing only, not full Azure DevOps access)
- Limited to generacy-ai organization (not "all accessible organizations")
- GitHub secrets are encrypted at rest and masked in logs

**Contingency**:
- If leaked: Immediately revoke old PAT in Azure DevOps
- Generate new PAT with same scopes
- Update GitHub secret with new value
- Audit recent marketplace activity for unauthorized publishes
- Review all extension versions for tampering

**Detection**:
- Monitor marketplace for unexpected extension publishes/updates
- Review Azure DevOps PAT usage logs periodically

---

### Risk 4: Loss of Admin Access (Bus Factor)
**Likelihood**: Low
**Impact**: High (cannot rotate PAT, update publisher profile, or recover access)

**Mitigation**:
- Two admins configured: christrudelpw and mikezouhri
- Documented process for adding additional admins
- Microsoft account recovery process (phone, alternate email)

**Contingency**:
- If one admin loses access: Other admin can manage
- If both admins lose access: Microsoft account recovery process
- Worst case: Contact Microsoft support for publisher account recovery

**Future Improvement**:
- Migrate to shared team email (dev@generacy.ai or extensions@generacy.ai)
- Add third admin once team grows

---

### Risk 5: GitHub Organization Secret Misconfiguration
**Likelihood**: Low
**Impact**: Medium (CI/CD workflows cannot authenticate, publishes fail)

**Mitigation**:
- Explicit verification in Phase 6 (test vsce login)
- Clear documentation of secret name and scope
- Dry-run publish validates end-to-end workflow

**Contingency**:
- If misconfigured: Re-add secret with correct name and scope
- Test immediately with vsce login
- Update issues 1.6 and 1.7 if secret name changes

**Detection**:
- CI/CD workflow failures will surface immediately when 1.6 and 1.7 are implemented
- Can be detected early with manual vsce login test

---

### Risk 6: Azure DevOps Organization Misconfiguration
**Likelihood**: Low
**Impact**: Medium (PAT generation fails, publishing authentication fails)

**Mitigation**:
- Follow Microsoft documentation exactly during org creation
- Verify both admins can access org before proceeding to Phase 2
- Link publisher to correct org during registration

**Contingency**:
- If org misconfigured: Delete and recreate (no dependencies yet)
- If wrong org linked to publisher: Contact VS Code Marketplace support to update

**Detection**:
- Immediate during Phase 1 verification
- Also detected during PAT generation if org not accessible

---

## Success Criteria

### Primary Success Criteria
1. ✅ Publisher account `generacy-ai` (or alternate) registered and verified
2. ✅ Azure DevOps organization `generacy-ai` created with 2 admins
3. ✅ PAT generated with correct scopes and 1-year expiration
4. ✅ GitHub organization secret `VSCE_PAT` configured and accessible to all repos
5. ✅ `vsce login generacy-ai` succeeds with stored PAT
6. ✅ Documentation complete at `/docs/publishing/vscode-marketplace-setup.md`
7. ✅ PAT rotation tracking issue created with due date

### Verification Tests
1. **Authentication Test**:
   ```bash
   vsce login generacy-ai
   # Expected: Login successful
   ```

2. **Publisher List Test**:
   ```bash
   vsce ls-publishers
   # Expected: generacy-ai appears in list
   ```

3. **Dry-Run Publish Test** (optional but recommended):
   ```bash
   cd test-extension
   vsce publish --dry-run
   # Expected: Package validated, no errors (not actually published)
   ```

4. **Documentation Completeness**:
   - [ ] All sections in template completed
   - [ ] Links verified (publisher profile, Azure DevOps org, GitHub secrets)
   - [ ] Expiration date recorded
   - [ ] Access control documented
   - [ ] Rotation process documented

5. **GitHub Secret Accessibility**:
   - [ ] Secret visible in org secrets list
   - [ ] Repository access shows "All repositories"
   - [ ] Secret name is exactly `VSCE_PAT` (case-sensitive)

### Non-Functional Acceptance
- Setup can be completed within 1 hour total time
- All temporary copies of PAT deleted after GitHub secret created
- Both admins can access publisher account and Azure DevOps org
- Documentation is clear enough for new team member to understand setup

---

## Future Enhancements

These are explicitly out of scope for this feature but documented for future planning:

### 1. Shared Team Email Migration
**When**: After shared email (dev@generacy.ai or extensions@generacy.ai) is provisioned
**Effort**: ~30 minutes
**Steps**:
- Create new Microsoft account with shared email
- Add as admin to Azure DevOps org
- Add as co-owner to publisher account
- Transfer primary ownership
- Update documentation

### 2. Publisher Profile Branding
**When**: After logo and branding finalized
**Effort**: ~15 minutes
**Items**:
- Upload logo/icon to publisher profile
- Add website URL
- Expand description with tagline
- Add social media links (if applicable)

### 3. Automated PAT Rotation/Alerting
**When**: After several extensions published and process is stable
**Effort**: 1-2 days
**Approach**:
- GitHub Action to check PAT expiration via Azure DevOps API
- Slack notification when <30 days remaining
- Consider automated rotation (requires secure key storage solution)

### 4. CI/CD Integration
**When**: Issues 1.6 and 1.7 implementation
**Effort**: Part of those issues
**Validation**:
- Publish workflows use `VSCE_PAT` secret successfully
- Automated publishes succeed end-to-end
- Version tagging and marketplace updates work correctly

### 5. Marketplace Analytics Review
**When**: After 6 months of extensions being published
**Effort**: ~1 hour
**Items**:
- Review download metrics
- Analyze user feedback and ratings
- Identify improvement opportunities
- Plan future extension development based on usage

---

## Implementation Checklist

Use this checklist during implementation to track progress:

### Pre-Implementation
- [ ] Read complete implementation plan
- [ ] Verify chris@generacy.ai Microsoft account exists and is accessible
- [ ] Verify GitHub organization admin access for secret creation
- [ ] Verify mikezouhri contact info for adding as co-admin

### Phase 1: Azure DevOps Organization
- [ ] Sign in to dev.azure.com with chris@generacy.ai
- [ ] Create organization `generacy-ai`
- [ ] Add mikezouhri as organization administrator
- [ ] Verify both admins can access org
- [ ] Record organization URL

### Phase 2: Publisher Registration
- [ ] Sign in to marketplace.visualstudio.com/manage
- [ ] Create publisher with ID `generacy-ai` (or alternate)
- [ ] Set display name "Generacy"
- [ ] Set description "AI-powered development workflow tooling"
- [ ] Link to Azure DevOps org `generacy-ai`
- [ ] Complete email verification
- [ ] Verify publisher profile accessible
- [ ] Record actual publisher ID if different from generacy-ai

### Phase 3: PAT Generation
- [ ] Navigate to Azure DevOps user settings → Personal access tokens
- [ ] Generate new token with name `VSCE_PAT_Marketplace_Publishing`
- [ ] Set expiration to 1 year
- [ ] Set scope to Marketplace: Manage only
- [ ] Limit to generacy-ai organization
- [ ] Copy token value immediately
- [ ] Record exact expiration date
- [ ] Verify token appears in Azure DevOps token list

### Phase 4: GitHub Secret
- [ ] Navigate to GitHub org settings → Secrets → Actions
- [ ] Create new organization secret named `VSCE_PAT`
- [ ] Paste PAT value
- [ ] Set repository access to "All repositories"
- [ ] Save secret
- [ ] Verify secret appears in org secrets list
- [ ] Delete temporary copy of PAT

### Phase 5: Documentation
- [ ] Create `/docs/publishing/` directory in generacy repo
- [ ] Create `vscode-marketplace-setup.md`
- [ ] Complete all documentation sections
- [ ] Verify all links work
- [ ] Commit and push documentation
- [ ] Update generacy repo README if applicable

### Phase 6: Verification
- [ ] Install vsce: `npm install -g @vscode/vsce`
- [ ] Test login: `vsce login generacy-ai`
- [ ] Verify publishers: `vsce ls-publishers`
- [ ] (Optional) Dry-run publish test
- [ ] Calculate PAT expiration date
- [ ] Create GitHub issue for PAT rotation
- [ ] Set issue due date (2 weeks before PAT expires)
- [ ] Assign christrudelpw and mikezouhri
- [ ] Add rotation checklist to issue
- [ ] Update documentation with rotation process

### Post-Implementation
- [ ] Review all success criteria met
- [ ] Notify stakeholders of completion
- [ ] Update issues 1.6 and 1.7 that publisher is ready
- [ ] Archive any temporary notes or credentials

---

## Timeline Estimate

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| Phase 1: Azure DevOps Organization | 10 min | Microsoft account |
| Phase 2: Publisher Registration | 15 min | Phase 1 |
| Phase 3: PAT Generation | 5 min | Phases 1-2 |
| Phase 4: GitHub Secret | 5 min | Phase 3 |
| Phase 5: Documentation | 20 min | Phases 1-4 |
| Phase 6: Verification & Rotation Setup | 15 min | Phases 1-5 |
| **Total** | **~70 minutes** | |

**Notes**:
- Timeline assumes no issues with account access or name availability
- Does not include wait time for email verifications
- Can be completed in single session or broken into multiple sessions
- Most time-consuming phase is documentation (Phase 5)

---

## Dependencies & Blockers

### No Blockers
This is a Phase 1 Foundation task with no dependencies on other issues.

### Enables
- **Issue 1.6**: Agency extension CI/CD (needs `VSCE_PAT` for automated publishing)
- **Issue 1.7**: Generacy extension CI/CD (needs `VSCE_PAT` for automated publishing)

### External Dependencies
- Microsoft account access (chris@generacy.ai)
- GitHub organization admin permissions
- Internet connectivity for Azure DevOps and VS Code Marketplace

---

## Rollback Plan

If issues are discovered after setup:

### Rollback: PAT Compromised
1. Revoke compromised PAT in Azure DevOps
2. Generate new PAT (repeat Phase 3)
3. Update GitHub secret (repeat Phase 4)
4. Test authentication (repeat Phase 6A)

### Rollback: Wrong Publisher Name Registered
1. Cannot delete publisher once created
2. **Mitigation**: Create new publisher with correct name
3. Update documentation with new publisher ID
4. Update issues 1.6 and 1.7 with new publisher ID
5. Original publisher can be left inactive (no harm)

### Rollback: GitHub Secret Misconfigured
1. Delete incorrect secret
2. Re-add secret with correct configuration
3. Test authentication
4. Verify repository access

### Rollback: Azure DevOps Org Misconfigured
1. Cannot easily delete Azure DevOps org
2. **Mitigation**: Create new organization with alternate name (e.g., generacy-ai-publishing)
3. Update publisher link to new organization
4. Regenerate PAT in new organization
5. Update GitHub secret

---

## Maintenance & Operational Notes

### Annual PAT Rotation (See Phase 6B Checklist)
Approximately 1 year from initial setup, rotate the PAT:
1. Generate new PAT with same scopes and new 1-year expiration
2. Update GitHub organization secret `VSCE_PAT`
3. Test authentication
4. Revoke old PAT
5. Create new rotation tracking issue
6. Update documentation with new expiration date

### Adding New Admins
If additional team members need publisher access:
1. Add to Azure DevOps organization as administrator
2. In VS Code Marketplace, add as co-owner in publisher settings
3. Update documentation with new admin list

### Updating Publisher Profile
To add branding or change information:
1. Sign in to marketplace.visualstudio.com/manage
2. Select generacy-ai publisher
3. Update display name, description, logo, website as needed
4. Save changes
5. Update documentation if significant changes

### Monitoring Marketplace Activity
Periodic review (quarterly or after each extension publish):
1. Check publisher dashboard for download metrics
2. Review extension ratings and feedback
3. Audit recent version publishes (ensure all expected)
4. Check for security advisories or marketplace policy changes

---

## References

### Documentation Links
- VS Code Publishing Extensions: https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- VS Code Marketplace Manage: https://marketplace.visualstudio.com/manage
- Azure DevOps PATs: https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate
- vsce CLI: https://github.com/microsoft/vsce

### Internal References
- Onboarding Buildout Plan: [tetrad-development/docs/onboarding-buildout-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md)
- Issue 1.6: Agency extension CI/CD (dependency)
- Issue 1.7: Generacy extension CI/CD (dependency)

### Repository Links
- generacy repo: https://github.com/generacy-ai/generacy
- GitHub org settings: https://github.com/organizations/generacy-ai/settings
- GitHub org secrets: https://github.com/organizations/generacy-ai/settings/secrets/actions

---

**Plan Status**: Ready for Implementation
**Estimated Effort**: ~1 hour (manual setup and configuration)
**Complexity**: Low (infrastructure setup, no coding required)
**Risk Level**: Low (well-documented processes, multiple fallback options)

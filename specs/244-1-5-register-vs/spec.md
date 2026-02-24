# Feature Specification: Register VS Code Marketplace Publisher

**Branch**: `244-1-5-register-vs` | **Date**: 2026-02-24 | **Status**: Draft

## Summary

This feature establishes the foundational infrastructure for publishing VS Code extensions under the Generacy brand. It involves registering a publisher account on the Visual Studio Code Marketplace, configuring authentication credentials, and documenting the setup process for future extension publishing workflows.

This is a one-time setup that enables all subsequent VS Code extension publishing activities for the Generacy organization.

## User Stories

### US1: Publisher Account Registration

**As a** DevOps engineer,
**I want** to register a `generacy-ai` publisher on the VS Code Marketplace,
**So that** we can publish VS Code extensions under our organization's brand.

**Acceptance Criteria**:
- [ ] Publisher account `generacy-ai` is successfully registered on VS Code Marketplace
- [ ] Publisher profile includes appropriate branding (name, description, logo if applicable)
- [ ] Publisher account is verified and active
- [ ] Access credentials are stored securely

### US2: Authentication Setup

**As a** CI/CD pipeline,
**I want** to authenticate with the VS Code Marketplace using a Personal Access Token (PAT),
**So that** I can programmatically publish extensions without manual intervention.

**Acceptance Criteria**:
- [ ] Personal Access Token (PAT) is generated with appropriate scopes for publishing
- [ ] PAT is stored as GitHub organization secret named `VSCE_PAT`
- [ ] PAT has sufficient permissions to publish under `generacy-ai` publisher
- [ ] Token expiration is documented and tracked

### US3: Publishing Workflow Validation

**As a** developer,
**I want** to verify that `vsce` can authenticate and publish using the configured credentials,
**So that** I know the publishing pipeline will work when needed.

**Acceptance Criteria**:
- [ ] `vsce` CLI tool can authenticate using the PAT
- [ ] Test publish operation succeeds (or dry-run verification passes)
- [ ] Publishing workflow is documented with step-by-step instructions
- [ ] Troubleshooting guide is available for common issues

### US4: Documentation and Knowledge Transfer

**As a** future team member,
**I want** comprehensive documentation of the publisher setup,
**So that** I can understand, maintain, or recreate the configuration if needed.

**Acceptance Criteria**:
- [ ] Publisher registration process is documented
- [ ] PAT generation and renewal process is documented
- [ ] GitHub secrets configuration is documented
- [ ] Security best practices are documented
- [ ] Contact information and recovery procedures are documented

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Register `generacy-ai` publisher on VS Code Marketplace | P0 | Core requirement for all extension publishing |
| FR-002 | Configure publisher profile with organization details | P1 | Branding and discoverability |
| FR-003 | Generate Azure DevOps PAT with Marketplace publishing scope | P0 | Required for `vsce` authentication |
| FR-004 | Store PAT as GitHub organization secret `VSCE_PAT` | P0 | Enables CI/CD publishing workflows |
| FR-005 | Document PAT expiration date and renewal process | P1 | Prevents authentication failures |
| FR-006 | Verify `vsce login` works with the PAT | P0 | Validates authentication setup |
| FR-007 | Create publisher setup documentation | P1 | Knowledge preservation |
| FR-008 | Document security considerations and access controls | P2 | Security best practices |
| FR-009 | Test publish workflow with sample extension (if applicable) | P2 | End-to-end validation |
| FR-010 | Document rollback/recovery procedures | P2 | Operational resilience |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Publisher registration completion | 100% | Publisher account is active and verified on VS Code Marketplace |
| SC-002 | Authentication success rate | 100% | `vsce login` succeeds using stored PAT |
| SC-003 | Documentation completeness | 100% | All required documentation sections are complete |
| SC-004 | Secure credential storage | 100% | PAT is stored only in GitHub secrets, not in code or plain text |
| SC-005 | Time to first publish | < 5 minutes | Developer can publish an extension following documentation |

## Technical Details

### Publisher Registration Process
1. Visit [Visual Studio Marketplace Publisher Management](https://marketplace.visualstudio.com/manage)
2. Create new publisher with ID: `generacy-ai`
3. Configure publisher profile (display name, description, website)
4. Verify email and complete registration

### PAT Generation Requirements
- **Platform**: Azure DevOps
- **Organization**: Link to appropriate Azure DevOps organization
- **Scope**: `Marketplace (Manage)` or `All accessible organizations` with Marketplace permissions
- **Expiration**: Maximum allowed or as per security policy
- **Name**: `VSCE_Publishing_Token` or similar descriptive name

### GitHub Secret Configuration
- **Location**: Organization-level secrets or repository-level secrets
- **Name**: `VSCE_PAT`
- **Access**: Available to relevant repositories/workflows
- **Rotation**: Plan for rotation before expiration

### Documentation Requirements
- **Location**: `/docs/publishing/vscode-marketplace-setup.md` or similar
- **Contents**:
  - Publisher account details
  - PAT generation steps
  - GitHub secrets configuration
  - Publishing workflow examples
  - Troubleshooting guide
  - Security considerations
  - Contact/owner information

## Assumptions

- The organization has or can create an Azure DevOps account (required for PAT generation)
- The team has appropriate permissions to create GitHub organization secrets
- The publisher name `generacy-ai` is available on VS Code Marketplace
- VS Code Marketplace Terms of Service are acceptable to the organization
- PAT will be rotated before expiration according to security policies

## Dependencies

**Upstream**: None — this can start immediately

**Downstream**:
- All VS Code extension publishing features depend on this setup
- CI/CD workflows for extension releases require the `VSCE_PAT` secret

## Out of Scope

- Publishing actual VS Code extensions (this is setup only)
- Creating extension packaging workflows or CI/CD pipelines
- Developing VS Code extension code or functionality
- Marketplace analytics or monitoring setup
- Multi-publisher management or secondary publishers
- Extension update or versioning strategies
- Extension testing or validation frameworks
- Marketplace listing optimization or SEO
- User support or feedback management for published extensions
- Automated PAT rotation systems (manual renewal is acceptable for initial setup)

## Security Considerations

- **PAT Storage**: Never commit PAT to version control
- **Access Control**: Limit GitHub secret access to authorized workflows only
- **Expiration Tracking**: Set calendar reminders for PAT renewal
- **Audit Trail**: Document who has access to publisher account
- **Recovery Plan**: Document account recovery procedures for publisher access

## Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Publisher name unavailable | High | Low | Have backup names ready (`generacy`, `generacyai`) |
| PAT expiration without notice | High | Medium | Document expiration date prominently; set reminders |
| Azure DevOps account issues | High | Low | Verify account access before starting; document requirements |
| GitHub secrets misconfiguration | Medium | Low | Test secret availability in workflow before first use |
| Loss of publisher access | High | Low | Document multiple contact emails; set up organization-level access |

## Execution Plan

**Phase:** 1 — Foundation (no blockers)
**Blocked by:** None — can start immediately

### Steps
1. Register publisher account on VS Code Marketplace
2. Generate Azure DevOps PAT with appropriate scopes
3. Store PAT as GitHub organization secret
4. Test authentication with `vsce login`
5. Document complete setup process
6. Verify publishing capability (dry-run if possible)

---

*Generated by speckit*

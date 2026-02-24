# Clarification Questions

## Status: Pending

## Questions

### Q1: Publisher Profile Branding Details
**Context**: The spec mentions "appropriate branding (name, description, logo if applicable)" but doesn't specify the exact content. This information is needed to complete the publisher registration and ensure consistent brand representation.

**Question**: What specific branding information should be used for the publisher profile?

**Requested Information**:
- Display name (e.g., "Generacy AI", "Generacy", "generacy-ai")
- Publisher description (1-2 sentences about the organization)
- Logo/icon (file path or URL if available, or should we skip for initial setup?)
- Website URL (if applicable)

**Answer**:

---

### Q2: Azure DevOps Organization
**Context**: PAT generation requires an Azure DevOps organization to be linked. The spec assumes this exists but doesn't specify which organization to use or whether one needs to be created.

**Question**: Which Azure DevOps organization should be used for PAT generation?

**Options**:
- A) Use existing organization: [please specify organization name/URL]
- B) Create new organization: [please specify desired name, e.g., "generacy" or "generacy-ai"]
- C) Use personal account: (not recommended for organizational use, but viable for initial setup)

**Answer**:

---

### Q3: GitHub Secret Scope
**Context**: The spec mentions "Organization-level secrets or repository-level secrets" but doesn't specify which approach to use. This affects access control and where publishing workflows can run.

**Question**: Where should the `VSCE_PAT` secret be stored?

**Options**:
- A) Organization-level secret: Available to all repositories in the organization (provides flexibility for future extensions across repos)
- B) Repository-level secret: Available only to specific repository/repositories (more restrictive, better security if only one repo needs it)
- C) Environment-specific secret: Scoped to specific environments like "production" (adds deployment controls)

**If repository-level**, which repository/repositories should have access?

**Answer**:

---

### Q4: PAT Expiration Duration
**Context**: The spec says "Maximum allowed or as per security policy" but doesn't specify the actual duration. Azure DevOps allows various expiration periods, and this decision affects maintenance overhead.

**Question**: What expiration duration should be set for the PAT?

**Options**:
- A) 90 days: More secure, requires quarterly rotation
- B) 1 year: Balance of security and convenience, annual rotation
- C) Maximum (currently 1 year for Azure DevOps): Minimize rotation overhead
- D) Custom duration: [please specify]

**Answer**:

---

### Q5: Documentation Location
**Context**: The spec suggests `/docs/publishing/vscode-marketplace-setup.md` but doesn't confirm this is the desired location within the repository structure.

**Question**: Where should the publisher setup documentation be stored?

**Options**:
- A) `/docs/publishing/vscode-marketplace-setup.md`: As suggested in spec
- B) `/docs/vscode-marketplace-setup.md`: Flatter structure
- C) Repository README or Wiki: More discoverable for team members
- D) Other location: [please specify]

**Answer**:

---

### Q6: Test Publish Verification Method
**Context**: FR-009 mentions "Test publish workflow with sample extension (if applicable)" as P2 priority, and US3 mentions "Test publish operation succeeds (or dry-run verification passes)". The approach affects whether we need to create a test extension.

**Question**: How should publishing capability be verified?

**Options**:
- A) Create and publish test extension: Full end-to-end validation but creates a public extension on marketplace (can be unpublished later)
- B) Dry-run with `vsce publish --dry-run`: Validates authentication and packaging without actual publishing
- C) Authentication-only test: Just verify `vsce login` succeeds, skip publish test for now
- D) Skip verification: Trust that authentication setup is sufficient (not recommended)

**Answer**:

---

### Q7: Multiple Account Owners
**Context**: The security considerations mention "Document who has access to publisher account" but don't specify whether multiple people should have access or if there should be a single owner.

**Question**: Who should have access to the publisher account and Azure DevOps organization?

**Requested Information**:
- Primary owner email/contact
- Additional admin emails (if any)
- Should multiple team members have direct publisher access, or only through CI/CD?

**Answer**:

---

### Q8: PAT Rotation Reminder System
**Context**: The spec mentions "Set calendar reminders for PAT renewal" but doesn't specify who is responsible or what system to use for tracking.

**Question**: How should PAT expiration be tracked and who is responsible for renewal?

**Options**:
- A) Calendar reminders: Set personal/shared calendar events for specific individual(s) [please specify who]
- B) Project management tool: Create ticket/task in tracking system with due date
- C) Documentation-only: Document expiration date in setup docs, no active reminder
- D) Monitoring/alerting: Set up automated check that alerts when PAT is approaching expiration (out of scope for this feature, but plan for future)

**Responsible party**: [please specify role/person]

**Answer**:

---

### Q9: Backup Publisher Names
**Context**: The risks section mentions backup names (`generacy`, `generacyai`) in case `generacy-ai` is unavailable. These should be verified or prioritized before registration.

**Question**: What is the priority order for publisher names if the preferred name is unavailable?

**Requested Priority Order**:
1. `generacy-ai` (preferred)
2. [second choice]
3. [third choice]

Should we verify name availability before proceeding with registration?

**Answer**:

---

### Q10: Account Email and Organization Linking
**Context**: Publisher accounts require an email address for verification and are linked to a Microsoft/Azure account. This isn't specified in the requirements.

**Question**: What email address and Microsoft account should be used for publisher registration?

**Requested Information**:
- Email address for publisher account: [e.g., team email, specific individual]
- Should this be linked to an organizational Microsoft account or personal account?
- Is this the same account that owns the Azure DevOps organization?

**Answer**:


# T002: Token Generation Workflow

## Visual Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│                        T002 WORKFLOW                             │
└─────────────────────────────────────────────────────────────────┘

┌─────────────┐
│   START     │
│   (T001 ✓)  │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────┐
│  STEP 1: Navigate to npmjs.com      │
│  ────────────────────────────       │
│  • Log in with org admin account    │
│  • Go to Access Tokens page         │
│  • Click "Generate New Token"       │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  STEP 2: Configure Token            │
│  ────────────────────────           │
│  • Type: "Automation" ✅            │
│  • Permissions: "Read and Publish"  │
│  • Description: (optional)          │
│  • Click "Generate Token"           │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  STEP 3: Save Token                 │
│  ────────────────────────           │
│  ⚠️  ONLY SHOWN ONCE!               │
│  • Copy token immediately           │
│  • Paste into password manager      │
│  • Label appropriately              │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  STEP 4: Document                   │
│  ────────────────────────           │
│  • Copy template → details.md       │
│  • Fill in creation date            │
│  • Fill in username                 │
│  • Fill in token ID (from npm)      │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  STEP 5: Verify (Optional)          │
│  ────────────────────────           │
│  • Run: npm whoami --authToken=...  │
│  • Verify authentication works      │
│  • Test publish access (dry-run)    │
└──────────────┬──────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│   COMPLETE ✅                        │
│   ──────────────                     │
│   ✓ Token in password manager        │
│   ✓ Metadata documented              │
│   ✓ Ready for T003                   │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│   T003: Configure GitHub Secret      │
│   (Next Task)                        │
└──────────────────────────────────────┘
```

---

## Data Flow

```
┌─────────────────┐
│  npmjs.com      │
│  (Web UI)       │
└────────┬────────┘
         │
         │ (User generates token)
         │
         ▼
┌─────────────────────────────────────┐
│  npm Automation Token               │
│  ─────────────────────              │
│  Format: npm_xxxxx...xxxxx          │
│  Type: Automation                   │
│  Scope: @generacy-ai org            │
│  Permissions: Read + Publish        │
│  Expiry: Never (manual rotation)    │
└─────────┬──────────┬────────────────┘
          │          │
          │          │ (metadata only)
          │          ▼
          │    ┌──────────────────────────┐
          │    │  T002-npm-token-details  │
          │    │  .md (documentation)     │
          │    │  ─────────────────────   │
          │    │  • Creation date         │
          │    │  • Creator username      │
          │    │  • Token ID              │
          │    │  • Permissions           │
          │    │  • Rotation schedule     │
          │    └──────────────────────────┘
          │
          │ (actual token value)
          │
          ▼
┌─────────────────────────────────────┐
│  Password Manager                   │
│  (Secure Storage)                   │
│  ─────────────────────              │
│  • 1Password / Bitwarden /          │
│    LastPass / etc.                  │
│  • Encrypted                        │
│  • Backed up                        │
│  • Searchable                       │
└─────────┬───────────────────────────┘
          │
          │ (copied when needed)
          │
          ▼
┌─────────────────────────────────────┐
│  GitHub Organization Secret         │
│  (Added in T003)                    │
│  ─────────────────────              │
│  Name: NPM_TOKEN                    │
│  Scope: Public repositories         │
│  Used by: GitHub Actions workflows  │
└─────────┬───────────────────────────┘
          │
          │ (used by workflows)
          │
          ▼
┌─────────────────────────────────────┐
│  GitHub Actions Workflows           │
│  ─────────────────────              │
│  • publish-preview.yml              │
│  • release.yml                      │
│  ─────────────────────              │
│  Publishes to npm registry          │
└─────────────────────────────────────┘
```

---

## Security Model

```
┌─────────────────────────────────────────────────────────────┐
│                      SECURITY BOUNDARIES                     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────┐
│  npm Account        │
│  ───────────        │
│  • Owner/Admin      │
│  • 2FA enabled      │
│  • Trusted account  │
└──────────┬──────────┘
           │
           │ [Generates]
           │
           ▼
┌─────────────────────────────────────┐
│  Automation Token                   │
│  ─────────────────                  │
│  Capabilities:                      │
│  ✓ Read packages                    │
│  ✓ Publish packages                 │
│  ✓ Update package metadata          │
│  ✗ Delete packages (requires auth)  │
│  ✗ Transfer ownership               │
│  ✗ Manage team members              │
└─────────┬───────────────────────────┘
          │
          │ [Stored in trusted locations only]
          │
          ├──────────────┬──────────────┐
          │              │              │
          ▼              ▼              ▼
┌──────────────┐  ┌────────────┐  ┌────────────┐
│  Password    │  │  GitHub    │  │  NOT in:   │
│  Manager     │  │  Secrets   │  │  ────────  │
│  ──────────  │  │  ────────  │  │  ✗ Git     │
│  ✓ Encrypted │  │  ✓ Encrypt │  │  ✗ Chat    │
│  ✓ Backed up │  │  ✓ Audited │  │  ✗ Email   │
│  ✓ Access    │  │  ✓ Scoped  │  │  ✗ Files   │
│    control   │  │    to repo │  │  ✗ Logs    │
└──────────────┘  └────────────┘  └────────────┘
```

---

## Token Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│                      TOKEN LIFECYCLE                         │
└─────────────────────────────────────────────────────────────┘

[Creation] ──────────────────────────────────────────┐
   │                                                  │
   │ T002: Generate token                             │
   ▼                                                  │
[Active Usage] ──────────────────────────────────────┤
   │                                                  │
   │ • Used in GitHub Actions                         │ 1 year
   │ • Publishes packages automatically               │
   │ • Audited via npm logs                           │
   │                                                  │
   ▼                                                  │
[Rotation Scheduled] ────────────────────────────────┤
   │                                                  │
   │ Annual rotation (2027-02-24)                     │
   │ Or on security incident                          │
   ▼                                                  │
[Generate New Token] ────────────────────────────────┘
   │
   │ 1. Create new automation token
   │ 2. Update GitHub secret
   │ 3. Verify workflows pass
   │ 4. Revoke old token
   │ 5. Update documentation
   │
   ▼
[Old Token Revoked]
   │
   │ Token no longer valid
   │ Can't be used for authentication
   │
   └─> [End of Lifecycle]
```

---

## Failure Recovery

```
┌─────────────────────────────────────────────────────────────┐
│                    FAILURE SCENARIOS                         │
└─────────────────────────────────────────────────────────────┘

Scenario 1: Lost Token Before Saving
────────────────────────────────────
Problem: Closed browser before copying token
Solution:
  1. Go back to npm tokens page
  2. Delete the unusable token
  3. Generate new token
  4. Save immediately this time

Scenario 2: Token Compromised
──────────────────────────────
Problem: Token exposed in logs/chat/git
Solution:
  1. Immediately revoke token on npmjs.com
  2. Generate new token (T002)
  3. Update GitHub secret (T003)
  4. Audit recent package publishes
  5. Document incident

Scenario 3: Wrong Token Type
─────────────────────────────
Problem: Generated "Publish" instead of "Automation"
Solution:
  1. Delete incorrect token
  2. Generate new "Automation" token
  3. Update stored token
  4. Update GitHub secret if already added

Scenario 4: Insufficient Permissions
─────────────────────────────────────
Problem: Token has "Read Only" permissions
Solution:
  1. Cannot modify existing token
  2. Delete read-only token
  3. Generate new token with "Read and Publish"
  4. Update all references

Scenario 5: Organization Access Denied
───────────────────────────────────────
Problem: Can't generate token (not admin)
Solution:
  1. Verify T001 completion
  2. Contact org owner for permission
  3. Or use org-level admin account
  4. Retry token generation
```

---

## Time Breakdown

```
┌─────────────────────────────────────────────────────────────┐
│                      TIME ESTIMATE                           │
└─────────────────────────────────────────────────────────────┘

Total Time: 10-15 minutes
─────────────────────────

Activity                          Time        Notes
─────────────────────────────────────────────────────────
Login to npmjs.com                1 min       If already have credentials
Navigate to tokens page           1 min       Few clicks
Configure token                   2 min       Select options, add description
Copy and save token              2 min       Critical: don't rush this step
Fill out documentation           3-5 min     Template makes this quick
Optional verification            2-3 min     Recommended but not required
─────────────────────────────────────────────────────────
TOTAL (without verification)     9-11 min
TOTAL (with verification)        11-14 min

Potential Delays:
───────────────
• Need to find npm credentials:        +5 min
• 2FA verification:                     +2 min
• Organization permission issues:       +10-30 min (requires admin)
• Token generation failures:            +5 min (retry)
```

---

## Validation Checklist

```
┌─────────────────────────────────────────────────────────────┐
│                    VALIDATION POINTS                         │
└─────────────────────────────────────────────────────────────┘

Before Starting:
───────────────
□ T001 verification complete
□ Have npm admin credentials
□ Password manager accessible
□ 15 minutes of uninterrupted time

During Execution:
─────────────────
□ Logged in to correct npm account
□ Navigated to Access Tokens page
□ Selected "Automation" token type (not Publish/Classic)
□ Selected "Read and Publish" permissions
□ Token generated successfully
□ Token copied to clipboard
□ Token pasted into password manager
□ Token verified in password manager (can retrieve it)

After Completion:
─────────────────
□ Token in password manager with descriptive label
□ T002-npm-token-details.md created
□ Template filled with correct information
□ Token ID documented
□ Creation date recorded
□ No token value in git-tracked files
□ Token ready for T003
□ Task marked complete in tasks.md

Security Validation:
───────────────────
□ Token NOT in browser history/clipboard long-term
□ Token NOT in any git commits
□ Token NOT shared via insecure channels
□ Token stored only in password manager
□ Token type verified as "Automation"
□ Permissions verified as "Read and Publish"
```

---

## References

- **npm Docs**: https://docs.npmjs.com/creating-and-viewing-access-tokens
- **npm Automation Tokens**: https://docs.npmjs.com/about-access-tokens#automation-tokens
- **GitHub Actions with npm**: https://docs.github.com/en/actions/publishing-packages/publishing-nodejs-packages

---

**Status**: Ready for Execution
**Next**: Open `T002-EXECUTE-NOW.md` to begin

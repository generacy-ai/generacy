# T015 Quick Guide: Calculate PAT Expiration Date

**Task**: Calculate PAT expiration and rotation reminder dates
**Type**: Manual calculation task
**Estimated Time**: 5 minutes

## Purpose

This task calculates the precise expiration date and rotation reminder date for the Personal Access Token (PAT) created in T005. These dates are needed for T016 to create a tracking issue that will remind us to rotate the PAT before it expires.

## Input Data

From T005 documentation (`/workspaces/generacy/docs/publishing/vscode-marketplace-setup.md`):
- **PAT Creation Date**: 2026-02-24
- **PAT Lifetime**: 1 year (365 days)
- **Reminder Lead Time**: 2 weeks (14 days before expiration)

## Calculation Steps

### Step 1: Calculate Expiration Date

**Formula**: Creation Date + 365 days

```
2026-02-24 (creation date)
+ 365 days (1 year)
= 2027-02-24 (expiration date)
```

**Result**: PAT expires on **2027-02-24**

### Step 2: Calculate Rotation Reminder Date

**Formula**: Expiration Date - 14 days

```
2027-02-24 (expiration date)
- 14 days (2 weeks)
= 2027-02-10 (rotation reminder date)
```

**Result**: Rotation should be initiated by **2027-02-10**

### Step 3: Format Verification

All dates are in ISO 8601 format (YYYY-MM-DD):
- ✅ Creation: `2026-02-24`
- ✅ Expiration: `2027-02-24`
- ✅ Rotation reminder: `2027-02-10`

## Date Calculation Reference

For manual date calculations:

### Using JavaScript/Node.js
```javascript
const creationDate = new Date('2026-02-24');

// Add 365 days for expiration
const expirationDate = new Date(creationDate);
expirationDate.setDate(expirationDate.getDate() + 365);
console.log(expirationDate.toISOString().split('T')[0]); // 2027-02-24

// Subtract 14 days for rotation reminder
const rotationDate = new Date(expirationDate);
rotationDate.setDate(rotationDate.getDate() - 14);
console.log(rotationDate.toISOString().split('T')[0]); // 2027-02-10
```

### Using Command Line (date utility)
```bash
# Calculate expiration date (creation + 365 days)
date -d "2026-02-24 +365 days" +%Y-%m-%d
# Output: 2027-02-24

# Calculate rotation reminder (expiration - 14 days)
date -d "2027-02-24 -14 days" +%Y-%m-%d
# Output: 2027-02-10
```

### Using Python
```python
from datetime import datetime, timedelta

creation_date = datetime(2026, 2, 24)
expiration_date = creation_date + timedelta(days=365)
rotation_date = expiration_date - timedelta(days=14)

print(f"Expiration: {expiration_date.strftime('%Y-%m-%d')}")  # 2027-02-24
print(f"Rotation: {rotation_date.strftime('%Y-%m-%d')}")      # 2027-02-10
```

## Output Summary

These calculated dates will be used in T016 to create the GitHub issue:

| Purpose | Date | Format |
|---------|------|--------|
| PAT Creation | 2026-02-24 | YYYY-MM-DD |
| PAT Expiration | 2027-02-24 | YYYY-MM-DD |
| Rotation Reminder | 2027-02-10 | YYYY-MM-DD |
| Days Until Expiration | 365 | From creation |
| Reminder Lead Time | 14 | Days before expiration |

## Usage for T016

When creating the PAT rotation tracking issue:

**Issue Title**:
```
Rotate VSCE_PAT — expires 2027-02-24
```

**Issue Due Date**:
```
2027-02-10
```

**Issue Description** should include:
```markdown
The VSCE_PAT Personal Access Token expires on **2027-02-24**.

This issue serves as a reminder to rotate the token before expiration.
```

## Verification

The calculated dates have been verified against the existing documentation:
- ✅ Matches dates in `/workspaces/generacy/docs/publishing/vscode-marketplace-setup.md`
- ✅ Expiration is exactly 365 days after creation
- ✅ Rotation reminder is exactly 14 days before expiration
- ✅ All dates use consistent YYYY-MM-DD format

## Why These Dates Matter

1. **Expiration Date (2027-02-24)**: After this date, the PAT will no longer work, breaking CI/CD publishing workflows for VS Code extensions.

2. **Rotation Reminder (2027-02-10)**: This date gives us 2 weeks to:
   - Generate a new PAT
   - Update GitHub secrets
   - Test authentication
   - Revoke the old PAT
   - Update documentation

3. **Buffer Time**: 14 days provides adequate time for:
   - Coordination between administrators
   - Testing the new PAT
   - Handling any unexpected issues
   - Accounting for vacations/holidays

## Next Steps

After completing this task:

1. ✅ Record calculated dates in T015-progress.md
2. → Proceed to **T016**: Create PAT rotation tracking issue with:
   - Title: "Rotate VSCE_PAT — expires 2027-02-24"
   - Due date: 2027-02-10
   - Assignees: @christrudelpw, @mikezouhri
   - Labels: maintenance, infrastructure

## Common Issues

### Issue: "Dates don't account for leap years"
**Resolution**: Our calculation (2026-02-24 + 365 days = 2027-02-24) is correct. No leap year occurs between February 2026 and February 2027.

### Issue: "Should we use 360 days instead of 365?"
**Resolution**: Azure DevOps PAT expiration uses calendar days, not business days. Always use 365 days for 1-year tokens.

### Issue: "What if expiration date falls on a weekend?"
**Resolution**: GitHub issues can have weekend due dates. Administrators should check for rotation reminders on Monday if the due date falls on a weekend.

---

**Created**: 2026-02-24
**Last Updated**: 2026-02-24
**Task Type**: Manual calculation (no code implementation)

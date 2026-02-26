# T015 Progress: Calculate PAT Expiration Date

**Task**: Calculate PAT expiration and rotation reminder dates
**Status**: In Progress
**Started**: 2026-02-24

## Objective

Calculate the PAT expiration date and rotation reminder date from the creation date documented in T005.

## Data Retrieved from T005

From `/workspaces/generacy/docs/publishing/vscode-marketplace-setup.md`:

- **PAT Created**: 2026-02-24
- **PAT Lifetime**: 1 year (365 days)
- **Rotation Reminder**: 2 weeks before expiration (14 days)

## Calculations

### Expiration Date Calculation

```
Creation Date: 2026-02-24
+ 365 days
= 2027-02-24
```

**PAT Expiration Date**: `2027-02-24`

### Rotation Reminder Date Calculation

```
Expiration Date: 2027-02-24
- 14 days
= 2027-02-10
```

**Rotation Reminder Date**: `2027-02-10`

## Date Validation

- ✅ Creation date: 2026-02-24 (verified from documentation)
- ✅ Expiration date: 2027-02-24 (exactly 1 year later)
- ✅ Rotation reminder: 2027-02-10 (14 days before expiration)
- ✅ All dates in YYYY-MM-DD format

## Verification Against Documentation

The calculated dates match the dates already documented in:
- `/workspaces/generacy/docs/publishing/vscode-marketplace-setup.md` (lines 79-80)
  - "**Expires**: 2027-02-24 (1 year from creation)"
  - "**Rotation Due**: 2027-02-10 (2 weeks before expiration)"

## Output for T016

The following dates should be used when creating the PAT rotation tracking issue in T016:

- **Issue Title**: "Rotate VSCE_PAT — expires 2027-02-24"
- **Due Date**: 2027-02-10 (rotation reminder date)
- **Expiration Date**: 2027-02-24 (to be mentioned in issue description)

## Task Status

- [x] Retrieved PAT creation date from T005
- [x] Calculated expiration date (creation + 365 days)
- [x] Calculated rotation reminder date (expiration - 14 days)
- [x] Formatted dates as YYYY-MM-DD
- [x] Verified dates against existing documentation
- [x] Documented results for T016

**Status**: Complete

---

**Last Updated**: 2026-02-24
**Next Task**: T016 (Create PAT Rotation Tracking Issue)

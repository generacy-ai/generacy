# T016 Quick Guide: Create PAT Rotation Tracking Issue

## Task Summary

Create GitHub issue to track annual rotation of the VSCE_PAT Personal Access Token.

## Prerequisites

- PAT expiration date from T015
- Access to create GitHub issues in generacy-ai/generacy repo

## Quick Steps

### 1. Create the Issue (via gh CLI)

```bash
gh issue create \
  --repo generacy-ai/generacy \
  --title "Rotate VSCE_PAT — expires 2027-02-24" \
  --assignee christrudelpw \
  --label "maintenance,infrastructure" \
  --body "[content with PAT rotation checklist]"
```

### 2. Manual Web Actions Required

Due to gh CLI limitations, complete these in the web interface:

1. Navigate to the created issue
2. Set **Due date**: 2027-02-10 (2 weeks before expiration)
3. Add **@mikezouhri** as additional assignee (if needed)

## Issue Content Template

The issue should include:

- PAT expiration date and rotation due date
- Links to setup documentation
- Links to Azure DevOps PAT management
- Links to GitHub organization secrets
- Complete 12-step rotation checklist
- Test commands for verification
- Important notes about rotation process

## Success Criteria

- ✅ Issue created and visible
- ✅ Title includes expiration date: "Rotate VSCE_PAT — expires YYYY-MM-DD"
- ✅ Assigned to @christrudelpw and @mikezouhri
- ✅ Labels applied: maintenance, infrastructure
- ✅ Due date set to 2 weeks before expiration
- ✅ Complete rotation checklist included
- ✅ All links working

## Expected Outcome

GitHub issue serves as:
- Reminder system for PAT rotation
- Complete instructions for rotation process
- Documentation of rotation dates and timeline

## Common Issues

**Label doesn't exist**: Create labels first:
```bash
gh label create maintenance --description "Maintenance tasks" --color "0e8a16" --repo generacy-ai/generacy
gh label create infrastructure --description "Infrastructure setup" --color "0052cc" --repo generacy-ai/generacy
```

**Username not found**: Verify GitHub username is correct, or skip and add manually in web UI.

**Can't set due date**: Due dates must be set through the GitHub web interface.

## Time Estimate

- CLI creation: 2 minutes
- Web interface setup: 2 minutes
- Total: ~5 minutes

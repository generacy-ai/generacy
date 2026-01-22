# Quickstart: Workflow Publishing

## Prerequisites

Before using workflow publishing, ensure:

1. ✅ **Generacy extension installed** (v1.0.0+)
2. ✅ **Authenticated with generacy.ai** account
3. ✅ **Organization membership** (Cloud Mode required)
4. ✅ **Workflow files** exist in `.generacy/` directory

## Installation

This feature is included in the Generacy VS Code Extension starting from v1.0.0. No additional installation required.

### Verify Installation

1. Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Type "Generacy: Publish Workflow"
3. If the command appears, publishing is available

### Enable Cloud Mode

Publishing requires Cloud Mode (paid organization):

1. Run command: **"Generacy: Sign In"**
2. Follow GitHub OAuth flow
3. Ensure you're a member of a paid organization
4. Cloud features will unlock automatically

## Quick Start Guide

### 1. Publish Your First Workflow

**Step-by-step**:

1. Open a workflow file from `.generacy/` directory (e.g., `ci-workflow.yaml`)
2. Make your changes and save the file
3. Open Command Palette (`Cmd+Shift+P`)
4. Run: **"Generacy: Publish Workflow"**
5. Enter changelog (optional but recommended):
   ```
   Initial CI workflow with build and test phases
   ```
6. Confirm in the dialog: **"Publish Now"**

**Result**: Your workflow is now published to the cloud and will be version 1.

### 2. Update an Existing Workflow

**Step-by-step**:

1. Open published workflow file
2. Make changes and save
3. Notice the **↑** (yellow arrow) indicator in the file explorer
4. Run: **"Generacy: Publish Workflow"**
5. Review diff showing changes (optional)
6. Enter changelog describing changes:
   ```
   Added deployment phase for staging environment
   ```
7. Confirm publish

**Result**: Workflow is now version 2, changes are deployed.

### 3. View Version History

**Step-by-step**:

1. Open any workflow file
2. Run: **"Generacy: View Version History"**
3. Browse versions in the quick pick list
4. Select a version to see details

**Quick Pick Options**:
- 👁️ **View**: Open version content in read-only editor
- 📊 **Compare**: Show diff between selected version and local
- ⏮️ **Rollback**: Restore workflow to this version

### 4. Compare Local vs Cloud

**Step-by-step**:

1. Open a workflow file
2. Run: **"Generacy: Compare with Cloud"**
3. Diff editor opens showing:
   - **Left**: Cloud version (current published)
   - **Right**: Local version (your changes)

**Use Cases**:
- See what changes you're about to publish
- Verify your local copy matches cloud
- Understand what changed since last sync

### 5. Rollback to Previous Version

**Step-by-step**:

1. Run: **"Generacy: View Version History"**
2. Select the version to rollback to
3. Click the ⏮️ **Rollback** button
4. Confirm the rollback action
5. Choose whether to update local file

**Important**: Rollback creates a **new version** with the old content. Original versions are preserved.

**Example Timeline**:
```
v1: Initial workflow
v2: Added feature X
v3: Added feature Y (has bug)
v4: Rollback to v2 (restored v2 content)
v5: Fix and republish
```

## Understanding Sync Status

Sync status indicators appear in the file explorer next to `.generacy/*.yaml` files:

| Icon | Status | Meaning | Action |
|------|--------|---------|--------|
| ✓ (green) | **Synced** | Local matches cloud | No action needed |
| ↑ (yellow) | **Ahead** | Local has unpublished changes | Run publish to sync |
| ↓ (blue) | **Behind** | Cloud has newer version | Review cloud changes |
| ⚠ (red) | **Conflict** | Both local and cloud changed | Manual merge required |
| ⊘ (gray) | **Not Published** | Workflow never published | Run publish to upload |
| ? (gray) | **Unknown** | Unable to determine status | Check network/auth |

### Refresh Sync Status

Run: **"Generacy: Refresh Sync Status"** to manually update all indicators.

## Available Commands

| Command | Description | Keyboard Shortcut |
|---------|-------------|-------------------|
| **Generacy: Publish Workflow** | Publish current workflow to cloud | - |
| **Generacy: View Version History** | Browse version history | - |
| **Generacy: Compare with Cloud** | Diff local vs cloud version | - |
| **Generacy: Rollback Workflow** | Restore previous version | - |
| **Generacy: Refresh Sync Status** | Update sync indicators | - |

### Setting Custom Shortcuts

1. Open: **Preferences → Keyboard Shortcuts**
2. Search for command (e.g., "Generacy: Publish Workflow")
3. Click pencil icon and press your desired shortcut
4. Recommended shortcuts:
   - Publish: `Cmd+K Cmd+P` (Mac) / `Ctrl+K Ctrl+P` (Windows/Linux)
   - Version History: `Cmd+K Cmd+H` (Mac) / `Ctrl+K Ctrl+H` (Windows/Linux)

## Configuration

### Extension Settings

Configure in: **Preferences → Settings → Extensions → Generacy**

```json
{
  // Require confirmation before publishing
  "generacy.publish.confirmBeforePublish": true,

  // Require changelog when publishing updates
  "generacy.publish.requireChangelog": false,

  // Enable automatic sync on file save
  "generacy.publish.autoSync": false,

  // Sync status cache duration (milliseconds)
  "generacy.publish.syncStatusCacheTTL": 300000
}
```

### Recommended Settings

For beginners:
```json
{
  "generacy.publish.confirmBeforePublish": true,
  "generacy.publish.requireChangelog": false
}
```

For teams:
```json
{
  "generacy.publish.confirmBeforePublish": true,
  "generacy.publish.requireChangelog": true
}
```

For power users:
```json
{
  "generacy.publish.confirmBeforePublish": false,
  "generacy.publish.requireChangelog": true,
  "generacy.publish.autoSync": true
}
```

## Workflow Best Practices

### 1. Write Meaningful Changelogs

**Good**:
```
Added deployment phase for staging environment
- Includes health checks
- Automated rollback on failure
```

**Bad**:
```
Updated workflow
```

### 2. Publish Frequently

- Publish after completing a logical unit of work
- Don't accumulate many changes before publishing
- Makes history more understandable
- Easier to rollback if needed

### 3. Use Version Tags

For major releases, add semantic version tags:
```
v1.0.0 - Initial production release
v1.1.0 - Added deployment automation
v2.0.0 - Refactored to multi-phase workflow
```

### 4. Review Changes Before Publishing

Always use **"Review Changes"** before confirming publish to:
- Verify no unintended changes
- Catch mistakes before they go live
- Understand scope of update

### 5. Test Locally Before Publishing

1. Run workflow locally with dry-run mode
2. Verify all phases execute correctly
3. Check output and logs
4. Then publish to cloud

## Troubleshooting

### Error: "Authentication required"

**Symptoms**: Publish command shows "Authentication required or token expired"

**Solutions**:
1. Run: **"Generacy: Sign In"**
2. Complete GitHub OAuth flow
3. Verify you see your organization in dashboard
4. Try publish again

**If still failing**:
- Check internet connection
- Verify organization membership at generacy.ai
- Try: **"Generacy: Sign Out"** then sign in again

### Error: "You don't have permission to publish"

**Symptoms**: 403 Forbidden error when publishing

**Solutions**:
1. Verify you're a member of a **paid organization**
2. Check your role in the organization (must be Member or higher)
3. Contact organization admin to verify permissions

**Free accounts cannot publish to cloud** - upgrade to Cloud Mode.

### Error: "Cloud version has changed"

**Symptoms**: 409 Conflict error when publishing

**Cause**: Someone else published a new version while you were editing locally.

**Solution**:
1. Run: **"Generacy: Compare with Cloud"** to see differences
2. Manually merge changes if needed:
   - Copy cloud changes you want to keep
   - Integrate with your local changes
3. Publish again

**Alternative**: Rollback your changes and start fresh from cloud version.

### Sync Status Shows "Unknown"

**Symptoms**: Gray "?" icon in file explorer

**Causes**:
- No internet connection
- API service temporarily unavailable
- Authentication expired

**Solutions**:
1. Check internet connection
2. Run: **"Generacy: Refresh Sync Status"**
3. If persistent, check extension logs:
   - Open: **View → Output**
   - Select: **Generacy** from dropdown
   - Look for error messages

### Diff View Not Opening

**Symptoms**: Compare command runs but no diff appears

**Solutions**:
1. Ensure workflow exists in cloud (check status indicator)
2. Verify file is saved locally
3. Try closing and reopening the file
4. Restart VS Code if issue persists

### Version History Empty

**Symptoms**: Version history command shows no versions

**Causes**:
- Workflow never published
- Wrong workflow selected
- API connection issue

**Solutions**:
1. Check sync status (should show ⊘ if not published)
2. Publish workflow first
3. Try version history again

### Publish Hangs or Times Out

**Symptoms**: Progress bar stuck at "Uploading..."

**Causes**:
- Large workflow file (>1MB)
- Slow internet connection
- API timeout

**Solutions**:
1. Check workflow file size (should be < 5MB)
2. Verify internet connection speed
3. If file is large, consider splitting into multiple workflows
4. Wait for timeout (30 seconds) and retry

### Rollback Creates Unexpected Version

**Symptoms**: After rollback, version number is higher than expected

**Explanation**: This is **expected behavior**. Rollback creates a new version to preserve history.

**Example**:
- Current version: 5
- Rollback to: version 3
- New version after rollback: 6 (with content from version 3)

**Benefit**: You can always "undo" a rollback by rolling forward to version 5.

## Getting Help

### Extension Logs

1. Open: **View → Output**
2. Select: **Generacy** from dropdown
3. Look for recent error messages
4. Share logs when reporting issues

### Report an Issue

1. Open: **Help → Report Issue**
2. Select: **Generacy Extension**
3. Include:
   - Steps to reproduce
   - Extension version
   - Relevant logs from Output panel
   - Screenshot if UI-related

### Community Support

- GitHub Discussions: https://github.com/generacy-ai/generacy/discussions
- Documentation: https://docs.generacy.ai
- Email Support: support@generacy.ai (Cloud Mode subscribers)

## Next Steps

After mastering workflow publishing, explore:

1. **Workflow Queue** - Monitor cloud workflow execution
2. **Integration Management** - Connect GitHub, Jira, etc.
3. **Organization Dashboard** - View team usage and metrics
4. **Workflow Debugger** - Step through workflow execution locally

---

*Generated by speckit*

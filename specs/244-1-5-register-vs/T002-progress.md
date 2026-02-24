# T002: Add Co-Administrator to Azure DevOps - Progress Report

**Status**: Ready for Manual Completion
**Date**: 2026-02-24
**Prerequisite**: T001 (Create Azure DevOps Organization) must be complete

## Task Overview

Add @mikezouhri as an organization administrator to the Azure DevOps organization `generacy-ai` to establish dual-admin access for redundancy and collaboration.

## Prerequisites Checklist

- [x] T001 Complete: Azure DevOps organization `generacy-ai` created
- [x] Organization URL: https://dev.azure.com/generacy-ai
- [x] Primary admin (@christrudelpw) has access
- [ ] Have @mikezouhri's Microsoft account email address ready

## Step-by-Step Instructions

### Step 1: Sign In to Azure DevOps

1. Navigate to: https://dev.azure.com/generacy-ai
2. Sign in with `chris@generacy.ai` (primary admin account)
3. Confirm you land on the organization homepage

### Step 2: Navigate to Organization Settings

1. Click the **gear icon** (⚙️) in the bottom-left corner of the page
2. Select **"Organization settings"** from the menu
3. You should see a settings page with a left sidebar

### Step 3: Access Users Management

1. In the left sidebar, look for **"Users"** under the "General" section
2. Click **"Users"**
3. You should see a list of current organization members (likely just yourself initially)

### Step 4: Add New User

1. Click the **"+ Add users"** button (top-right area of the Users page)
2. A modal/panel should appear titled "Add new users" or similar

### Step 5: Configure User Details

Fill in the add user form:

1. **Users or Service Principals**:
   - Enter: `@mikezouhri's Microsoft account email`
   - If you know the exact email, use it (e.g., `mike@example.com`)
   - If using GitHub handle, Azure will try to find associated Microsoft account

2. **Access level**:
   - Select: **"Basic"** (or highest level available)
   - This provides full access to Azure DevOps features

3. **Add to projects** (optional):
   - Can skip for now (no projects exist yet)
   - Or select "None" if prompted

4. **Azure DevOps Groups**:
   - Select: **"Project Collection Administrators"** (this is the organization admin group)
   - This is the KEY step that grants admin permissions
   - Alternative name might be: "Organization Administrators" or similar

### Step 6: Send Invitation

1. Review the details you entered
2. Optionally add a custom message in the invitation email
3. Click **"Add"** or **"Send invite"** button
4. Confirm the invitation appears in the users list with "Pending" status

### Step 7: Coordinate with @mikezouhri

1. Notify @mikezouhri that an invitation was sent
2. They should receive an email invitation at the Microsoft account address
3. They need to:
   - Open the invitation email
   - Click the "Accept invitation" link
   - Sign in with their Microsoft account
   - Complete any onboarding flow

### Step 8: Verify Admin Access

After @mikezouhri accepts the invitation:

1. **Verify User Added**:
   - Refresh the Users page in Azure DevOps
   - Confirm @mikezouhri appears with "Active" status
   - Confirm access level shows "Basic" or equivalent

2. **Verify Admin Permissions**:
   - Click on @mikezouhri's name in the users list
   - Check "Group memberships" or "Permissions"
   - Confirm they are in "Project Collection Administrators" group

3. **Test @mikezouhri's Access**:
   - Ask @mikezouhri to navigate to: https://dev.azure.com/generacy-ai
   - They should be able to access the organization
   - Ask them to go to Organization Settings
   - They should see the Users page and other admin settings

4. **Verify Both Admins Can Manage Settings**:
   - Both @christrudelpw and @mikezouhri should be able to:
     - Access Organization Settings
     - View/edit Users
     - Access Billing (if configured)
     - Manage Security settings

## Success Criteria Checklist

- [ ] @mikezouhri invitation sent successfully
- [ ] @mikezouhri accepted invitation
- [ ] @mikezouhri appears in Users list with "Active" status
- [ ] @mikezouhri is member of "Project Collection Administrators" group
- [ ] @mikezouhri can access https://dev.azure.com/generacy-ai
- [ ] @mikezouhri can view Organization Settings
- [ ] @mikezouhri can view/edit Users page
- [ ] Both admins confirmed to have equal permissions

## Troubleshooting

### Issue: Cannot find "Add users" button
- **Solution**: Ensure you're in Organization Settings → Users (not Project settings)
- **Solution**: Verify you have admin permissions yourself

### Issue: @mikezouhri's email not found
- **Solution**: Ensure using correct Microsoft account email
- **Solution**: Ask @mikezouhri for their Microsoft account email
- **Solution**: They may need to create a Microsoft account first

### Issue: Cannot select admin group
- **Solution**: Look for "Project Collection Administrators" in the groups dropdown
- **Solution**: May need to add user first, then assign admin role separately
- **Solution**: Navigate to Settings → Permissions → Add member to admin group

### Issue: Invitation not received
- **Solution**: Check spam/junk folder
- **Solution**: Verify email address is correct
- **Solution**: Resend invitation from Azure DevOps
- **Solution**: Use "Copy invitation link" option and send manually

### Issue: @mikezouhri accepted but no admin access
- **Solution**: Go to Organization Settings → Permissions
- **Solution**: Find "Project Collection Administrators" group
- **Solution**: Click "Members" and add @mikezouhri manually
- **Solution**: Refresh permissions and re-test access

## Alternative Approaches

### Approach 1: Direct Permission Assignment
If the "Add users" flow doesn't show group selection:
1. Add @mikezouhri as basic user first
2. Go to Organization Settings → Permissions
3. Find "Project Collection Administrators" group
4. Add @mikezouhri to this group manually

### Approach 2: Using Azure CLI (Advanced)
If web interface issues persist:
```bash
# Install Azure DevOps CLI extension
az extension add --name azure-devops

# Login
az login

# Add user to organization
az devops user add \
  --email-id <mikezouhri-email> \
  --license-type express \
  --org https://dev.azure.com/generacy-ai

# Add to admin group
az devops security group membership add \
  --group-id <admin-group-id> \
  --member-id <user-id> \
  --org https://dev.azure.com/generacy-ai
```

## Security Reminders

- ⚠️ Only add trusted administrators with proper authorization
- ⚠️ Ensure both admins enable MFA on their Microsoft accounts
- ⚠️ Verify @mikezouhri's email address is correct before sending invitation
- ⚠️ Keep organization settings secure—limit admin access to essential personnel
- ⚠️ Regularly review organization member list for security

## Next Steps After Completion

Once T002 is complete:
1. Update tasks.md: Mark T002 as [DONE]
2. Proceed to Phase 2: T003 (Register Publisher Account)
3. Record both admin emails in documentation for reference
4. Consider documenting process for adding future admins

## Related Tasks

- **Previous**: T001 - Create Azure DevOps Organization (prerequisite)
- **Next**: T003 - Register Publisher Account
- **Dependencies**: T003 and all subsequent tasks require T002 completion

## References

- Task Definition: /workspaces/generacy/specs/244-1-5-register-vs/tasks.md (lines 22-27)
- Azure DevOps Documentation: https://learn.microsoft.com/azure/devops/organizations/accounts/add-organization-users
- Organization URL: https://dev.azure.com/generacy-ai
- Organization Settings: https://dev.azure.com/generacy-ai/_settings/

## Notes

- This is a manual web interface task—no code implementation required
- Dual admin setup provides redundancy for account recovery
- Both admins will have equal permissions to manage organization
- @mikezouhri's exact Microsoft account email may need confirmation
- This setup is critical for PAT generation in Phase 3 (both admins can generate PATs)

---

**Status Legend**:
- ⏳ Pending: Task not started
- 🔄 In Progress: Currently working on task
- ✅ Complete: Task finished and verified
- ⚠️ Blocked: Waiting for external dependency

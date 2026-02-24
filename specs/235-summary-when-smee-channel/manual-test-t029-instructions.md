# Manual Test T029: Create New Webhooks

**Feature**: Webhook Auto-Configuration
**Test**: Verify orchestrator creates missing webhooks on startup
**Status**: Ready for execution

## Current State

All monitored repositories already have webhooks configured:
- generacy-ai/tetrad-development ✓
- generacy-ai/agency ✓
- generacy-ai/latency ✓
- generacy-ai/generacy ✓
- generacy-ai/humancy ✓
- generacy-ai/generacy-cloud ✓
- generacy-ai/humancy-cloud ✓

## Test Procedure

### Step 1: Delete a webhook to simulate missing configuration

Choose one repository to test with (recommended: `generacy-ai/humancy`, webhook ID: 591786455):

```bash
# Delete the webhook
gh api DELETE /repos/generacy-ai/humancy/hooks/591786455

# Verify deletion
gh api /repos/generacy-ai/humancy/hooks
```

Expected: Empty array `[]` or no webhook with the Smee URL

### Step 2: Set environment variables

```bash
# Already set in the environment:
export SMEE_CHANNEL_URL=https://smee.io/mNhnxyK56d9qkZo
export MONITORED_REPOS=generacy-ai/tetrad-development,generacy-ai/agency,generacy-ai/latency,generacy-ai/generacy,generacy-ai/humancy,generacy-ai/generacy-cloud,generacy-ai/humancy-cloud
```

### Step 3: Build the project

```bash
cd /workspaces/generacy
pnpm install
pnpm build
```

### Step 4: Start the orchestrator with label monitor

```bash
cd /workspaces/generacy
pnpm exec generacy orchestrator --label-monitor
```

### Step 5: Verify the logs

Look for these log entries in order:

1. **Webhook configuration start**:
   ```
   Configuring GitHub webhooks...
   ```

2. **Webhook creation log**:
   ```
   Created new webhook for repository
   ```
   With fields: `owner: "generacy-ai"`, `repo: "humancy"`, `webhookId: <number>`, `action: "created"`

3. **Summary log**:
   ```
   Webhook auto-configuration complete
   ```
   With fields: `total: 7`, `created: 1`, `skipped: 6`, `reactivated: 0`, `failed: 0`

4. **Orchestrator continues startup**:
   ```
   Orchestrator server ready and listening
   ```

### Step 6: Verify webhook in GitHub

```bash
# Check webhook was created
gh api /repos/generacy-ai/humancy/hooks

# Verify webhook properties:
# - config.url === "https://smee.io/mNhnxyK56d9qkZo"
# - active === true
# - events includes "issues"
```

Expected output should show a webhook with:
- URL pointing to the Smee channel
- Active status: true
- Events array includes "issues"

### Step 7: Verify orchestrator continues running

After webhook setup completes:
- Orchestrator should remain running
- Label monitor should start
- No errors or crashes

## Success Criteria

- ✅ Log shows "Webhook auto-configuration complete" with `created: 1`
- ✅ GitHub repo settings shows webhook exists
- ✅ Webhook points to Smee URL (https://smee.io/mNhnxyK56d9qkZo)
- ✅ Webhook events include "issues"
- ✅ Webhook is active
- ✅ Orchestrator continues startup successfully
- ✅ No errors or crashes during webhook setup

## Alternative: Test T030 Instead (Skip Existing Webhooks)

If you prefer not to delete a webhook, you can run the orchestrator as-is and verify:

```bash
cd /workspaces/generacy
pnpm exec generacy orchestrator --label-monitor
```

Expected log:
```
Webhook auto-configuration complete
{ total: 7, created: 0, skipped: 7, reactivated: 0, failed: 0 }
```

This verifies that the orchestrator correctly identifies existing webhooks and skips them (idempotent behavior).

## Cleanup

After testing, the webhook will remain configured (which is the desired state). No cleanup needed unless you want to remove it.

## Notes

- The test requires `admin:repo_hook` permission on the GitHub token
- Current token appears to have necessary permissions (webhooks exist)
- Test can be repeated multiple times safely (idempotent)
- Webhook setup is non-blocking - errors are logged but don't prevent startup

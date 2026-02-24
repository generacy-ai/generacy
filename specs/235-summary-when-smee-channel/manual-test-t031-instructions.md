# Manual Test T031: Reactivate Inactive Webhooks

**Test Goal**: Verify that the orchestrator can detect and reactivate inactive webhooks in GitHub repositories.

**Prerequisites**:
- Completed T029 (webhook created successfully)
- Completed T030 (verified idempotent behavior)
- GitHub repository with webhook already configured
- Valid GitHub token with `admin:repo_hook` scope
- `SMEE_CHANNEL_URL` environment variable set
- `MONITORED_REPOS` environment variable set

---

## Test Steps

### 1. Prepare Test Environment

Ensure you have a webhook already configured from T029/T030:

```bash
# Navigate to feature directory
cd /workspaces/generacy/specs/235-summary-when-smee-channel

# Verify environment variables are set
echo "SMEE_CHANNEL_URL: $SMEE_CHANNEL_URL"
echo "MONITORED_REPOS: $MONITORED_REPOS"
```

Expected: Both variables should be set and pointing to the test repository.

---

### 2. Manually Disable Webhook in GitHub

1. Open your browser and navigate to the repository settings:
   - Go to `https://github.com/{OWNER}/{REPO}/settings/hooks`
   - Replace `{OWNER}` and `{REPO}` with your test repository values

2. Find the webhook pointing to your Smee channel URL

3. Click "Edit" on the webhook

4. **Uncheck the "Active" checkbox** (disable the webhook)

5. Click "Update webhook" to save

6. Verify the webhook shows as inactive (you should see a gray/disabled indicator)

**Alternative using `gh` CLI**:
```bash
# List webhooks and find the ID
gh api /repos/{OWNER}/{REPO}/hooks | jq '.[] | {id, active, url: .config.url}'

# Disable the webhook (replace WEBHOOK_ID with actual ID)
gh api -X PATCH /repos/{OWNER}/{REPO}/hooks/{WEBHOOK_ID} -F active=false

# Verify it's disabled
gh api /repos/{OWNER}/{REPO}/hooks/{WEBHOOK_ID} | jq '{id, active, events}'
```

---

### 3. Restart the Orchestrator CLI

```bash
# Stop any running orchestrator (Ctrl+C if running)

# Start the orchestrator with label monitor enabled
pnpm exec generacy orchestrator --label-monitor
```

---

### 4. Verify Log Output

**Expected log messages** (in order):

1. **Webhook configuration start**:
   ```
   Configuring GitHub webhooks...
   ```

2. **Reactivation log entry** (at `info` level):
   ```json
   {
     "owner": "...",
     "repo": "...",
     "webhookId": 123456,
     "action": "reactivated",
     "events": ["issues"]
   }
   "Reactivated inactive webhook"
   ```

3. **Summary log** showing `reactivated: 1`:
   ```json
   {
     "total": 1,
     "created": 0,
     "skipped": 0,
     "reactivated": 1,
     "failed": 0
   }
   "Webhook auto-configuration complete"
   ```

4. **Orchestrator continues startup**:
   ```
   Orchestrator server ready and listening
   ```

---

### 5. Verify Webhook in GitHub Settings

**Using GitHub Web UI**:
1. Go back to `https://github.com/{OWNER}/{REPO}/settings/hooks`
2. Find the webhook pointing to your Smee URL
3. Verify:
   - ✅ Webhook is **active** (enabled)
   - ✅ Events include **"issues"**
   - ✅ URL matches your `SMEE_CHANNEL_URL`

**Using `gh` CLI**:
```bash
gh api /repos/{OWNER}/{REPO}/hooks | jq '.[] | select(.config.url == "YOUR_SMEE_URL") | {id, active, events}'
```

Expected output:
```json
{
  "id": 123456,
  "active": true,
  "events": ["issues"]
}
```

---

### 6. Test Event Merging (Optional Deep Dive)

To verify that the webhook reactivation merges events correctly:

**Setup**: Manually create a webhook with different events:
```bash
# Disable the current webhook
gh api -X PATCH /repos/{OWNER}/{REPO}/hooks/{WEBHOOK_ID} -F active=false

# Add another event (e.g., "push")
gh api -X PATCH /repos/{OWNER}/{REPO}/hooks/{WEBHOOK_ID} -F events[]=push
```

**Restart orchestrator** and verify:
- Webhook is reactivated
- Events are merged: `["push", "issues"]` (not replaced)

---

## Success Criteria

- [ ] Webhook was successfully disabled in GitHub settings
- [ ] Orchestrator startup logs show `"Configuring GitHub webhooks..."`
- [ ] Log entry shows `action: "reactivated"` with correct webhook ID
- [ ] Summary shows `reactivated: 1, created: 0, skipped: 0, failed: 0`
- [ ] GitHub webhook settings show webhook is **active** again
- [ ] Webhook events include **"issues"**
- [ ] Orchestrator continues startup without errors
- [ ] No errors or warnings about webhook configuration

---

## Expected Results Summary

| Metric | Expected Value |
|--------|----------------|
| Webhook status before restart | Inactive (disabled) |
| Webhook status after restart | Active (enabled) |
| Log action | `"reactivated"` |
| Reactivated count | 1 |
| Created count | 0 |
| Skipped count | 0 |
| Failed count | 0 |
| Webhook events | `["issues"]` (or merged if others exist) |
| Orchestrator startup | Success |

---

## Troubleshooting

### Webhook not reactivated

**Symptoms**: Log shows `action: "skipped"` or `action: "failed"`

**Possible causes**:
1. Webhook URL mismatch (case-sensitive after normalization)
2. Insufficient permissions (need `admin:repo_hook` scope)
3. Network/API error

**Debug steps**:
```bash
# Check current webhooks
gh api /repos/{OWNER}/{REPO}/hooks | jq

# Verify GitHub token has correct scope
gh auth status

# Check orchestrator logs for detailed error messages
```

### "Insufficient permissions" error

**Symptoms**: Log shows `failed: 1` with permission warning

**Solution**: Ensure your GitHub token has `admin:repo_hook` scope:
```bash
# Check current scopes
gh auth status

# If missing scope, re-authenticate
gh auth refresh -s admin:repo_hook
```

### Webhook reactivated but events not merged

**Symptoms**: Webhook is active but missing "issues" event

**Expected behavior**: The service should merge events, preserving existing ones and adding "issues"

**Debug**: Check the log message for the `events` field - it should show merged array

---

## Cleanup

After successful testing:

```bash
# Optionally, you can leave the webhook active for T036 (end-to-end test)
# No cleanup needed unless you want to start fresh
```

---

## Next Steps

Once T031 passes:
- [ ] Proceed to **T032**: Test insufficient permissions scenario
- [ ] Proceed to **T033**: Test non-Smee URL warning
- [ ] Proceed to **T034**: Test event mismatch warning

---

**Test Date**: _________________
**Tested By**: _________________
**Result**: ☐ Pass  ☐ Fail
**Notes**: _________________________________________________________________

# T031 Quick Start: Reactivate Inactive Webhooks

**Quick test execution guide for T031**

## Prerequisites

1. Environment variables set:
   ```bash
   export SMEE_CHANNEL_URL=https://smee.io/YOUR_CHANNEL
   export MONITORED_REPOS=owner/repo
   ```

2. Webhook already exists (from T029/T030)

3. GitHub token with `admin:repo_hook` scope

## Quick Test (Automated Script)

```bash
cd /workspaces/generacy/specs/235-summary-when-smee-channel
./run-test-t031.sh
```

The script will:
1. Find your webhook
2. Disable it
3. Restart the orchestrator
4. Display expected log patterns

## What to Look For

### ✅ Success Indicators

**In logs**:
```
Configuring GitHub webhooks...
{ "action": "reactivated", "webhookId": 123456, ... }
{ "reactivated": 1, "created": 0, "skipped": 0, "failed": 0 }
Webhook auto-configuration complete
```

**In GitHub** (check: `https://github.com/OWNER/REPO/settings/hooks`):
- Webhook is **active** (enabled)
- Events include **"issues"**

### ❌ Failure Indicators

**Wrong action**:
```json
{ "action": "skipped" }  // ❌ Should be "reactivated"
{ "action": "failed" }   // ❌ Check permissions
```

**Wrong counts**:
```json
{ "reactivated": 0, "skipped": 1 }  // ❌ Webhook wasn't disabled
{ "failed": 1 }                      // ❌ Permission or API error
```

## Manual Verification

### Disable webhook manually:

```bash
# Get webhook ID
gh api /repos/OWNER/REPO/hooks | jq '.[] | {id, active, url: .config.url}'

# Disable it
gh api -X PATCH /repos/OWNER/REPO/hooks/WEBHOOK_ID -F active=false

# Verify disabled
gh api /repos/OWNER/REPO/hooks/WEBHOOK_ID | jq '{id, active}'
```

### Check webhook after restart:

```bash
gh api /repos/OWNER/REPO/hooks/WEBHOOK_ID | jq '{id, active, events}'
```

Expected:
```json
{
  "id": 123456,
  "active": true,
  "events": ["issues"]
}
```

## Recording Results

Fill out: `test-results-t031.md`

## Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| `action: "skipped"` | Webhook still active | Disable it first |
| `action: "failed"` | No permissions | Add `admin:repo_hook` scope |
| No webhook found | Wrong SMEE_URL | Check URL matches exactly |
| Webhook not reactivated | API error | Check logs for details |

## Next Test

After T031 passes → **T032**: Test insufficient permissions scenario

---

**Full Instructions**: See `manual-test-t031-instructions.md`
**Results Template**: See `test-results-t031.md`

# Manual Test T030: Skip Existing Webhooks

**Feature**: Webhook Auto-Configuration
**Test**: Verify orchestrator skips existing webhooks (idempotent behavior)
**Status**: Ready for execution
**Prerequisite**: T029 completed successfully

## Current State

From T029 test results, all monitored repositories now have webhooks configured:
- generacy-ai/tetrad-development (ID: 597652917) ✓
- generacy-ai/agency (ID: 591786445) ✓
- generacy-ai/latency (ID: 594501874) ✓
- generacy-ai/generacy (ID: 591786452) ✓
- generacy-ai/humancy (ID: 597807891) ✓ **(newly created in T029)**
- generacy-ai/generacy-cloud (ID: 592740253) ✓
- generacy-ai/humancy-cloud (ID: 591786459) ✓

All webhooks point to: `https://smee.io/mNhnxyK56d9qkZo`

## Test Objective

Verify that the orchestrator:
1. Detects existing webhooks correctly
2. Skips webhook creation for repositories that already have matching webhooks
3. Does not create duplicate webhooks
4. Logs accurate skip counts
5. Maintains idempotent behavior (safe to run multiple times)

## Test Procedure

### Step 1: Verify current webhook state (Pre-test check)

```bash
# Verify webhook exists for humancy (the one we created in T029)
gh api /repos/generacy-ai/humancy/hooks | jq '.[] | {id, active, url: .config.url, events}'
```

Expected output:
```json
{
  "id": 597807891,
  "active": true,
  "url": "https://smee.io/mNhnxyK56d9qkZo",
  "events": ["issues"]
}
```

### Step 2: Verify environment variables are set

```bash
# These should already be configured from T029
echo "SMEE_CHANNEL_URL: $SMEE_CHANNEL_URL"
echo "MONITORED_REPOS: $MONITORED_REPOS"
```

Expected:
- `SMEE_CHANNEL_URL=https://smee.io/mNhnxyK56d9qkZo`
- `MONITORED_REPOS` includes all 7 repositories

### Step 3: Start the orchestrator (second run)

```bash
cd /workspaces/generacy
pnpm exec generacy orchestrator --label-monitor
```

### Step 4: Verify the logs

Look for these specific log entries:

1. **Webhook configuration start**:
   ```
   [timestamp] INFO: Configuring GitHub webhooks...
   ```

2. **Skip logs for each repository** (7 total):
   ```
   [timestamp] INFO: Webhook already exists and is active
       owner: "generacy-ai"
       repo: "<repo-name>"
       webhookId: <number>
       action: "skipped"
   ```

3. **Summary log** (CRITICAL - this is the main verification):
   ```
   [timestamp] INFO: Webhook auto-configuration complete
       total: 7
       created: 0
       skipped: 7
       reactivated: 0
       failed: 0
   ```

4. **Orchestrator continues startup**:
   ```
   [timestamp] INFO: Orchestrator server ready and listening
       port: 3100
       host: "0.0.0.0"
       labelMonitor: true
   ```

### Step 5: Verify no duplicate webhooks created

```bash
# Check that humancy still has exactly ONE webhook
gh api /repos/generacy-ai/humancy/hooks | jq 'length'
```

Expected output: `1` (not 2 or more)

```bash
# Verify the webhook properties are unchanged
gh api /repos/generacy-ai/humancy/hooks | jq '.[] | {id, active, url: .config.url, events}'
```

Expected output should match the pre-test check:
```json
{
  "id": 597807891,
  "active": true,
  "url": "https://smee.io/mNhnxyK56d9qkZo",
  "events": ["issues"]
}
```

### Step 6: Verify orchestrator continues running normally

After webhook setup completes:
- Orchestrator should remain running
- Label monitor should start
- No errors or crashes
- No warning messages about webhooks

## Success Criteria

| Criterion | How to Verify | Expected Result |
|-----------|---------------|-----------------|
| Log shows `created: 0` | Check summary log | ✅ Zero webhooks created |
| Log shows `skipped: 7` | Check summary log | ✅ All 7 repos skipped |
| Log shows `reactivated: 0` | Check summary log | ✅ No reactivations needed |
| Log shows `failed: 0` | Check summary log | ✅ No failures |
| No duplicate webhooks | `gh api` command returns array with length 1 | ✅ Only original webhook exists |
| Webhook properties unchanged | Compare with T029 webhook ID and config | ✅ Same ID, URL, events, active status |
| Orchestrator starts successfully | Server listening log appears | ✅ No startup errors |
| No error or warning logs | Scan logs for ERROR/WARN levels | ✅ Only INFO level logs |

## Performance Verification

- **Total execution time**: Should be similar to T029 (~3-4 seconds for 7 repositories)
- **Skip operation speed**: Should be faster than creation (~500ms per repo vs ~850ms)
- **Startup non-blocking**: Server should start immediately after webhook setup completes

## Idempotency Test (Optional but Recommended)

To thoroughly verify idempotent behavior, run the orchestrator multiple times:

```bash
# Run 1 (already completed above)
pnpm exec generacy orchestrator --label-monitor
# Ctrl+C to stop

# Run 2 (verify still idempotent)
pnpm exec generacy orchestrator --label-monitor
# Ctrl+C to stop

# Run 3 (verify still idempotent)
pnpm exec generacy orchestrator --label-monitor
```

**Expected result**: All three runs should produce identical logs:
- `created: 0, skipped: 7, reactivated: 0, failed: 0`
- No changes to GitHub webhook configuration

## Comparison with T029

| Metric | T029 (Creation) | T030 (Skip) |
|--------|-----------------|-------------|
| Created | 1 | 0 |
| Skipped | 6 | 7 |
| Reactivated | 0 | 0 |
| Failed | 0 | 0 |
| Total | 7 | 7 |

The key difference: T029 created 1 webhook (humancy), T030 skips all 7 (including humancy).

## Common Issues and Troubleshooting

### Issue: Logs show `created: 1` instead of `skipped: 7`

**Possible causes**:
1. Webhook was deleted between T029 and T030
2. Environment variable changed (different Smee URL)

**Solution**:
- Verify webhook still exists: `gh api /repos/generacy-ai/humancy/hooks`
- Verify `SMEE_CHANNEL_URL` matches webhook URL

### Issue: Logs show `failed: 1` or more

**Possible causes**:
1. GitHub token expired or lacks permissions
2. Network connectivity issues
3. GitHub API rate limit exceeded

**Solution**:
- Check `gh auth status` for token validity
- Check error message in logs for specific cause
- Wait and retry if rate limited

### Issue: Multiple webhooks created

**This is a BUG** - the idempotency logic is not working correctly.

**Investigation**:
- Check webhook matching logic in `webhook-setup-service.ts`
- Verify URL comparison is case-insensitive
- Check if webhook URL format changed

## Expected Test Duration

- Pre-test verification: ~30 seconds
- Orchestrator startup and webhook setup: ~3-4 seconds
- Post-test verification: ~30 seconds
- **Total: ~2-3 minutes**

## Next Steps After T030

- ✅ **T029 Complete**: Webhook creation verified
- ✅ **T030 Complete**: Skip behavior verified *(after this test)*
- 🔄 **T031 Ready**: Test webhook reactivation by disabling an active webhook
- 🔄 **T032 Ready**: Test insufficient permissions handling
- 🔄 **T033 Ready**: Test non-Smee URL warning
- 🔄 **T034 Ready**: Test event mismatch warning

## Notes

- This test is non-destructive and can be safely run multiple times
- No cleanup required - all webhooks remain in desired state
- Safe to run in production environment (no modifications made)
- This test verifies the most common use case: restarting orchestrator with existing webhooks

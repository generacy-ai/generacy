# T030 Quick Start Guide

**Test**: Skip Existing Webhooks (Idempotent Behavior)
**Duration**: ~3 minutes
**Prerequisite**: T029 completed

## Quick Run

```bash
cd /workspaces/generacy/specs/235-summary-when-smee-channel
./run-test-t030.sh
```

Or manually:

```bash
cd /workspaces/generacy
pnpm exec generacy orchestrator --label-monitor
# Watch logs, then Ctrl+C after ~5 seconds
```

## What to Look For

### ✅ SUCCESS Indicators

In the logs, you should see:

1. **Configuration start**: `Configuring GitHub webhooks...`
2. **Skip messages**: `Webhook already exists and is active` (7 times)
3. **Summary**:
   ```
   Webhook auto-configuration complete
   total: 7, created: 0, skipped: 7, reactivated: 0, failed: 0
   ```
4. **Server ready**: `Orchestrator server ready and listening`

### ❌ FAILURE Indicators

Watch out for:

- `created: 1` (means duplicate webhook created!)
- `failed: 1` or more (permission or API issues)
- `reactivated: 1` (webhook was inactive when it should be active)
- ERROR or WARN logs about webhooks
- Orchestrator crash or failure to start

## Post-Test Check

```bash
# Verify no duplicates
gh api /repos/generacy-ai/humancy/hooks | jq 'length'
# Should output: 1
```

## Record Results

After testing, fill in: `test-results-t030.md`

## Next Test

After T030: Run T031 (webhook reactivation)

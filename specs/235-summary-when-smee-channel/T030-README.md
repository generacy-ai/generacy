# T030: Skip Existing Webhooks - Test Documentation

> **Idempotent webhook setup behavior verification**

## Quick Links

- 🚀 **Start Here**: [`T030-QUICK-START.md`](./T030-QUICK-START.md) - One-command test execution
- 📋 **Full Instructions**: [`manual-test-t030-instructions.md`](./manual-test-t030-instructions.md) - Complete test procedure
- 🤖 **Automated Script**: [`run-test-t030.sh`](./run-test-t030.sh) - Executable test runner
- 📊 **Results Template**: [`test-results-t030.md`](./test-results-t030.md) - Record your findings
- 📖 **Implementation Details**: [`T030-IMPLEMENTATION-SUMMARY.md`](./T030-IMPLEMENTATION-SUMMARY.md) - What was built

## What This Tests

**Objective**: Verify that restarting the orchestrator with existing webhooks configured does NOT create duplicate webhooks.

**Expected Behavior**:
- Orchestrator detects all 7 existing webhooks
- Skips webhook creation for all repos
- Summary shows: `created: 0, skipped: 7, reactivated: 0, failed: 0`
- No changes to GitHub webhook configuration

**Why It Matters**: This is the most common use case (restart with existing webhooks) and verifies the system's idempotency.

## Quick Test

```bash
cd /workspaces/generacy/specs/235-summary-when-smee-channel
./run-test-t030.sh
```

Watch for: `created: 0, skipped: 7` in the summary log.

## File Guide

### For Quick Testing
- **`T030-QUICK-START.md`**: TL;DR version, fastest path to running test
- **`run-test-t030.sh`**: Automated test script with verification

### For Thorough Testing
- **`manual-test-t030-instructions.md`**: Step-by-step guide with troubleshooting
- **`test-results-t030.md`**: Template for documenting detailed results

### For Understanding
- **`T030-IMPLEMENTATION-SUMMARY.md`**: Technical deep dive, architecture, rationale
- **`T030-README.md`**: This file - navigation and overview

## Prerequisites

- ✅ T029 completed (webhook created for `generacy-ai/humancy`)
- ✅ Environment variables set:
  - `SMEE_CHANNEL_URL=https://smee.io/mNhnxyK56d9qkZo`
  - `MONITORED_REPOS` includes 7 repos
- ✅ GitHub token with `admin:repo_hook` scope
- ✅ Project built: `pnpm build`

## Test Workflow

```
┌─────────────┐
│ Read Quick  │  ← Start here for fast test
│ Start Guide │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Run Script  │  ← ./run-test-t030.sh
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Observe     │  ← Watch for: skipped: 7
│ Logs        │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Verify No   │  ← gh api check
│ Duplicates  │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Record      │  ← Fill test-results-t030.md
│ Results     │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Mark DONE   │  ← Update tasks.md
└─────────────┘
```

## Success Checklist

After running the test, verify:

- [ ] Log shows "Configuring GitHub webhooks..."
- [ ] Log shows 7 "Webhook already exists and is active" messages
- [ ] Summary shows `created: 0`
- [ ] Summary shows `skipped: 7`
- [ ] Summary shows `reactivated: 0`
- [ ] Summary shows `failed: 0`
- [ ] Webhook count for humancy: still 1 (not 2)
- [ ] Webhook properties unchanged from T029
- [ ] Orchestrator starts successfully
- [ ] No ERROR/WARN logs about webhooks

If all checked: ✅ Test PASSED

## Expected Output

### Console Logs
```log
[INFO] Configuring GitHub webhooks...
[INFO] Webhook already exists and is active (repo: "tetrad-development", id: 597652917)
[INFO] Webhook already exists and is active (repo: "agency", id: 591786445)
[INFO] Webhook already exists and is active (repo: "latency", id: 594501874)
[INFO] Webhook already exists and is active (repo: "generacy", id: 591786452)
[INFO] Webhook already exists and is active (repo: "humancy", id: 597807891)
[INFO] Webhook already exists and is active (repo: "generacy-cloud", id: 592740253)
[INFO] Webhook already exists and is active (repo: "humancy-cloud", id: 591786459)
[INFO] Webhook auto-configuration complete (total: 7, created: 0, skipped: 7)
[INFO] Orchestrator server ready and listening (port: 3100)
```

### GitHub API Check
```bash
$ gh api /repos/generacy-ai/humancy/hooks | jq 'length'
1  # Still just 1 webhook, no duplicates
```

## Troubleshooting

### Test shows `created: 1`
**Problem**: Created a duplicate webhook instead of skipping

**Fix**: Check if webhook URL matches exactly. If mismatch, this is a bug in URL matching logic.

### Test shows `failed: 1`
**Problem**: Permission or API error

**Fix**: Check GitHub token has `admin:repo_hook` scope. Run `gh auth status` to verify.

### Webhook count is 2
**Problem**: Duplicate webhook created (BUG!)

**Fix**: This is a regression. Check webhook-setup-service.ts matching logic. Delete duplicate manually:
```bash
# List webhooks
gh api /repos/generacy-ai/humancy/hooks

# Delete duplicate (keep the one from T029: 597807891)
gh api DELETE /repos/generacy-ai/humancy/hooks/<DUPLICATE_ID>
```

## Performance Expectations

| Metric | Expected Value |
|--------|----------------|
| Total execution time | ~3-4 seconds |
| Time per repo (skip) | ~400-500ms |
| GitHub API calls | 7 (LIST only, no POST) |
| Comparison with T029 | Similar or slightly faster |

## What Comes Next

After T030 passes:

1. **Document results**: Fill in `test-results-t030.md`
2. **Update tasks**: Mark T030 as `[DONE]` in `tasks.md`
3. **Next test**: Proceed to T031 (webhook reactivation)

## Test Series Context

```
Test Suite: Webhook Auto-Configuration
├─ T029 ✅ Create new webhooks (completed)
├─ T030 ⏳ Skip existing webhooks (current)
├─ T031 🔜 Reactivate inactive webhooks
├─ T032 🔜 Handle permission errors
├─ T033 🔜 Warn on non-Smee URLs
└─ T034 🔜 Warn on event mismatch
```

## File Manifest

| File | Purpose | Size | Type |
|------|---------|------|------|
| `T030-QUICK-START.md` | Fast test guide | ~50 lines | Guide |
| `T030-README.md` | Navigation (this file) | ~250 lines | Index |
| `manual-test-t030-instructions.md` | Detailed procedure | ~280 lines | Guide |
| `run-test-t030.sh` | Automated test | ~110 lines | Script |
| `test-results-t030.md` | Results template | ~225 lines | Template |
| `T030-IMPLEMENTATION-SUMMARY.md` | Technical details | ~450 lines | Documentation |

## Related Files

- **Implementation**: `packages/orchestrator/src/services/webhook-setup-service.ts`
- **CLI Integration**: `packages/generacy/src/cli/commands/orchestrator.ts`
- **Unit Tests**: `packages/orchestrator/src/services/__tests__/webhook-setup-service.test.ts`
- **Previous Test**: `test-results-t029.md` (webhook creation)
- **Task Tracking**: `tasks.md` (all test tasks)

## Support

- **Issues**: If test fails unexpectedly, check `T030-IMPLEMENTATION-SUMMARY.md` for troubleshooting
- **Questions**: Reference `manual-test-t030-instructions.md` for detailed explanations
- **Bugs**: Document in `test-results-t030.md` under "Issues Encountered" section

---

**Test Status**: ✅ Ready for execution
**Last Updated**: 2026-02-24
**Estimated Duration**: 4 minutes
**Difficulty**: Easy (automated script available)

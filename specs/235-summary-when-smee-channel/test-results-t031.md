# Test Results: T031 - Reactivate Inactive Webhooks

**Test Date**: _________________
**Tested By**: _________________
**Environment**: Local development

---

## Test Configuration

| Parameter | Value |
|-----------|-------|
| SMEE_CHANNEL_URL | _________________ |
| MONITORED_REPOS | _________________ |
| Repository Owner | _________________ |
| Repository Name | _________________ |
| Webhook ID | _________________ |

---

## Pre-Test State

**Webhook Status Before Test**:
- [ ] Webhook exists in GitHub settings
- [ ] Webhook is disabled/inactive
- [ ] Webhook URL matches SMEE_CHANNEL_URL
- [ ] Current events: _________________

---

## Test Execution

### Step 1: Disable Webhook
**Method Used**: ☐ GitHub UI  ☐ `gh` CLI  ☐ Script

**Result**: ☐ Success  ☐ Failed

**Notes**:
```
_________________________________________________________________
_________________________________________________________________
```

---

### Step 2: Restart Orchestrator
**Command**: `pnpm exec generacy orchestrator --label-monitor`

**Orchestrator Started**: ☐ Yes  ☐ No

**Startup Time**: __________ seconds

---

### Step 3: Verify Logs

**Log: "Configuring GitHub webhooks..."**
- [ ] Found
- **Timestamp**: _________________

**Log: Reactivation Entry**
```json
{
  "owner": "_________________",
  "repo": "_________________",
  "webhookId": _________________,
  "action": "_________________",
  "events": [_________________]
}
```
- [ ] Action is "reactivated"
- [ ] Webhook ID matches
- [ ] Events include "issues"

**Log: Summary**
```json
{
  "total": _____,
  "created": _____,
  "skipped": _____,
  "reactivated": _____,
  "failed": _____
}
```
- [ ] reactivated: 1
- [ ] created: 0
- [ ] skipped: 0
- [ ] failed: 0

**Log: Orchestrator Ready**
- [ ] "Orchestrator server ready and listening"
- [ ] No errors or warnings

---

### Step 4: Verify GitHub Webhook Settings

**Webhook Status After Restart**:
- [ ] Webhook is active/enabled
- [ ] Events include "issues"
- [ ] URL still matches SMEE_CHANNEL_URL
- [ ] No duplicate webhooks created

**Verification Method**: ☐ GitHub UI  ☐ `gh` CLI

**Command Used** (if CLI):
```bash
gh api /repos/{OWNER}/{REPO}/hooks/{WEBHOOK_ID} | jq '{id, active, events}'
```

**Actual Output**:
```json
_________________________________________________________________
_________________________________________________________________
_________________________________________________________________
```

---

## Test Results Summary

### Success Criteria Checklist

- [ ] Webhook successfully disabled before restart
- [ ] Orchestrator logs show webhook configuration start
- [ ] Log shows `action: "reactivated"` with correct webhook ID
- [ ] Summary shows exactly `reactivated: 1`
- [ ] GitHub webhook is active after restart
- [ ] Webhook events include "issues"
- [ ] Orchestrator startup completed without errors
- [ ] No warnings or errors about webhook configuration

### Overall Result

**Test Status**: ☐ **PASS**  ☐ **FAIL**  ☐ **PARTIAL**

**Pass Rate**: _____/8 criteria met

---

## Issues Encountered

**Issue 1**:
```
Description: _________________________________________________________________
Severity: ☐ Critical  ☐ High  ☐ Medium  ☐ Low
Resolution: _________________________________________________________________
```

**Issue 2**:
```
Description: _________________________________________________________________
Severity: ☐ Critical  ☐ High  ☐ Medium  ☐ Low
Resolution: _________________________________________________________________
```

---

## Screenshots/Evidence

**Webhook Before Restart**:
```
Path: _________________________________________________________________
```

**Orchestrator Logs**:
```
Path: _________________________________________________________________
```

**Webhook After Restart**:
```
Path: _________________________________________________________________
```

---

## Event Merge Test (Optional)

**Test Performed**: ☐ Yes  ☐ No  ☐ N/A

**Original Events**: _________________
**After Reactivation**: _________________
**Events Merged Correctly**: ☐ Yes  ☐ No

**Notes**:
```
_________________________________________________________________
_________________________________________________________________
```

---

## Performance Metrics

| Metric | Value |
|--------|-------|
| Time to disable webhook | _____ seconds |
| Orchestrator startup time | _____ seconds |
| Webhook verification time | _____ seconds |
| Total test duration | _____ minutes |

---

## Observations

**Positive Observations**:
```
_________________________________________________________________
_________________________________________________________________
_________________________________________________________________
```

**Areas for Improvement**:
```
_________________________________________________________________
_________________________________________________________________
_________________________________________________________________
```

---

## Comparison with Expected Behavior

| Aspect | Expected | Actual | Match |
|--------|----------|--------|-------|
| Reactivated count | 1 | _____ | ☐ Yes ☐ No |
| Created count | 0 | _____ | ☐ Yes ☐ No |
| Skipped count | 0 | _____ | ☐ Yes ☐ No |
| Failed count | 0 | _____ | ☐ Yes ☐ No |
| Webhook active | true | _____ | ☐ Yes ☐ No |
| Events include "issues" | true | _____ | ☐ Yes ☐ No |

---

## Next Steps

**If PASS**:
- [ ] Mark T031 as complete in tasks.md
- [ ] Proceed to T032 (insufficient permissions test)
- [ ] Document any unexpected behavior for future reference

**If FAIL**:
- [ ] Review orchestrator logs for errors
- [ ] Check GitHub token permissions
- [ ] Verify Smee URL matches webhook URL exactly
- [ ] Re-run test after fixes

---

## Approvals

**Tester Signature**: _________________
**Date**: _________________

**Reviewer** (if applicable): _________________
**Date**: _________________

---

## Additional Notes

```
_________________________________________________________________
_________________________________________________________________
_________________________________________________________________
_________________________________________________________________
_________________________________________________________________
```

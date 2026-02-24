# Quick Start: Implementation Guide

**Feature**: Add agent:in-progress Label on Workflow Resume
**Time**: ~1 hour
**Complexity**: Low

## TL;DR

Add 4 lines to `onResumeStart()` + 2 test assertions = Fixed label state machine

```diff
// packages/orchestrator/src/worker/label-manager.ts:162
if (labelsToRemove.length > 0) {
  await this.github.removeLabels(/* ... */);
}

+ // Add agent:in-progress to reflect active workflow state
+ this.logger.info(
+   { issue: this.issueNumber },
+   'Resume: adding agent:in-progress label',
+ );
+ await this.github.addLabels(this.owner, this.repo, this.issueNumber, ['agent:in-progress']);
```

---

## Step-by-Step Implementation (15 minutes)

### 1. Open label-manager.ts
```bash
code /workspaces/generacy/packages/orchestrator/src/worker/label-manager.ts:145
```

### 2. Add 4 Lines After Line 161

**Find this code** (line 156-162):
```typescript
if (labelsToRemove.length > 0) {
  this.logger.info(
    { labels: labelsToRemove, issue: this.issueNumber },
    'Resume: removing waiting-for and agent:paused labels',
  );
  await this.github.removeLabels(this.owner, this.repo, this.issueNumber, labelsToRemove);
}
```

**Add immediately after the closing brace**:
```typescript
// Add agent:in-progress to reflect active workflow state
this.logger.info(
  { issue: this.issueNumber },
  'Resume: adding agent:in-progress label',
);
await this.github.addLabels(this.owner, this.repo, this.issueNumber, ['agent:in-progress']);
```

### 3. Update Test #1

**Open test file**:
```bash
code /workspaces/generacy/packages/orchestrator/src/worker/__tests__/label-manager.test.ts:148
```

**Find this test** (line 149-167):
```typescript
it('removes waiting-for:* and agent:paused labels when present', async () => {
  // ... existing code ...

  expect(mockGithub.removeLabels).toHaveBeenCalledWith('owner', 'repo', 42, [
    'waiting-for:clarification',
    'agent:paused',
  ]);
});
```

**Add before closing brace**:
```typescript
expect(mockGithub.addLabels).toHaveBeenCalledWith('owner', 'repo', 42, [
  'agent:in-progress',
]);
```

### 4. Update Test #2

**Find this test** (line 169-183):
```typescript
it('does not call removeLabels when no stale labels exist', async () => {
  // ... existing code ...

  expect(mockGithub.removeLabels).not.toHaveBeenCalled();
});
```

**Add before closing brace**:
```typescript
expect(mockGithub.addLabels).toHaveBeenCalledWith('owner', 'repo', 42, [
  'agent:in-progress',
]);
```

---

## Testing (10 minutes)

### Run Unit Tests
```bash
cd /workspaces/generacy/packages/orchestrator
pnpm test -- label-manager.test.ts
```

**Expected**: ✅ All 20 tests pass

### Quick Integration Test (Optional)
```bash
# 1. Create test issue
gh issue create --repo generacy-ai/generacy \
  --title "TEST: Feature 237" \
  --body "Testing resume label fix" \
  --label "process:speckit-feature"

# 2. Wait for clarification gate (~30s)
gh issue view <ISSUE_NUM> --json labels

# 3. Provide clarification
gh issue comment <ISSUE_NUM> --body "/continue

Test clarification"

# 4. Verify agent:in-progress appears
watch -n 1 "gh issue view <ISSUE_NUM> --json labels --jq '.labels[].name'"
```

**Expected**: See `agent:in-progress` label after resume

---

## Files Changed

```
modified: packages/orchestrator/src/worker/label-manager.ts (+4 lines)
modified: packages/orchestrator/src/worker/__tests__/label-manager.test.ts (+2 lines)
```

---

## Commit Message

```
feat: add agent:in-progress label on workflow resume

When workflows resume after hitting a gate (e.g., clarification),
the label state now correctly transitions from agent:paused to
agent:in-progress, making resume events consistent with process events.

This fixes a label state machine gap where resumed workflows had no
agent status label during active execution.

Changes:
- LabelManager.onResumeStart() now adds agent:in-progress after removing stale labels
- Both label operations wrapped in same retryWithBackoff() for atomicity
- Updated unit tests to verify addLabels call

Fixes #237

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

---

## Verification Checklist

- [ ] Code added: 4 lines in `label-manager.ts`
- [ ] Tests updated: 2 assertions in `label-manager.test.ts`
- [ ] Unit tests pass: `pnpm test -- label-manager.test.ts`
- [ ] Integration test (optional): Verify on test issue
- [ ] Commit created with proper message
- [ ] PR created against `develop` branch

---

## Troubleshooting

### Tests Fail: "addLabels not called"
**Fix**: Verify you added the 4 lines INSIDE the `retryWithBackoff()` block (before the closing `});` on line 163)

### Tests Fail: "Wrong arguments"
**Fix**: Verify label name is exactly `'agent:in-progress'` (not `agent:active` or other variants)

### Integration Test: Label Doesn't Appear
**Fix**:
1. Check orchestrator logs: `tail -f packages/orchestrator/logs/*.log`
2. Verify GitHub API rate limits: `gh api rate_limit`
3. Check issue comments for errors: `gh issue view <NUM> --comments`

---

## Need More Detail?

- **Full implementation plan**: See `plan.md`
- **Retry logic analysis**: See `research.md`
- **State machine diagrams**: See `state-diagram.md`
- **Detailed test plan**: See `test-plan.md`

---

## Quick Reference

### Label State Machine
```
Process event → agent:in-progress ✅
Resume event → agent:in-progress ✅ (after fix)
Gate hit → agent:paused
Error → agent:error
Complete → (no agent label)
```

### Key Decision
**Why add label in `onResumeStart()` instead of monitor service?**
- Keeps paused→active transition atomic
- Avoids race conditions
- Consistent with feature #215 design

### Risk Level
🟢 **LOW** — Follows existing patterns, covered by retry logic

---

*Quick start guide created by Claude Code on 2026-02-24*

# Feature 237: Add agent:in-progress Label on Workflow Resume

**Status**: Ready for Implementation
**Branch**: `237-summary-when-workflow-resumes`
**Complexity**: Low
**Estimated Time**: ~1 hour

## Quick Links

- 🚀 **Start Here**: [QUICKSTART.md](QUICKSTART.md) — Step-by-step implementation guide
- 📋 **Full Plan**: [plan.md](plan.md) — Comprehensive implementation plan
- 🧪 **Testing**: [test-plan.md](test-plan.md) — Unit and integration test details
- 🎯 **Summary**: [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) — High-level overview

## Problem Statement

When workflows resume after hitting a gate (e.g., clarification), the `agent:paused` label is removed but `agent:in-progress` is never added. This creates a label state machine gap where users can't tell if a workflow is actively running after resume.

**Current**: `agent:paused` → (removed) → no agent status label ❌
**Expected**: `agent:paused` → `agent:in-progress` → workflow continues ✅

## Solution Overview

Add `agent:in-progress` label in `LabelManager.onResumeStart()` immediately after removing stale labels.

**Changes Required**:
- 4 lines added to `label-manager.ts`
- 2 assertions added to `label-manager.test.ts`
- Zero breaking changes

## Documentation Structure

### For Implementers

1. **[QUICKSTART.md](QUICKSTART.md)** — Start here for fastest path to implementation
   - Copy-paste code snippets
   - Step-by-step instructions
   - Quick testing commands
   - Commit message template

2. **[plan.md](plan.md)** — Comprehensive implementation plan
   - Technical context and architecture
   - Implementation phases (3 phases)
   - Files to modify with line numbers
   - Success criteria and risk assessment

3. **[test-plan.md](test-plan.md)** — Testing strategy
   - Unit test updates (2 tests)
   - Integration test procedure (5 minutes)
   - Debugging tips
   - Expected outcomes

### For Reviewers

4. **[IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md)** — High-level overview
   - Problem and solution summary
   - Key technical decisions
   - Risk assessment
   - Success criteria

5. **[decisions.md](decisions.md)** — Architectural Decision Record (ADR)
   - 5 key decisions with rationale
   - Alternatives considered and rejected
   - Cross-cutting concerns
   - Future considerations

6. **[research.md](research.md)** — Technical deep-dive
   - Retry logic analysis
   - Race condition analysis
   - Idempotency guarantees
   - Comparison with existing patterns

### Visual References

7. **[state-diagram.md](state-diagram.md)** — Label state machine diagrams
   - Before/after fix visualization
   - Complete state machine flow
   - Edge case handling
   - Label state comparison tables

### Original Spec

8. **[spec.md](spec.md)** — Feature specification
   - User stories
   - Functional requirements
   - Technical design
   - Success criteria

## Implementation Checklist

### Code Changes (15 minutes)
- [ ] Modify `label-manager.ts:onResumeStart()` (+4 lines)
- [ ] Update test: "removes waiting-for:* and agent:paused labels when present" (+1 assertion)
- [ ] Update test: "does not call removeLabels when no stale labels exist" (+1 assertion)

### Testing (10 minutes)
- [ ] Run unit tests: `pnpm test -- label-manager.test.ts`
- [ ] Verify all 20 tests pass
- [ ] Optional: Run integration test (see test-plan.md)

### Commit & PR (5 minutes)
- [ ] Create commit with template from QUICKSTART.md
- [ ] Create PR against `develop` branch
- [ ] Link to issue #237 (if exists)
- [ ] Request review

### Post-Deployment
- [ ] Monitor for orphaned `agent:in-progress` labels
- [ ] Verify fix on real issue (e.g., #235)
- [ ] Update spec.md status to "Implemented"

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Add label in worker's `onResumeStart()` | Atomic operation, no race conditions, consistent with feature #215 |
| Always add label (unconditional) | Handles edge case: manual cleanup before resume |
| Single `retryWithBackoff()` block | Both operations retry together (atomic) |
| Info-level logging | Consistent with other label operations |
| Update existing tests | Minimal changes, tests full flow |

See [decisions.md](decisions.md) for detailed analysis.

## Files Modified

```
modified: packages/orchestrator/src/worker/label-manager.ts
  Location: lines 162-167
  Changes: +4 lines (comment + log + addLabels call)

modified: packages/orchestrator/src/worker/__tests__/label-manager.test.ts
  Location: lines 166, 182
  Changes: +2 assertions (one per test case)
```

## Risk Assessment

**Overall Risk**: 🟢 **LOW**

| Risk | Mitigation |
|------|------------|
| Race condition | Both operations in same retry block |
| API rate limiting | No extra API calls (addLabels batches) |
| Test flakiness | Mock `sleep()` in tests |
| Regression | Zero changes to process event path |

**Rollback Plan**: Single commit revert

## Success Criteria

✅ Resume events show `agent:in-progress` during execution
✅ All existing tests pass (no regression)
✅ New test assertions verify `addLabels` called
✅ Manual integration test passes (optional)

## Dependencies

**No new dependencies required**. Uses existing:
- `GitHubClient.addLabels()` — Already used throughout codebase
- `retryWithBackoff()` — Existing retry logic
- Vitest — Existing test framework

## Timeline

| Phase | Duration | Activity |
|-------|----------|----------|
| Implementation | 15 min | Code changes (2 files) |
| Testing | 10 min | Unit tests + verification |
| PR & Review | 30 min | Create PR, review, merge |
| Deployment | 15 min | Deploy to staging → production |
| **Total** | **~1 hour** | End-to-end completion |

## Getting Help

**Questions about**:
- Implementation steps? → See [QUICKSTART.md](QUICKSTART.md)
- Technical details? → See [plan.md](plan.md)
- Testing? → See [test-plan.md](test-plan.md)
- Retry logic? → See [research.md](research.md)
- Architecture? → See [decisions.md](decisions.md)
- State machine? → See [state-diagram.md](state-diagram.md)

**Still stuck?**
- Check existing patterns: `onPhaseComplete()`, `onGateHit()` in `label-manager.ts`
- Review feature #215 implementation (added `onResumeStart()` originally)
- Search codebase for `agent:in-progress` usage examples

## Related Features

- **Feature #215**: Added `onResumeStart()` for gate label cleanup (foundation for this fix)
- **Issue #235**: Real-world example that exposed this label state gap

## Future Enhancements

- Add Grafana dashboard for label state metrics
- Add CI/CD integration test for label transitions
- Document complete label state machine in architecture docs

---

## Quick Command Reference

```bash
# Navigate to feature directory
cd /workspaces/generacy/specs/237-summary-when-workflow-resumes

# Open implementation guide
cat QUICKSTART.md

# Open files to modify
code packages/orchestrator/src/worker/label-manager.ts:145
code packages/orchestrator/src/worker/__tests__/label-manager.test.ts:148

# Run tests
cd /workspaces/generacy/packages/orchestrator
pnpm test -- label-manager.test.ts

# Create test issue (integration test)
gh issue create --repo generacy-ai/generacy \
  --title "TEST: Feature 237" \
  --body "Testing resume label fix" \
  --label "process:speckit-feature"

# Check issue labels
gh issue view <NUM> --json labels --jq '.labels[].name'
```

---

**Ready to implement?** Start with [QUICKSTART.md](QUICKSTART.md) for step-by-step instructions.

**Need context first?** Read [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) for the high-level overview.

---

*Documentation generated by Claude Code on 2026-02-24*

# Quickstart: Phase 3 Multi-Repo Review Coordination

**Feature**: #692 — on-sibling-review gate condition and review-phase sibling coordination

## Prerequisites

- Phase 2 (#691) merged — provides `LinkedPR` schema and sibling fan-out
- `pnpm install` completed at repo root
- GitHub token with `repo` scope for cross-repo PR operations

## Building

```bash
# Build all packages (from repo root)
pnpm -r --filter './packages/*' build

# Or build specific packages
pnpm --filter @generacy-ai/orchestrator build
pnpm --filter @generacy-ai/workflow-engine build
```

## Running Tests

```bash
# Run all orchestrator worker tests
pnpm --filter @generacy-ai/orchestrator test -- --run src/worker/__tests__/

# Run specific test files
pnpm --filter @generacy-ai/orchestrator test -- --run src/worker/__tests__/gate-checker.test.ts
pnpm --filter @generacy-ai/orchestrator test -- --run src/worker/__tests__/sibling-review-checker.test.ts
pnpm --filter @generacy-ai/orchestrator test -- --run src/worker/__tests__/linked-pr-url-parser.test.ts
pnpm --filter @generacy-ai/orchestrator test -- --run src/worker/__tests__/pr-manager.test.ts
```

## Verification Scenarios

### Scenario 1: Multi-repo workflow enters review

1. Create a workflow with `linkedPRs` containing 2 sibling draft PRs
2. Run implement phase to completion
3. Verify: `on-sibling-review` gate activates
4. Verify: both sibling PRs are flipped from draft to ready-for-review
5. Verify: `waiting-for:sibling-review` label is applied to the issue

### Scenario 2: All siblings approved — gate passes

1. Set up workflow paused at `waiting-for:sibling-review`
2. Mock `gh pr view --json reviewDecision` to return `APPROVED` for all siblings
3. Resume workflow
4. Verify: gate is satisfied, workflow proceeds past implement phase

### Scenario 3: Some siblings not approved — gate holds

1. Set up workflow paused at `waiting-for:sibling-review`
2. Mock one sibling as `APPROVED`, another as `CHANGES_REQUESTED`
3. Verify: gate remains active, workflow stays paused

### Scenario 4: Single-repo workflow (no linkedPRs)

1. Create a workflow with no linked PRs (empty array or undefined)
2. Verify: `on-sibling-review` gate immediately passes (vacuous truth)
3. Verify: no errors or unnecessary API calls

### Scenario 5: Multi-gate coexistence on implement phase

1. Configure both `waiting-for:implementation-review` (always) and `waiting-for:sibling-review` (on-sibling-review)
2. Complete implement phase
3. Verify: `waiting-for:implementation-review` activates first (it's `always`)
4. After `completed:implementation-review` label is added by reviewer
5. Resume → verify `waiting-for:sibling-review` is evaluated next
6. When all siblings approved → workflow proceeds

### Scenario 6: markReadyForReview backstop

1. Run a multi-repo workflow without the `on-sibling-review` gate configured
2. All phases complete → `markReadyForReview()` fires
3. Verify: primary PR marked ready AND all sibling PRs marked ready

## Troubleshooting

### Gate never activates

- Check that `linkedPRs` is populated in `WorkflowState` (Phase 2 dependency)
- Verify `on-sibling-review` gate is in the workflow config (`config.ts`)
- Check logs for `Gate found: caller will evaluate condition`

### Sibling PRs not flipped to ready

- Check GitHub token has `repo` scope for sibling repos
- Check `LinkedPR.url` is a valid GitHub PR URL
- Look for `Failed to mark sibling PR ready` warnings in logs

### reviewDecision always empty

- PR may have no reviews yet — this is expected, gate stays active
- Check that reviewers have actually submitted reviews (not just comments)
- `gh pr view <url> --json reviewDecision` to verify manually

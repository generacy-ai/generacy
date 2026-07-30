# Quickstart: `#1043` fix — deterministic branch/spec-slug + PR dedup

**Feature**: `1043-summary-when-speckit-feature` · **Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

Steps to reproduce the bug, apply the fix, and verify. Targets developers picking up the implement phase.

## Reproduce the bug (pre-fix behavior)

1. Pick an issue that already has an in-progress speckit branch and open PR — for example `generacy-ai/generacy#1038` with branch `1038-issue-1038` and open PR #1039.
2. Simulate a re-entry: check out the default branch (`develop`), then invoke `executeCreateFeature` with a **different description** than first entry:

   ```ts
   import { executeCreateFeature } from '@generacy-ai/workflow-engine';

   await executeCreateFeature({
     description: 'part cockpit remote gates',  // different from first-entry description
     number: 1038,
     cwd: '/workspaces/generacy',
   }, console);
   ```

3. Observe: a new branch `1038-part-cockpit-remote-gates` is created, a new `specs/1038-part-cockpit-remote-gates/` directory is scaffolded, and — if the orchestrator's phase loop runs — a second draft PR opens alongside #1039.

## Apply the fix

1. Pull the `1043-summary-when-speckit-feature` branch.
2. `pnpm install`.
3. `pnpm build` (builds `packages/workflow-engine` + `packages/orchestrator`).

## Verify the fix

### Unit-level

```bash
pnpm --filter @generacy-ai/workflow-engine test issue-branch-resolver
pnpm --filter @generacy-ai/workflow-engine test deterministic
pnpm --filter @generacy-ai/orchestrator test pr-manager-issue-dedup
```

All three test files land as part of this PR. Expect green.

### Integration-level (manual)

Repeat the "Reproduce the bug" steps *with the fix applied*. Expected:

- `executeCreateFeature` returns `branch_name: '1038-issue-1038'` (the canonical name, not `1038-part-cockpit-remote-gates`).
- No new directory under `specs/`. The existing `specs/1038-issue-1038/` is re-used.
- Log line: `event: 'workflow-reentry-branch-reused'` with `{ canonicalBranch: '1038-issue-1038', wouldHaveDerived: '1038-part-cockpit-remote-gates', source: 'oldest-open-pr', anchoringPrNumber: 1039 }`.
- If `PrManager.ensureDraftPr` runs: `findPRForBranch('1038-issue-1038')` returns PR #1039; no new PR is opened.

### End-to-end (opt-in, requires cluster)

Run the fix against a live cluster:

1. Bring up a cluster with `generacy up` (or use an existing one).
2. Pick an epic with a mid-flight issue that has `waiting-for:implementation-review` + `agent:paused`.
3. Trigger `cockpit_advance(implementation-review)` and watch the doorbell.
4. **Pre-fix expected outcome**: after ~1 minute, a second PR opens on a different `<N>-*` branch.
5. **Post-fix expected outcome**: no second PR; the existing PR sees another commit push (or nothing if the phase produced no changes); a `workflow-reentry-branch-reused` log line appears in the orchestrator logs.

## Structured log queries for observability

After the fix ships, search for these events to spot near-misses:

```bash
# Happy path — resolver picked up an existing branch on re-entry
jq -r 'select(.event == "workflow-reentry-branch-reused")' orchestrator.log

# Defense-in-depth path — createFeature picked wrong branch, pr-manager caught it
jq -r 'select(.event == "workflow-reentry-branch-mismatch")' orchestrator.log
```

**SC-005 alert threshold**: any occurrence of `workflow-reentry-branch-mismatch` means the callback wiring in `createFeature` failed (a real bug — file an issue). The defense-in-depth path adopted the correct PR, but the underlying miss should be root-caused.

## What this fix does NOT do

Per `spec.md` §Out of Scope + Q3-A / Q4-A:

- **Does not** clean up pre-existing duplicate `specs/<N>-*` directories on old branches.
- **Does not** rename branches created before this fix ships.
- **Does not** fix the `implementation-review` re-cycle root cause (US3, deferred to a follow-up gated on [#849](https://github.com/generacy-ai/generacy/pull/849)).
- **Does not** change slug-generation algorithm.
- **Does not** touch `cockpit_merge` or `cockpit_status` picker logic.

## Rollback

The changes are behind an optional callback. To roll back:

1. Revert the commit that adds `resolveExistingBranch` to `create-feature.ts` action wiring. `createFeature` reverts to slug-derivation-only.
2. Revert the `PrManager.ensureDraftPr` diff. Behavior reverts to `findPRForBranch(currentBranch)` only.
3. The `issue-branch-resolver.ts` file can stay in place (unused, no side effects).

Duplicate-PR risk returns to pre-fix baseline immediately.

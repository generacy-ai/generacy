# Quickstart: #820 — Fail loud on empty-implement runs

This feature adds no user-visible commands, no CLI flags, no config surface. The change is a runtime guard in the orchestrator's phase loop. This quickstart documents how to (a) run the new tests locally and (b) manually reproduce the failure and success cases end-to-end.

## Prerequisites

Standard repo setup (already required for orchestrator development):

```bash
pnpm install
```

The check runs in-cluster inside `packages/orchestrator/*`. No new external dependencies.

## Running the tests

```bash
# Unit tests for the new product-diff helper
pnpm --filter @generacy-ai/orchestrator test -- product-diff

# Full orchestrator test suite (includes the phase-loop integration test for SC-001)
pnpm --filter @generacy-ai/orchestrator test

# Type-check across the workspace (touches workflow-engine's interface extension)
pnpm build
```

## Manual repro: empty-implement (fail loud)

Reproduces agency PR #376 conditions locally. Assumes a checkout of `generacy-ai/agency` (or any repo with a speckit workflow configured) and a running orchestrator.

1. Open an issue that triggers a speckit workflow (`speckit-feature` or `speckit-bugfix`).
2. Wait for the workflow to reach the `implement` phase.
3. Manually intervene *before* implement finishes — force the phase to commit only spec artifacts:
   - Edit `specs/<feature>/tasks.md` (or any file under `specs/`).
   - Do not touch `packages/**`, `src/**`, `docs/**`, or root files.
4. Allow the implement CLI to return `partial: false`.

**Expected outcome (post-#820)**:
- Stage comment updates to `error` for the implement phase.
- Issue receives the `agent:error` / `needs:intervention` label pair via `labelManager.onError('implement')`.
- Workflow terminates. `validate` is not invoked.
- Orchestrator log line at `error` level:
  ```
  implement phase produced no product-code changes — all diff lives under excluded paths
    { phase: 'implement', baseRef: 'origin/develop', changedCount: 3, excluded: ['specs/'] }
  ```

**Prior behavior (pre-#820, for comparison)**:
- Workflow proceeded to `validate`. `pnpm test && pnpm build` passed on the unchanged working tree.
- PR merged. No acceptance criteria met.

## Manual repro: legitimate implement (pass)

1. Same setup, but let the implement CLI produce at least one non-`specs/` file.
2. Or, on a resumed run, ensure the branch's cumulative diff (vs. the PR's base ref) already contains at least one non-`specs/` file from an earlier iteration.

**Expected outcome**: Workflow proceeds to `validate` as normal. No `error` label, no stage-comment change from the new check.

## Debugging

### "Where does the base ref come from?"

Grep for `resolveBaseRef` in `packages/orchestrator/src/worker/product-diff.ts`. Order of precedence:

1. PR's `base.ref` via `github.getPullRequest(...)` when `prManager.getPrNumber()` is defined.
2. `origin/<default-branch>` from `github.getDefaultBranch()` when no PR exists yet.

To confirm which was used, look for the `baseRef` field in the error log line — it's always prefixed with `origin/`.

### "Why is my legitimate PR failing?"

Check the log line's `changedCount` and `excluded` fields. If `changedCount > 0` but the error still fires, every changed file starts with an entry in `excluded`. Run locally:

```bash
git diff --name-only origin/<pr-base>...HEAD
```

Any file not under `specs/` should count as product diff. If none appear, the implement phase did not modify product code — this is the correct behavior; add the missing changes.

### "The check throws — `git diff` failed"

Usually `origin/<base>` was not fetched. Ensure the worker's checkout has the base branch available:

```bash
git fetch origin <base>
```

The workflow's checkout logic should already do this; if not, the failure is upstream of #820.

### "How do I add another excluded prefix?"

Edit `EXCLUDED_PATH_PREFIXES` in `packages/orchestrator/src/worker/product-diff.ts`. Add an entry ending with `/`. Update the corresponding unit tests. Do not add a `WorkerConfig` field unless a second concrete workflow needs a different list — the constant-then-config discipline is deliberate (see Clarification Q1).

## What This Feature Does *Not* Do

- Does not change the `implement` agent's prompt or behavior. If the agent keeps producing spec-only runs, the fix here surfaces the failure — it does not prevent it.
- Does not change `validate`. A workflow whose `validate` command is `true` still passes trivially — the guard runs *before* validate.
- Does not retroactively re-open agency PR #376 or its issue.
- Does not fix the #818 clarify gate-skip race (separate issue).

## Files Modified

- `packages/orchestrator/src/worker/phase-loop.ts` — guard replaced.
- `packages/orchestrator/src/worker/product-diff.ts` — new.
- `packages/orchestrator/src/worker/pr-manager.ts` — `getPrNumber()` accessor added.
- `packages/workflow-engine/src/actions/github/client/interface.ts` — `getFilesChangedBetween` added.
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts` — implementation.
- Unit + integration tests under `packages/orchestrator/src/worker/__tests__/`.

## Next Step

Run `/speckit:tasks` to generate the ordered task breakdown from `plan.md`.

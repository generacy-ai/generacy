# Research Notes: Branch Safety Bug Fix

## Decision: Logger Strategy in `feature.ts`

### Context

The `createFeature` function in `feature.ts` is a pure library function that takes `CreateFeatureInput` and returns `CreateFeatureOutput`. It has no injected logger dependency — unlike the executor (which has a `Logger` via `ExecutorOptions`), this function uses no logging at all.

The spec requires logging `git.fetch` failures as warnings (FR-005).

### Options Considered

1. **`console.warn`** — Simple, zero-cost change, works everywhere
2. **Add optional `logger` to `CreateFeatureInput`** — Clean DI pattern, but changes the function signature and would need to be threaded through from the action handler
3. **Import and use `createLogger` from `types/logger.ts`** — Creates a module-level logger instance

### Decision

Use `console.warn` for this bug fix. Rationale:
- The change is minimal and doesn't affect the function's interface
- `feature.ts` is called from the speckit action handler which already has its own logging context
- Adding a logger parameter would cascade changes through the action handler call chain
- This is a warning for a non-critical code path (fetch failure is recoverable)

If a more structured logging approach is needed in the future, it can be added as a separate refactoring effort with a `logger` parameter on `CreateFeatureInput`.

## Decision: Branch Validation Scope

### Context

The executor needs to validate the branch after the setup phase. The spec suggests checking `phase.name === 'setup'`.

### Options Considered

1. **Check by phase name** — `phase.name === 'setup'`
2. **Check by step presence** — Inspect whether the phase contains a `create-feature` or `create-bugfix` step
3. **Always validate** — Check branch after every phase

### Decision

Check by phase name. Rationale:
- The setup phase name is a stable convention used in all workflow YAMLs (`speckit-feature.yaml`, `speckit-bugfix.yaml`)
- Step introspection is more brittle (step names could change, new steps could be added)
- Always-validate would add unnecessary overhead and false positives for workflows that legitimately operate on the default branch
- The spec's risk table notes this: "Only validate when setup phase contains a `create-feature` step" — but phase name check is equivalent given current workflow structure

## Decision: `continueOnError` Removal Scope

### Context

Currently every commit/push step and the `create-pr` step have `continueOnError: true`. The spec says to remove it from `create-pr` only.

### Analysis

- **Commit steps** (`git add -A && git commit`): Legitimately need `continueOnError` because `--allow-empty` handles empty commits, but the `&&` chain means `git add` failure would cascade. This is acceptable — if `git add` fails, something is seriously wrong and the error should propagate through `continueOnError` handling.
- **Push steps**: Need `continueOnError` because push can fail for transient network reasons. The explicit branch name in the push command (Step 3.3) already prevents pushing to the wrong branch.
- **`create-pr` step**: Failure signals a fundamental problem (branch mismatch, permission issue). Should NOT be masked.

### Decision

Only remove `continueOnError` from `create-pr` step. This is the minimum change that catches the critical signal (PR creation failure = wrong branch) without introducing brittleness in the commit/push pipeline.

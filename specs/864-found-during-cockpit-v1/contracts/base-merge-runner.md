# Contract: BaseMergeRunner

**Module**: `packages/orchestrator/src/worker/base-merge.ts`
**Consumed by**: `PhaseLoop.executeLoop` (implement / pre-validate / validate branches).

## Signature

```ts
export interface BaseMergeRunner {
  (
    checkoutPath: string,
    branch: string,
    baseRef: string,           // 'origin/<base>'
    opts: BaseMergeOptions,    // { commit: boolean }
    logger: Logger,
  ): Promise<BaseMergeResult>;
}
```

## Preconditions

- `checkoutPath` exists and is a git working tree.
- `branch` is the feature branch (e.g. `864-found-during-cockpit-v1`). The runner assumes the feature branch is already checked out; it does NOT switch branches.
- `baseRef` starts with `origin/` and names an existing remote branch (validated by the runner).

## Behavior

1. `git reset --hard origin/<branch>` — discard any workspace-local state (FR-012 crash-safe reset).
2. `git clean -fd` — sweep untracked files (mirrors existing `RepoCheckout.switchBranch` behavior).
3. `git fetch origin <baseBranchWithoutPrefix>` — fresh fetch of the base ref (FR-007).
4. `git merge --no-ff <baseRef>` when `opts.commit === true`, else `git merge --no-ff --no-commit <baseRef>`.
5. On non-zero exit from merge:
   - Run `git diff --name-only --diff-filter=U` to enumerate conflicted paths.
   - Run `git merge --abort` to leave the tree in a clean state (so the next phase's reset-at-start starts from a known-good baseline; the reset would clean it up anyway but abort is faster).
   - Return `{ ok: false, baseRef, conflictedPaths }`.
6. On merge success:
   - If `opts.commit === true`: capture `git rev-parse HEAD` as `mergeSha`; return `{ ok: true, baseRef, mergeSha }`.
   - Else: return `{ ok: true, baseRef }` (no `mergeSha` — the merge is un-committed).

## Postconditions

- On `ok: true` with `commit: true`: the feature branch has an additional merge commit at HEAD; caller is expected to `git push` as part of implement's normal push.
- On `ok: true` with `commit: false`: the working tree contains the merged files but no commit exists; the next phase's reset-at-start will discard it.
- On `ok: false`: the working tree is reset to `origin/<branch>` (merge aborted); no partial state persists.

## Error propagation

Non-conflict git failures (e.g. `git fetch` failing on network) are thrown as `Error`. The caller (`PhaseLoop`) catches them in the existing try/catch at `phase-loop.ts:217` and treats them as unexpected phase failures. Not converted to `{ ok: false }` — those are for *conflicts*, not infrastructure failures.

## Testability

Implemented as a pure function on top of `execFile('git', ...)`. Tests inject a stub `ExecFile` that returns pre-canned stdout/stderr/exit-code per invocation. The `PhaseLoop` test suite injects a `BaseMergeRunner` fake instead of exercising git.

## Idempotency

Safe to invoke multiple times in a row: each invocation starts with `git reset --hard origin/<branch>` which discards any prior state.

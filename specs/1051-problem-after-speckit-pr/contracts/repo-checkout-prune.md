# Contract: FR-001 `--prune` on multi-ref fetch sites

## Sites to modify

`packages/orchestrator/src/worker/repo-checkout.ts`:

| Site | Line (current) | Change |
|------|----------------|--------|
| `switchBranch` | 109 | `execFileAsync('git', ['fetch', 'origin'], { cwd: checkoutPath })` → `execFileAsync('git', ['fetch', 'origin', '--prune'], { cwd: checkoutPath })` |
| `updateRepo` | 224 | Same substitution. |

`fetchBase` at `:143` is a single-ref fetch (`git fetch origin <baseBranch>`). `--prune` on a single-ref fetch has no effect (git only prunes refs it would have fetched); leave unchanged. Confirmed by spec's Supplementary note.

## Behavior contract

Post-change, when `git fetch origin --prune` runs:

- Any `refs/remotes/origin/<branch>` whose corresponding remote branch has been deleted is removed from the local repo.
- The subsequent `git checkout <branch>` at `:112` / `:228` still succeeds if the *local* branch (unqualified `<branch>`) still exists (git checkout of a local branch does not require its upstream to be resolvable).
- The subsequent `git reset --hard origin/<branch>` at `:132` / `:240` fails loudly (`fatal: ambiguous argument 'origin/<branch>'`) if the tracking ref was pruned. This is the desired behavior — the failure signals a merged-and-deleted branch.

**Not a silent behavior change**: prior to the fix, `reset --hard origin/<branch>` succeeded against a stale tracking ref (resurrecting the pre-merge tip). Post-fix it fails, and the calling site (`switchBranch` / `updateRepo`) throws. The push-guard (FR-002) runs first and refuses before this throw is reached in the happy path, so operators do NOT see the raw git error under normal operation — the guard's structured log is the operator-facing signal.

**Edge case**: `git checkout <branch>` may also fail if the local branch does not exist and the tracking ref has been pruned. The existing catch block at `:113-118` and `:229-237` handles this by running `git checkout -B <branch> origin/<branch>` — which also fails loudly on a pruned tracking ref. Same signal, different code path. No new catch-block needed.

## Test surface

`repo-checkout.test.ts` — SC-005 static assertion:

- `switchBranch()` test: mock `execFile`, invoke `switchBranch(path, 'branch')`, assert one of the `execFile` calls had argv exactly `['fetch', 'origin', '--prune']`.
- `updateRepo()` test (or the `ensureCheckout` fallthrough that exercises `updateRepo`): same assertion.

`repo-checkout-branch-resurrection.integration.test.ts` — SC-001 integration test using a real ephemeral git repo (mktemp) to prove the merge-then-reenter cycle no longer produces a recreated remote branch. Fixtures:

- Create bare repo `origin.git`.
- Clone to `checkoutA`, create branch `feature`, push, commit some files.
- Clone to `checkoutB`, delete `feature` from `origin.git` (simulates PR merge with `--delete-branch`).
- Return to `checkoutA`, run `switchBranch(checkoutA, 'feature')`.
- Assert: `git ls-remote origin feature` in `origin.git` returns empty (branch NOT recreated).
- Repeat for `updateRepo` code path (invoke via `ensureCheckout` with the existing checkout).

Both tests are load-bearing — SC-005 is the static check; SC-001 is the behavioral check. Together they close the loophole where a static-only check might miss a semantic regression (e.g., `--prune` present but suppressed by an env var).

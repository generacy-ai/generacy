# Quickstart

## What this feature ships

A structural fix to `PhaseLoop` that makes the pre-phase base-merge hook fire **at most once per phase execution cycle**, instead of twice-per-validate-cycle (before install AND again before validate). Eliminates the class of `exit 127: vitest: not found` failures that hit every pre-scaffold sibling branch on its first validate attempt.

## Nothing to install

The change is internal to `packages/orchestrator/src/worker/phase-loop.ts` and its tests. No new packages, no new binaries, no config changes, no docs pages.

## Verifying the fix locally

### Run the unit fixture

```bash
pnpm --filter '@generacy-ai/orchestrator' test -- phase-loop.merge
```

The relevant assertions to eyeball:

- **`validate — clean merge (pre-validate and validate)` → `runs a single base-merge before the pre-validate install`** (renamed from the previous `runs a second base-merge before the validate command itself`).
  Expect: `baseMergeCount === 1`, ordered before both install and validate.

- **`validate — install artifacts survive to validate`** (new).
  Expect: the install fake writes a marker inside a fake `node_modules/` under the checkout path; the validate fake reads the marker without error. Reproduces the snappoll#4 sequence at unit scope.

- **`validate — retry re-runs install AND merge`** (new).
  Expect: driving the loop with a failing-then-passing validate result path produces exactly two base-merges across two attempts (one per attempt), per clarification Q3-A.

- **`implement — single merge (symmetry case)`** (new).
  Expect: implement phase still fires the committed base-merge exactly once. Q5-B guard is symmetric.

### Reproducing the original bug (optional, for reviewers)

To feel the bug's shape before applying the fix, temporarily revert the deletion of the second `runPreValidateBaseMerge` call and re-run the "install artifacts survive to validate" fixture. The install fake writes the marker; the second `runPreValidateBaseMerge` fake resets the checkout tree; the validate fake fails to find the marker. That failure mirrors the field failure of `sh: 1: vitest: not found` at unit scope without needing a real git tree.

## Behavioral surface for operators

Zero change for:

- Branches up-to-date with base (no observable difference).
- Merge-conflict pauses (`waiting-for:merge-conflicts` gate fires from the same code path as today).
- Implement phase committed-merge push semantics (unchanged).
- Retry counting, stage-comment rendering, failure-alert markers, gate labels, `cockpit status` output.

Silently-fixed for:

- Any branch that is behind base whose committed `.gitignore` predates the scaffold's ignore-`node_modules` addition. Validate now sees the installed toolchain and either passes cleanly or fails on a real test/build error (not a phantom `exit 127`).

## Troubleshooting

- **"I still see two base-merges in the log for a validate cycle."** Confirm the deployed image includes the phase-loop.ts change. The log line is `Base-merge: starting` in `base-merge.ts:100`; a fixed cycle emits it exactly once between "Starting phase" (`phase-loop.ts:209`) and the validate command's own spawn log.

- **"`exit 127: vitest: not found` still reproduces."** This fix addresses only the double-merge-clean cause. If the branch is genuinely missing dependency declarations (e.g., a merge lost `vitest` from `package.json`), the failure is real and the fix does not mask it. Inspect the install-step log and the merged tree's `package.json` first.

- **"A retry now runs a merge — is that new?"** No. The pre-implement merge always fired once per retry, and the pre-validate merge fired *twice* per retry before this fix. Post-fix: exactly one merge per attempt for both implement and validate. Q3-A confirms this is the intended design.

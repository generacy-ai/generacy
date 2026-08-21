# Quickstart: Bugfix targeted-validate and fail-then-pass hardening

Developer-facing guide to the seven fixes and how to exercise them. Nothing here
is user-configurable beyond the existing `speckit-bugfix` profile knobs; this is
correctness hardening of behavior that already ships.

## What changed

| Area | Before | After |
| --- | --- | --- |
| Deleted/renamed test in diff | `pnpm vitest run <missing-file>` hard-fails | path filtered out; deletion-only → full fallback |
| Root-only non-config change | `targeted` selects zero projects, passes vacuously | zero-project probe → full fallback |
| Base-ref infra failure (no dist, no root vitest, timeout) | reported as `base-passed`/`branch-failed` | non-blocking `skip` with logged reason |
| Hung base/branch test run | stalls to the cli-spawner cap | bounded by `BASE_TEST_TIMEOUT_MS` → `skip` |
| `mkdtemp` parent dir | leaked | removed on every path |
| Aborted-signal cleanup | worktree registration orphaned | signal-free cleanup + `git worktree prune` |
| `git worktree add` failure | hard phase failure | non-blocking `skip` |
| Custom `validateCommand` on `main` repo | hardcoded `origin/develop` mis-filters | `<base>` placeholder → resolved base |

## Files

- `packages/orchestrator/src/worker/phase-loop.ts` —
  `resolveTargetedValidate` (existence filter + zero-project probe),
  `computeEffectiveValidateCommand` (`<base>` substitution).
- `packages/orchestrator/src/worker/fail-then-pass.ts` — infra signature,
  per-run timeout, worktree lifecycle.
- `packages/orchestrator/src/worker/diff-classifier.ts` — **unchanged** (stays
  pure).
- `docs/docs/reference/bugfix-profile-config.md` — `origin/<base>` example.

## Using the `<base>` placeholder (operators)

In `.generacy/config.yaml` under `orchestrator.workflows.speckit-bugfix`:

```yaml
validateCommand: 'pnpm --filter "...[origin/<base>]" build && pnpm --filter "...[origin/<base>]" test'
```

`<base>` is substituted with your repo's resolved base branch (e.g. `develop` or
`main`) at validate time. No more hardcoded `origin/develop`.

## Running the tests

```bash
# fail-then-pass prover behavior (infra skip, timeout, worktree lifecycle)
pnpm --filter @generacy-ai/orchestrator test fail-then-pass

# targeted-validate wiring (existence filter, zero-project fallback, <base>)
pnpm --filter @generacy-ai/orchestrator test phase-loop
```

The suites mock `node:child_process` (an `execFile` router keyed on `cmd`/`args`)
and `node:fs/promises`. New cases route the `pnpm --filter … --json` zero-project
probe and each `pnpm vitest run` through the same handler.

## Reading the logs

Every fall-back / skip decision emits one structured line:

- `event: 'targeted-validate'` — `classification`, `isBuiltInDefault`, `base`,
  `effectiveCommand`; `reason: 'zero-project-fallback'` on the zero-project path.
- `event: 'fail-then-pass'` — `outcome: 'skip'` with `reason` one of
  `infra:*`, `timeout`, `worktree-add-failed`, or the existing install-failure
  reason; `reason` on `fail` is `base-passed` / `branch-failed`.

## Troubleshooting

- **fail-then-pass keeps skipping** → check the logged `reason`. `infra:*` means
  the base ref could not run tests (unbuilt dist / no root vitest); `timeout`
  means a run exceeded `BASE_TEST_TIMEOUT_MS`. These are non-blocking by design —
  validate still runs normally.
- **Targeted validate ran the full suite** → a `zero-project-fallback` or
  `empty-diff` full-fallback log line means the diff selected no package project
  (root-only change) or every changed path was filtered out (deletion-only). This
  is intentional — it prevents a vacuous green.
- **Custom command filtered against the wrong branch** → ensure the command uses
  `<base>`, not a hardcoded branch name.

## Out of scope

No change to the classification taxonomy or glob sets, no change to the
off-by-default status of fail-then-pass, no change to `speckit-feature` validate,
no broader worktree-management refactor.

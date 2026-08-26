---
"@generacy-ai/orchestrator": patch
---

Harden the `speckit-bugfix` targeted-validate classifier and fail-then-pass regression prover (#1166).

Closes seven post-merge-review defects (#1134/#1150) in the bugfix-profile validate path, all in the wiring layer — the pure `classifyDiff` classifier stays untouched:

- **targeted-validate wiring** (`phase-loop.ts`): existence-filter the changed-file set before classification so deletion-only and rename diffs never emit `pnpm vitest run <nonexistent-file>`; probe `pnpm ls --filter "...[origin/<base>]"` for the built-in default and fall back to the full command when the selection is empty or the probe errors (fail-safe); substitute `<base>` in custom `validateCommand`s with the resolved base branch so the same command works on `develop`- and `main`-based repos.
- **fail-then-pass prover** (`fail-then-pass.ts`): a conservative `isInfraFailure` predicate maps pre-collection failures (zero tests collected, dist/module-resolution errors) to `skip` instead of a false `base-passed`/`branch-failed`; a base-test timeout maps to `skip: timeout` while phase-signal aborts still propagate; the worktree lifecycle is made best-effort and signal-free in `finally`, and a `git worktree add` failure skips rather than throwing.

Every new fallback/skip/infra decision emits exactly one structured log line. Non-bugfix workflows and non-triggering bugfix runs stay byte-identical.

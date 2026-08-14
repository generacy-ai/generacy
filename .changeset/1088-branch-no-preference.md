---
"@generacy-ai/config": minor
"@generacy-ai/generacy": patch
---

Remove the hardcoded `develop` workspace branch so `generacy setup workspace` no longer force-switches every repo. `convertTemplateConfig` now passes a new optional top-level template `branch:` key through verbatim instead of always emitting `branch: 'develop'`, and `WorkspaceConfigSchema.branch` becomes `z.string().min(1).optional()` with no default — `undefined` is a representable "no preference" (FR-001 / FR-002).

The `setup workspace` resolution chain (`--branch` > `REPO_BRANCH` > `DEFAULT_BRANCH` > config branch) loses its terminal `?? 'develop'` fallback (FR-007). When no tier supplies a branch, setup never switches an existing checkout: it fetches and pulls the current branch, and leaves detached HEADs or branches with no matching `origin/<b>` fetched-but-untouched while still reporting success. New repos clone without `--branch`. The `Configuration` log line reports the resolved `branchSource` and renders the no-preference case as `(repo default / current branch)` (FR-006).

Explicit-branch behavior is unchanged. Fixes #1088.

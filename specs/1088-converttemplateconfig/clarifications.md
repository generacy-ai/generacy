# Clarifications: 1088-converttemplateconfig

## Batch 1 — 2026-08-14

### Q1: Workspace-format config scope
**Context**: The spec targets `convertTemplateConfig`'s hardcoded `branch: 'develop'`, but `WorkspaceConfigSchema.branch` (`packages/config/src/workspace-schema.ts:12`) independently applies `.default('develop')` via Zod. A native workspace-format `.generacy/config.yaml` with no `branch` key therefore also resolves `configBranch = 'develop'`, occupying the same slot in the resolution chain and pre-empting no-preference behavior — the identical failure mode via a second path. SC-004 only names `convert-template.ts` and the workspace.ts fallback.
**Question**: Should the fix also remove the Zod `.default('develop')` from `WorkspaceConfigSchema.branch` so workspace-format configs without a branch key get the same no-preference behavior (FR-003/FR-004)?
**Options**:
- A: Yes — `branch` becomes optional with no default in both schemas; no-preference behavior applies uniformly to template-format and workspace-format configs.
- B: No — scope strictly to template-format conversion; workspace-format configs keep defaulting to `develop` (leaves one instance of the bug in place).

**Answer**: *Pending*

### Q2: Confirm no GitHub API default-branch lookup
**Context**: The spec's first Assumption explicitly asks to confirm at clarify: instead of querying the GitHub API for a repo's default branch, the fix relies on `git clone` without `--branch` (lands on remote default) and leaving existing checkouts on their current branch. This avoids a network/auth dependency in `setup workspace` but means the tool never *knows* the default branch name — it just inherits it.
**Question**: Is the no-API approach confirmed — clone without `--branch` for new repos and leave existing checkouts untouched when no branch is explicitly resolved?
**Options**:
- A: Confirmed — no API lookup; git-native behavior is sufficient (spec as written).
- B: Not sufficient — resolve the actual default branch name via API/`git ls-remote --symref` so it can be logged and used for switching existing checkouts.

**Answer**: *Pending*

### Q3: Template config branch key location
**Context**: FR-002 adds an optional branch field to `TemplateConfigSchema` (`packages/config/src/template-schema.ts`) but leaves the key name/location open ("top level or `project`"). The template format currently groups repo inputs under `repos:` (primary/dev/clone) and project metadata under `project:` (org_name). The choice is user-facing surface that documentation and existing project configs will depend on.
**Question**: Where should the optional branch key live in the template-format config?
**Options**:
- A: Top-level `branch:` — simplest, mirrors the workspace-format schema's top-level `branch` key.
- B: `repos.branch:` — co-located with the repo lists it governs (branch is workspace-wide across all repos).
- C: `project.branch:` — grouped with project metadata alongside `org_name`.

**Answer**: *Pending*

### Q4: Removing the final `'develop'` literal — silent or noticed?
**Context**: FR-007 removes the final `?? 'develop'` in `workspace.ts:111`. The Assumptions argue this is safe for existing generacy-ai clusters (their repos' actual default branch is `develop`), but any external `REPOS`-env-path user who implicitly relied on the literal will see changed behavior with no signal.
**Question**: When the old code would have fallen through to the `'develop'` literal (no flag, no env, no config branch), should the new no-preference path emit any operator-visible notice of the behavior change?
**Options**:
- A: No notice — the FR-006 "Configuration" log line already shows `branch: repo default / current branch`, which is sufficient signal.
- B: One-time `warn`-level line in the no-preference case for a release cycle (e.g. "no branch configured; previously defaulted to 'develop', now using repo default").

**Answer**: *Pending*

### Q5: No-preference update on non-standard checkout states
**Context**: FR-003 says the no-preference path updates an existing checkout via `git pull` against its current branch. `cloneOrUpdateRepo` detects the branch via `git branch --show-current`, which returns empty on a detached HEAD; a local-only branch with no upstream will make `git pull origin <branch>` fail. Today these states get forcibly switched to the configured branch; under no-preference there is no branch to switch to.
**Question**: In the no-preference case, how should `setup workspace` treat an existing checkout that is on a detached HEAD or a branch with no matching `origin/<branch>`?
**Options**:
- A: Fetch only, skip pull, log a `warn`, and report the repo as successful — setup must never mutate a checkout it has no opinion about (finetooth lesson).
- B: Fetch, attempt pull, and on failure log `warn` but still report success (best-effort update, same non-mutating outcome, noisier).
- C: Treat as failure — report the repo unsuccessful so the operator notices the unusual state.

**Answer**: *Pending*

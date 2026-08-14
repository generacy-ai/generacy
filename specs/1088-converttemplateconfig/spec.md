# Feature Specification: `convertTemplateConfig` hardcodes the workspace branch to `develop`, so `generacy setup workspace` force-switches every repo — including the primary the entrypoint just cloned — onto `develop` regardless of what the repo's default branch actually is

**Branch**: `1088-converttemplateconfig` | **Date**: 2026-08-14 | **Status**: Draft

## Summary

`convertTemplateConfig` hardcodes the workspace branch to `develop`, so `generacy setup workspace` force-switches every repo — including the primary the entrypoint just cloned — onto `develop` regardless of what the repo's default branch actually is.

## Where

`packages/config/src/convert-template.ts:26`:

```ts
return { org: primary.owner, branch: 'develop', repos };
```

There is no way to override it from `.generacy/config.yaml`: the template schema (`packages/config/src/template-schema.ts`, `TemplateConfigSchema`) has no branch field that reaches this conversion, so the repo's real default branch is ignored.

A resolution chain already exists in `packages/generacy/src/cli/commands/setup/workspace.ts:107-111` (`--branch` flag → `REPO_BRANCH` → `DEFAULT_BRANCH` → `configBranch` → `'develop'`), but because `convertTemplateConfig` always emits a concrete `branch: 'develop'`, `configBranch` is never `undefined` for template-format configs — the hardcode occupies the config slot in the chain and pre-empts everything below it. `REPO_BRANCH` *does* win over it today, but the post-activation entrypoint does not set it, so in practice the hardcode decides.

## Observed

On the finetooth cluster, post-activation cloned the primary at `--branch main`, then `generacy setup workspace` immediately undid it:

```
[post-activation] Cloning project repo: https://github.com/Painworth/finetooth.git (branch: main)
(generacy): Resolved repos          source: "config file"  count: 1
(generacy): Configuration           org: "Painworth"  branch: "develop"
(generacy): Switching branch        repo: "finetooth"  from: "main"  to: "develop"
```

Because `develop` and `main` were unrelated histories in that repo (see generacy-ai/generacy-cloud#909), the switch deleted `.generacy/config.yaml` from the working tree, and the very next post-activation pass failed:

```
ERROR (generacy): No .generacy/config.yaml found. Provide one via --config, CONFIG_PATH env,
or ensure a project with .generacy/config.yaml is mounted under /workspaces
```

The same error hit all 5 workers. A cluster that had successfully cloned its config then destroyed it and could not recover on restart.

## Impact

- Any project whose branch convention is not `develop` gets silently checked out onto a branch it did not ask for, or onto a branch that does not exist.
- Combined with an unrelated-histories repo, it is self-destructive: the config file that drives the whole setup gets removed by the tool that just read it.
- The fallback masks it in the ordinary case — `cloneOrUpdateRepo` retries without `--branch` when the branch is missing (`packages/generacy/src/cli/commands/setup/workspace.ts:236`), so the failure only becomes visible when the branch exists but is wrong.

## User Stories

### US1: Setup respects the branch the project was cloned at (Primary)

**As a** cluster operator whose project's default branch is `main` (or anything other than `develop`),
**I want** `generacy setup workspace` to leave an existing checkout on its current branch when no branch was explicitly configured,
**So that** the entrypoint's `--branch main` clone survives setup and the cluster does not destroy its own `.generacy/config.yaml`.

**Acceptance Criteria**:
- [ ] Given a repo already cloned at `main` and a template-format `.generacy/config.yaml` with no branch key, when `setup workspace` runs, the repo stays on `main` — no "Switching branch" log line, no checkout of `develop`.
- [ ] `.generacy/config.yaml` is still present in the working tree after `setup workspace` completes (finetooth regression).
- [ ] A subsequent `setup workspace` pass on the same workspace succeeds (idempotent restart, no "No .generacy/config.yaml found" error).

### US2: Project can declare its branch in config

**As a** project maintainer,
**I want** to declare the workspace branch in `.generacy/config.yaml` (template format),
**So that** all repos are cloned/updated at the branch my project actually uses, without relying on env vars injected by the entrypoint.

**Acceptance Criteria**:
- [ ] A `branch` key in the template-format config flows through `convertTemplateConfig` into the resolved `WorkspaceConfig.branch` and is used for clone and update.
- [ ] When the config declares a branch and an existing checkout is on a different branch, `setup workspace` switches to the declared branch (explicit intent — current switching behavior is correct here).

### US3: Explicit flag/env overrides still win

**As a** CI or entrypoint author,
**I want** `--branch` and `REPO_BRANCH`/`DEFAULT_BRANCH` to keep their existing precedence over any config value,
**So that** existing automation that sets these continues to behave identically.

**Acceptance Criteria**:
- [ ] `--branch` flag > `REPO_BRANCH` > `DEFAULT_BRANCH` > config `branch` key precedence is preserved and covered by tests.
- [ ] When an explicit source (flag/env/config) names a branch, clone uses `--branch <it>` and existing checkouts are switched to it, as today.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `convertTemplateConfig` MUST NOT emit a hardcoded `branch: 'develop'`. When the template config declares no branch, the resulting `WorkspaceConfig` MUST carry no branch opinion (unset/undefined), so downstream resolution can distinguish "explicitly configured" from "no preference". | P1 | Root cause. Requires `WorkspaceConfig.branch` (currently required `string`) to become optional, or an equivalent sentinel. |
| FR-001a | `WorkspaceConfigSchema.branch` MUST drop its Zod `.default('develop')` (`packages/config/src/workspace-schema.ts:12`): `branch` becomes optional with no default in both schemas, so workspace-format configs without a branch key get the same no-preference behavior. | P1 | Per clarification Q1=A — same failure mode via a second path. |
| FR-002 | The template config schema MUST accept an optional top-level `branch:` field, validated as a non-empty string, that flows through `convertTemplateConfig`. | P1 | Per clarification Q3=A — mirrors the workspace-format schema's top-level `branch` key so both formats read the same. |
| FR-003 | When no branch is explicitly resolved from flag, env, or config, `setup workspace` MUST NOT switch an existing checkout's branch. It updates the repo on its current branch (`git pull` against the current branch). For non-standard checkout states (detached HEAD, branch with no matching `origin/<branch>`): fetch only, skip pull, log a `warn`, and report the repo as successful — setup must never mutate a checkout it has no opinion about. | P1 | "Leave an already-correct working tree alone." Non-standard-state handling per clarification Q5=A. |
| FR-004 | When no branch is explicitly resolved, cloning a new repo MUST use the repo's default branch (clone without `--branch`). | P1 | Existing fallback path at `workspace.ts:236` becomes the primary path for the no-preference case. |
| FR-005 | Existing precedence for explicit sources MUST be preserved: `--branch` flag → `REPO_BRANCH` → `DEFAULT_BRANCH` → config branch. When one of these names a branch, current clone/switch behavior is unchanged. | P1 | US3. |
| FR-006 | The resolved branch decision (source and value, or "repo default / current branch") MUST be visible in the existing "Configuration" log line so operators can diagnose branch selection from logs. | P2 | The finetooth incident was diagnosed from exactly this line. |
| FR-007 | The `REPOS` env var path (no config file) MUST keep working; with no branch source at all it falls under FR-003/FR-004 no-preference behavior rather than defaulting to `develop`. No dedicated operator notice for the behavior change — the FR-006 "Configuration" log line is the sufficient signal. | P2 | Behavior change: the final `?? 'develop'` literal in `workspace.ts:111` is removed. No-notice decision per clarification Q4=A. See Assumptions. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Finetooth regression: repo pre-cloned at `main`, template config without branch key, `setup workspace` run | Repo remains on `main`; `.generacy/config.yaml` present afterward; second run succeeds | Integration test driving `cloneOrUpdateRepo`/`setup workspace` against a local fixture repo whose default branch is `main` |
| SC-002 | Config-declared branch honored | Template config with `branch: my-branch` → clone at `my-branch`, existing checkout switched to `my-branch` | Unit test on `convertTemplateConfig` + workspace resolution test |
| SC-003 | Precedence preserved | Flag > `REPO_BRANCH` > `DEFAULT_BRANCH` > config, each covered | Unit tests over the resolution function |
| SC-004 | No hardcoded `'develop'` branch literal remains in `packages/config/src/convert-template.ts`, in `WorkspaceConfigSchema.branch` (`packages/config/src/workspace-schema.ts`), or as a final fallback in workspace branch resolution | 0 occurrences | grep + code review |

## Assumptions

- The GitHub API default-branch lookup suggested in the issue is NOT required: cloning without `--branch` and leaving existing checkouts alone achieves the same outcome without a network dependency or auth requirement in `setup workspace`. (Confirmed at clarify, Q2=A.)
- Per-repo branch resolution (dev/clone repos differing from the primary) is deferred; branch remains workspace-wide. The no-preference behavior (FR-003/FR-004) already lets each repo land on its own default branch, which covers the common per-repo divergence case.
- Removing the final `'develop'` literal fallback (FR-007) is acceptable: consumers that need `develop` either have it as the repo default branch or can declare it via config/env. Existing generacy-ai clusters set no `REPO_BRANCH` and rely on `develop` being the actual default branch of their repos, so behavior is unchanged for them.
- `WorkspaceConfig.branch` becoming optional touches other consumers of `WorkspaceConfig` (e.g. `packages/config` readers, orchestrator `resolveSiblingWorkdirs`); plan phase must audit those call sites.
- Repairing already-damaged clusters (restoring a deleted `.generacy/config.yaml`) is a manual/ops concern, not part of this fix.

## Out of Scope

- Fixing the unrelated-histories condition between `develop` and `main` in affected repos (tracked as generacy-ai/generacy-cloud#909).
- Per-repo branch configuration keys in the template or workspace schema.
- Querying the GitHub API for a repo's default branch.
- Changes to the post-activation entrypoint scripts (cluster-base repo) that clone the primary.
- `git pull`/fetch conflict handling beyond current behavior.

---

*Generated by speckit*

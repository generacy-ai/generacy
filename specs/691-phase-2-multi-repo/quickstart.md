# Quickstart: Phase 2 Multi-Repo — Cross-Repo Change Fan-Out

## Prerequisites

- Phase 1 (#687) merged — `siblingWorkdirs` populated in `ActionContext`
- Issue C (#689) merged — `LinkedPR` type and `addLinkedPR` helper
- Issue D (#690) merged — `phaseAfterHandlers` API for registration
- Multi-repo workspace configured in `.agency/config.yaml` with `repos:` section

## How It Works

After each workflow phase completes, the sibling fan-out handler automatically:

1. Checks each sibling repo for changes (dirty working tree or unpushed commits)
2. Creates a matching branch in the sibling repo
3. Commits and pushes the changes
4. Opens a draft PR with a cross-repo `Closes` reference
5. Records the PR in `WorkflowState.linkedPRs`

## Workspace Configuration

```yaml
# .agency/config.yaml
workspace:
  org: generacy-ai
  repos:
    - name: generacy
      monitor: true
    - name: generacy-cloud
      monitor: true
    - name: cluster-base
      monitor: true
```

## Expected Behavior

### Single Workflow, Multiple Repos

When a workflow on issue `generacy#42` edits files in both `generacy` and `generacy-cloud`:

**Primary repo (generacy)**:
- Branch: `42-feature-name`
- PR: `Closes #42`

**Sibling repo (generacy-cloud)**:
- Branch: `42-feature-name` (matching)
- Draft PR: `Closes generacy-ai/generacy#42` (cross-repo reference)

### Idempotent Re-runs

Re-running a phase after a partial failure:
- Already-pushed siblings: detected via `branchExists` + `findPRForBranch` → skipped
- Previously-failed siblings: re-attempted normally
- `linkedPRs`: de-duplicated via `addLinkedPR` (repo+number key)

## Troubleshooting

### "Push failed" error

The handler fails loud on push errors. Check:
- GitHub token has write access to the sibling repo
- No branch protection rules blocking direct pushes to the feature branch

### Sibling not detected

- Verify the sibling directory exists at the expected path (typically `/workspaces/<repo-name>`)
- Check `.agency/config.yaml` lists the repo in `workspace.repos`
- Confirm Phase 1 resolved it via `resolveSiblingWorkdirs` (check orchestrator logs)

### No PR created but branch pushed

The handler skips PR creation if a PR already exists on the branch. Check `gh pr list --head <branch>` in the sibling repo.

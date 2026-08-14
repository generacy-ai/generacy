# Quickstart: workspace branch resolution (#1088)

## What changed

`generacy setup workspace` no longer assumes `develop`. When no branch is configured anywhere, it:

- leaves existing checkouts on their current branch (updates via `git pull` on that branch), and
- clones new repos without `--branch`, landing on the repo's default branch.

Explicit sources keep their exact precedence and behavior: `--branch` flag > `REPO_BRANCH` > `DEFAULT_BRANCH` > config `branch` key.

## Declaring a branch in config

Template format (`.generacy/config.yaml`) — new optional top-level `branch:`:

```yaml
branch: main
project:
  org_name: Painworth
repos:
  primary: finetooth
```

Workspace format:

```yaml
workspace:
  org: Painworth
  branch: main
  repos:
    - name: finetooth
```

Omit the key entirely for "use each repo's default / current branch". An empty string is a validation error.

## Env / flag usage (unchanged precedence)

```bash
generacy setup workspace --branch feature/x     # highest precedence
REPO_BRANCH=main generacy setup workspace       # beats DEFAULT_BRANCH and config
DEFAULT_BRANCH=main generacy setup workspace    # beats config
```

## Reading the logs

The `Configuration` line now shows the branch decision and where it came from:

```
Configuration  org: "Painworth"  branch: "main"  branchSource: "config file"  repos: 1  source: "config file"
Configuration  org: "Painworth"  branch: "(repo default / current branch)"  branchSource: "none"  ...
```

In no-preference mode you will never see a `Switching branch` line. A `warn` per repo appears for checkouts setup won't touch (detached HEAD, or a branch with no matching `origin/<branch>`); those repos still count as successful and are only fetched.

## Behavior change to be aware of

Previously, with no flag/env/config branch, setup fell back to the literal `develop`. That fallback is removed. If your automation relied on it, either set `branch: develop` in config or export `REPO_BRANCH=develop`. Repos whose default branch *is* `develop` see no change.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Repo updated but not switched to the branch you expected | No explicit branch resolved (`branchSource: "none"`) | Declare `branch:` in config or set `REPO_BRANCH`/`--branch` |
| `warn` about detached HEAD / missing remote branch | Checkout is in a non-standard state; setup won't guess | Manually `git checkout <branch>`; setup will pull it next run |
| Config parse error on `branch` | Empty string or non-string value | Use a non-empty string or remove the key |
| Cluster that already deleted its `.generacy/config.yaml` (pre-fix damage) | finetooth-class incident before this fix | Manual repair: restore the file from the repo's default branch (`git checkout origin/<default> -- .generacy/config.yaml`) — out of scope for the fix itself |

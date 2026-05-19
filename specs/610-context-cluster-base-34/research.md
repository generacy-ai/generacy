# Research: Fix vscode-cli volume mount path

## Problem

VS Code CLI (`code` 1.95.3) writes tunnel auth tokens to `~/.vscode/cli/`, not `~/.vscode-cli/`. The scaffolder creates a named volume at the wrong path, so auth is stored on the container's overlay filesystem and lost on `docker compose down && up`.

## Discovery

cluster-base#34 identified and fixed this in the devcontainer compose. The launch CLI scaffolder was not updated in that PR because it's in a different repo.

## Decision

Match the cluster-base#34 fix exactly:
- Volume name: `vscode-cli-state` (renamed to avoid confusion with the old, unused volume)
- Mount path: `/home/node/.vscode/cli` (where `code` 1.95.3 actually writes)

No alternatives considered — this is a direct alignment fix, not a design decision.

## References

- cluster-base#34 (canonical fix)
- VS Code CLI 1.95.3 source: auth tokens stored under `$HOME/.vscode/cli/`

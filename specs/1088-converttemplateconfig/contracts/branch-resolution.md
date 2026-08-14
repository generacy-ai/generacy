# Contract: Branch resolution & `cloneOrUpdateRepo` behavior

Governs `packages/generacy/src/cli/commands/setup/workspace.ts`. Test suites for SC-001/SC-002/SC-003 assert against this table.

## 1. Resolution chain (FR-005, FR-007)

First defined value wins; the chain has **no terminal literal**:

| Tier | Source | `branchSource` value |
|------|--------|----------------------|
| 1 | `--branch` CLI flag | `'CLI flag'` |
| 2 | `REPO_BRANCH` env var | `'REPO_BRANCH env'` |
| 3 | `DEFAULT_BRANCH` env var | `'DEFAULT_BRANCH env'` |
| 4 | config `branch` key (template top-level `branch:` via `convertTemplateConfig`, or workspace-format `workspace.branch`) | `'config file'` |
| — | nothing resolved | `'none'`, `branch = undefined` |

The `REPOS` env path (no config file) resolves tiers 1–3 only; with none set it lands on `'none'` (FR-007 — previously `'develop'`).

## 2. `cloneOrUpdateRepo` decision matrix

### Mode A — explicit branch (`branch !== undefined`) — behavior unchanged (US3)

| Repo state | Actions |
|------------|---------|
| Existing checkout, current branch == target | `git fetch origin` → `git pull origin <target>` |
| Existing checkout, current branch != target (incl. detached HEAD — `--show-current` empty ≠ target) | fetch → log "Switching branch" → `git checkout <target>` (fallback `git checkout -b <target> origin/<target>`) → pull |
| New repo | `git clone --branch <target> <url>`; on failure log "Branch not found, cloning default branch" → plain `git clone` fallback |
| Clone fails both ways | log error, return `false` |

### Mode B — no preference (`branch === undefined`) — NEW (FR-003, FR-004, Q5=A)

| Repo state | Actions | Result |
|------------|---------|--------|
| Existing checkout, on branch `<b>` with `refs/remotes/origin/<b>` present after fetch | `git fetch origin` → `git pull origin <b>` | `true` |
| Existing checkout, detached HEAD (`git branch --show-current` → empty) | `git fetch origin` only; `logger.warn({ repo }, …)` | `true` |
| Existing checkout, on branch `<b>` with **no** `refs/remotes/origin/<b>` (probe: `git rev-parse --verify --quiet refs/remotes/origin/<b>`) | `git fetch origin` only; `logger.warn({ repo, branch: <b> }, …)` | `true` |
| New repo | plain `git clone <url> <target>` directly (no `--branch` attempt) | `true` / `false` on clone failure |

**Hard invariants (Mode B)**:
- Zero `git checkout` / `git checkout -b` invocations — no "Switching branch" log line ever (SC-001).
- The two non-standard states report **success** — setup never mutates or fails a checkout it has no opinion about (Q5=A).
- `--clean` semantics unchanged: `git reset --hard HEAD` + `git clean -fd` still run when requested (resets content, not branch).
- Pull failure remains best-effort (result unchecked), matching current behavior in both modes.

## 3. Logging contract (FR-006)

| Line | Explicit branch | No preference |
|------|-----------------|---------------|
| `Configuration` (startup) | `{ org, branch: <value>, branchSource: <tier>, repos, source }` | `{ org, branch: '(repo default / current branch)', branchSource: 'none', repos, source }` |
| `Cloning repository` (per new repo) | `{ repo, branch: <value> }` | `{ repo, branch: '(repo default)' }` |
| `Switching branch` (per existing repo) | emitted only when actually switching | **never emitted** |
| Non-standard-state `warn` | n/a | one `warn` per affected repo (detached HEAD / missing remote branch) |

## 4. Config file surfaces (FR-002)

Template format — new optional top-level key:

```yaml
# .generacy/config.yaml (template format)
branch: main            # optional; omit for "no preference"
project:
  org_name: Painworth
repos:
  primary: finetooth
  dev: []
  clone: []
```

Workspace format — existing key, now with no implicit default:

```yaml
workspace:
  org: Painworth
  branch: main          # optional; omit for "no preference"
  repos:
    - name: finetooth
```

Validation: `branch`, when present in either format, must be a non-empty string; empty string is a parse error.

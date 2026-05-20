# Implementation Plan: Fix stale @latest npm dist-tag

**Feature**: Advance `@latest` dist-tag for all `@generacy-ai/*` packages on stable release
**Branch**: `671-problem-most-generacy-ai`
**Status**: Complete

## Summary

The `@latest` npm dist-tag for most `@generacy-ai/*` packages is stuck on March 2026 preview snapshots because the release workflow publishes with `--tag stable` but never advances `@latest`. The fix is a two-part change to `.github/workflows/release.yml`:

1. **Replace** the existing single-package `Add @stable dist-tag` step (lines 55-67) with a new step that loops over all published packages and runs `npm dist-tag add <pkg>@<version> latest`.
2. **One-time manual cleanup** to advance `@latest` for the ~16 currently-stale packages.

No application code changes. No new dependencies. No tests (CI workflow logic verified by post-merge `npm view` checks).

## Technical Context

**Language/Version**: GitHub Actions YAML, bash, jq
**Primary Dependencies**: `changesets/action@v1`, `npm` CLI, `jq`
**Storage**: N/A
**Testing**: Manual verification via `npm view @generacy-ai/<pkg> dist-tags`
**Target Platform**: GitHub Actions `ubuntu-latest` runner
**Project Type**: CI/CD workflow
**Performance Goals**: N/A
**Constraints**: Must not break existing `@stable` or `@preview` dist-tag behavior
**Scale/Scope**: 1 workflow file, ~16 npm packages affected

## Constitution Check

No `.specify/memory/constitution.md` found. No gates to check.

## Project Structure

### Documentation (this feature)

```text
specs/671-problem-most-generacy-ai/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Dist-tag behavior analysis
├── quickstart.md        # Verification & manual cleanup steps
└── conversation-log.jsonl
```

### Source Code (repository root)

```text
.github/workflows/
├── release.yml                  # MODIFIED: replace @stable step with @latest advancement loop
└── publish-preview.yml          # UNCHANGED: continues using --tag preview (no @latest touch)
```

**Structure Decision**: Single workflow file modification. No new files created.

## Implementation Steps

### Step 1: Modify `release.yml` — Replace single-package `@stable` step

**File**: `.github/workflows/release.yml` (lines 55-67)

**Current** (lines 55-67):
```yaml
- name: Add @stable dist-tag
  if: steps.changesets.outputs.published == 'true'
  run: |
    VERSION=$(echo '${{ steps.changesets.outputs.publishedPackages }}' \
      | jq -r '.[] | select(.name == "@generacy-ai/generacy") | .version')
    if [ -n "$VERSION" ]; then
      echo "Adding @stable dist-tag for @generacy-ai/generacy@$VERSION"
      npm dist-tag add @generacy-ai/generacy@$VERSION stable
    else
      echo "Package @generacy-ai/generacy not in published set, skipping"
    fi
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Replace with**:
```yaml
- name: Advance @latest dist-tag for all stable releases
  if: steps.changesets.outputs.published == 'true'
  run: |
    echo '${{ steps.changesets.outputs.publishedPackages }}' \
      | jq -r '.[] | "\(.name) \(.version)"' \
      | while read name version; do
          echo "Setting $name@$version as @latest"
          npm dist-tag add "$name@$version" latest
        done
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Rationale**:
- `pnpm changeset publish --tag stable` already sets `@stable` on every published package, making the old single-package `Add @stable dist-tag` step redundant (FR-002).
- The new step loops over ALL published packages from `changesets/action` output and advances `@latest` for each (FR-001).
- Preview workflow is NOT modified — it continues using `--tag preview` and never touches `@latest` (US2).

### Step 2: One-time manual cleanup (post-merge)

After the workflow fix merges to `main` and the next stable release runs, manually fix the currently-stale tags for all ~16 packages. This is a manual step, not automated — it only needs to run once.

```bash
for pkg in generacy orchestrator workflow-engine knowledge-store cluster-relay \
           control-plane credhelper credhelper-daemon activation-client config \
           generacy-plugin-claude-code generacy-plugin-cloud-build \
           generacy-plugin-copilot generacy-plugin-github-actions \
           generacy-plugin-github-issues generacy-plugin-jira; do
  stable=$(npm view @generacy-ai/$pkg dist-tags.stable)
  echo "Setting @generacy-ai/$pkg@$stable as @latest"
  npm dist-tag add @generacy-ai/$pkg@$stable latest
done
```

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `publishedPackages` output format changes | Low | Medium | JSON format is stable in `changesets/action@v1`; jq parse will fail visibly |
| `NPM_TOKEN` lacks dist-tag permissions | Low | High | Same token already used for publish; dist-tag requires same permissions |
| jq not available on runner | None | High | `jq` is pre-installed on `ubuntu-latest` |
| Partial loop failure (some packages tagged, others not) | Low | Low | `npm dist-tag add` is idempotent; re-run is safe |

## Verification Plan

1. After merge to `main`, trigger a stable release (or wait for next changeset-driven release)
2. Check CI logs for the new step's output: each package should print "Setting ... as @latest"
3. For each published package, verify: `npm view @generacy-ai/<pkg> dist-tags` shows `@latest` matching `@stable`
4. Verify preview publishes still only set `@preview` (no `@latest` change)

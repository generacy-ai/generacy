# Fix stale @latest npm dist-tag for @generacy-ai/* packages

**Branch**: `671-problem-most-generacy-ai` | **Date**: 2026-05-20 | **Status**: Draft

## Summary

The `@latest` npm dist-tag for most `@generacy-ai/*` packages is stuck on March 2026 preview snapshots. Anyone running `npm install @generacy-ai/<pkg>` without an explicit tag gets an outdated preview instead of the current 0.1.x stable release. The release workflow publishes with `--tag stable` but never advances `@latest`.

## Problem

`npm install` defaults to `@latest`. For all published `@generacy-ai/*` packages, `@latest` points at `0.0.0-preview-*` snapshots from March/May 2026, while `@stable` correctly points at the current `0.1.x` releases. This means:

- Doc snippets, READMEs, and any `npm install @generacy-ai/generacy` without `@stable` are broken
- The cloud launch-claim flow is safe (pins `@stable`), but all other install paths are affected

### Root cause

`.github/workflows/release.yml:47` uses `pnpm changeset publish --tag stable`, which sets only the `@stable` dist-tag. It never advances `@latest`. The preview workflow similarly uses `--tag preview`.

## User Stories

### US1: Default npm install gets current stable

**As a** developer installing a Generacy package,
**I want** `npm install @generacy-ai/<pkg>` to resolve to the latest stable version,
**So that** I get a working, current release without needing to know about dist-tag conventions.

**Acceptance Criteria**:
- [ ] After a stable release, `@latest` points at the same version as `@stable` for every published package
- [ ] `npm install @generacy-ai/generacy` resolves to `>= 0.1.x` (not a `0.0.0-preview-*` snapshot)

### US2: Preview releases don't hijack @latest

**As a** release engineer,
**I want** preview publishes to NOT advance `@latest`,
**So that** only stable releases are the default install target.

**Acceptance Criteria**:
- [ ] The preview workflow (`publish-preview.yml`) continues to use `--tag preview` and does not touch `@latest`
- [ ] `@latest` is only advanced by the stable release workflow

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add a step to `release.yml` that advances `@latest` for every published package after `changeset publish` | P0 | Loop over `steps.changesets.outputs.publishedPackages` |
| FR-002 | Remove or generalize the single-package `Add @stable dist-tag` step (lines 55-67) | P1 | Redundant: `--tag stable` already sets `@stable` on all packages |
| FR-003 | One-time manual `npm dist-tag add` to fix currently-stale `@latest` tags | P0 | Must run after workflow fix lands; affects ~16 packages |

## Proposed Changes

### 1. `release.yml` workflow fix

Replace the existing single-package `Add @stable dist-tag` step (lines 55-67) with a step that advances `@latest` for **all** published packages:

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

The existing `Add @stable dist-tag` block can be removed because `pnpm changeset publish --tag stable` already sets `@stable` on every published package.

### 2. One-time manual cleanup

After the workflow fix merges, manually advance `@latest` for all affected packages:

```bash
for pkg in generacy orchestrator workflow-engine knowledge-store cluster-relay \
           control-plane credhelper credhelper-daemon activation-client config \
           generacy-plugin-claude-code generacy-plugin-cloud-build \
           generacy-plugin-copilot generacy-plugin-github-actions \
           generacy-plugin-github-issues generacy-plugin-jira; do
  stable=$(npm view @generacy-ai/$pkg dist-tags.stable)
  npm dist-tag add @generacy-ai/$pkg@$stable latest
done
```

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `@latest` matches `@stable` for all published packages | 100% | `npm view @generacy-ai/<pkg> dist-tags` for each package |
| SC-002 | Next stable release auto-advances `@latest` | All published packages | Verify via CI logs + `npm view` after release |
| SC-003 | Preview releases do NOT touch `@latest` | No `@latest` change | `npm view` before/after preview publish |

## Assumptions

- `pnpm changeset publish --tag stable` already correctly sets `@stable` on every published package (confirmed by current behavior)
- The `publishedPackages` output from `changesets/action@v1` includes all packages that were published in the run
- `jq` is available on the `ubuntu-latest` runner (it is)
- `NPM_TOKEN` has permission to set dist-tags on all `@generacy-ai/*` packages

## Out of Scope

- Changing the preview workflow's dist-tag behavior (preview should NOT advance `@latest`)
- Changing the changeset publish command itself (keeping `--tag stable`)
- The `workspace:^` leak issue (#669) — independent bug, separate fix

## Related Issues

- #656 — wired `@stable` dist-tag (landed). This issue is the natural follow-up.
- #669 — `workspace:^` leak in orchestrator. Independent bug, may land in the same release cycle.

---

*Generated by speckit*

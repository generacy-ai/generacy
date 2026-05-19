# Tasks: Publish @stable dist-tag on release to main

**Input**: Design documents from `/specs/656-problem-release-workflow/`
**Prerequisites**: plan.md (required), spec.md (required), research.md (available)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Implementation

- [ ] T001 [US1] Add stable dist-tag step to `.github/workflows/release.yml`
  - Insert a new step after the `changesets` step (after line 52) and before the `publish-devcontainer-feature` job
  - Guard on `if: steps.changesets.outputs.published == 'true'`
  - Extract version from `steps.changesets.outputs.publishedPackages` using `jq`:
    ```bash
    VERSION=$(echo '${{ steps.changesets.outputs.publishedPackages }}' \
      | jq -r '.[] | select(.name == "@generacy-ai/generacy") | .version')
    ```
  - Skip gracefully if `VERSION` is empty (package not in published set)
  - Run `npm dist-tag add @generacy-ai/generacy@$VERSION stable`
  - Set `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` in step env

## Phase 2: Verification

- [ ] T002 [US1] Verify workflow YAML syntax
  - Validate that the modified `release.yml` is valid YAML (no parse errors)
  - Confirm the new step is correctly indented under the `release` job's `steps` list
  - Confirm `publish-devcontainer-feature` job's `if` condition is unaffected

- [ ] T003 [US2] Verify dist-tag behavior (manual, post-merge)
  - After first merge to `main` that triggers a Changesets publish, run:
    - `npm view @generacy-ai/generacy dist-tags` — confirm `stable` and `latest` both present
    - `npm view @generacy-ai/generacy@stable version` — confirm it matches `@latest`
    - `npm view @generacy-ai/generacy@preview version` — confirm unchanged

## Dependencies & Execution Order

```
T001 → T002 → T003
```

- **T001**: Core implementation — single step addition to release.yml
- **T002**: Syntax validation — depends on T001 completion
- **T003**: Manual post-merge verification — can only run after the workflow executes on a real `main` push; not automatable in CI

**Parallel opportunities**: None — this is a sequential 3-task chain on a single file. T003 is a manual verification gate that runs after the first real release.

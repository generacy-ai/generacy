# Research: npm dist-tag behavior and release workflow

## Problem Analysis

### How npm dist-tags work

- `npm publish --tag <tag>` sets ONLY the specified dist-tag for the published version. It does NOT touch `@latest`.
- `npm publish` (no `--tag`) sets `@latest` automatically.
- `npm dist-tag add <pkg>@<version> <tag>` sets any dist-tag independently, post-publish.
- `npm install <pkg>` resolves `@latest` by default.
- `npm install <pkg>@stable` resolves `@stable` explicitly.

### Current workflow behavior

| Workflow | Command | Tags set | `@latest` advanced? |
|----------|---------|----------|---------------------|
| `release.yml` | `pnpm changeset publish --tag stable` | `@stable` | No |
| `publish-preview.yml` | `pnpm publish --tag preview` | `@preview` | No |

Because neither workflow publishes without `--tag`, `@latest` was last set during the initial March 2026 preview publishes (which used `npm publish` without `--tag` or with `--tag latest`).

### Why `@stable` step is redundant

Line 47: `pnpm changeset publish --tag stable --provenance` already sets `@stable` on every package it publishes. The explicit `Add @stable dist-tag` step (lines 55-67) only targets `@generacy-ai/generacy` — it's both redundant (changeset already did it) and incomplete (misses all other packages).

## Alternatives Considered

### Option A: Change publish command to `--tag latest` + explicit `@stable` post-step
- `pnpm changeset publish --tag latest --provenance` + loop `npm dist-tag add ... stable`
- Rejected: More complex, and `--tag stable` is the semantic intent (we want stable releases to be the `@stable` tag natively)

### Option B: Publish without `--tag` (uses `@latest` by default) + explicit `@stable` post-step
- `pnpm changeset publish --provenance` + loop `npm dist-tag add ... stable`
- Rejected: Requires maintaining an explicit `@stable` loop. Current approach of `--tag stable` is cleaner.

### Option C (chosen): Keep `--tag stable` + add `@latest` advancement post-step
- `pnpm changeset publish --tag stable --provenance` (unchanged) + loop `npm dist-tag add ... latest`
- Pros: Minimal change, `@stable` is set natively, `@latest` is an explicit post-step
- Cons: One extra step, but it's simple and self-documenting

## Key Decision

**Use Option C**: Keep the existing publish command unchanged (`--tag stable`) and add a post-publish step that advances `@latest` for all published packages. This is the minimal change with the lowest risk.

## Implementation Pattern

The `changesets/action@v1` outputs `publishedPackages` as a JSON array:
```json
[{"name": "@generacy-ai/generacy", "version": "0.1.4"}, ...]
```

Parse with `jq`, loop with `while read`, call `npm dist-tag add` for each. This is the same pattern used by the existing (redundant) `@stable` step, just generalized to all packages and targeting `@latest`.

## References

- npm dist-tag docs: https://docs.npmjs.com/cli/v10/commands/npm-dist-tag
- changesets/action outputs: https://github.com/changesets/action#outputs
- Issue #656: wired `@stable` dist-tag (predecessor to this fix)

# Research: Publish @stable dist-tag on release to main

**Feature**: #656 | **Date**: 2026-05-19

## Changesets Action Output Format

The `changesets/action@v1` exposes two key outputs:

- `published`: `'true'` or `'false'` string
- `publishedPackages`: JSON array string, e.g.:
  ```json
  [{"name": "@generacy-ai/generacy", "version": "1.2.3"}, {"name": "@generacy-ai/credhelper", "version": "0.5.0"}]
  ```

These are set via `core.setOutput()` in the action. The `publishedPackages` output is only present when `published == 'true'`.

## npm dist-tag Behavior

- `npm publish` with no `--tag` flag advances `@latest` (this is npm's default)
- `npm dist-tag add <pkg>@<version> <tag>` adds/moves a named tag to a specific version
- Tags are atomic and idempotent — re-running with the same version is a no-op
- `npm dist-tag add` requires authentication (same token scope as publish)
- Multiple tags can point to the same version (e.g., `@latest` and `@stable` both pointing to `1.2.3`)

## Current dist-tag State

```
preview: 0.0.0-preview-20260519033506
```

After this change, a release will produce:
```
latest: 1.2.3
stable: 1.2.3
preview: 0.0.0-preview-20260519033506
```

## Alternatives Considered

### Option 1: Post-publish `npm dist-tag add` (CHOSEN)

- Publish happens normally (Changesets action, `@latest` advanced)
- New step runs `npm dist-tag add @generacy-ai/generacy@<version> stable`
- Pros: No change to existing publish behavior, additive only
- Cons: Extra npm API call (negligible)

### Option 2: Publish with `--tag stable`

- Change Changesets publish command to use `--tag stable`
- Pros: Single operation
- Cons: `@latest` would NOT be advanced (npm only advances `@latest` when no `--tag` is specified). Would break `npx @generacy-ai/generacy` (which resolves `@latest`).

### Option 3: Separate workflow job

- New job `tag-stable` that depends on `release`
- Pros: Clean separation
- Cons: Requires re-checkout, re-setup-node, re-auth — wasteful for a single command. Version must be passed via job outputs.

## jq Availability

`jq` is pre-installed on `ubuntu-latest` GitHub Actions runners. No additional setup needed.

## Authentication

The `NODE_AUTH_TOKEN` environment variable (set to `secrets.NPM_TOKEN`) is consumed by the `.npmrc` written by `actions/setup-node` with `registry-url`. This same token is valid for `npm dist-tag add` operations.

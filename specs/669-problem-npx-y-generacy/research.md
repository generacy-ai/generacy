# Research: Fix `workspace:^` leak in published orchestrator package

## Technology Decisions

### 1. `prepublishOnly` script approach

**Decision**: Use a plain Node.js script (`scripts/check-workspace-deps.js`) referenced from each package's `prepublishOnly` script.

**Alternatives considered**:
- **A: CI-only validation step in release.yml** — Would catch the issue in CI but not locally. Developers could still accidentally `pnpm publish` a broken package from their machine.
- **B: pnpm `publishConfig` overrides** — pnpm's `publishConfig` can override fields, but it doesn't provide a "reject if workspace: found" mechanism.
- **C: Custom Changesets plugin** — Over-engineered for this use case. Changesets plugins are for changelog/version customization, not publish-time validation.
- **D: Turborepo/nx publish pipeline** — Would require adding a new build orchestrator. Way out of scope.

**Why `prepublishOnly`**:
- npm lifecycle hook that runs **at the exact moment** of publish, before the tarball is created
- Works identically in local `pnpm publish` and CI `pnpm changeset publish`
- Zero runtime cost (only runs at publish time)
- Simple to implement (< 30 LOC)
- Well-documented npm lifecycle: `prepublishOnly` fires for `npm publish` and `pnpm publish`, but NOT for `npm install`

### 2. Shared script vs. inline check

**Decision**: Shared `scripts/check-workspace-deps.js` with relative path reference.

**Alternatives considered**:
- **Inline script in each package.json** — `"prepublishOnly": "node -e \"...\""` is fragile with escaping and hard to maintain across 15+ packages.
- **Root-level pnpm script** — `pnpm -r exec` could run a check, but `prepublishOnly` needs to be per-package to catch individual publishes.
- **Dedicated npm package** — Publishing a `@generacy-ai/publish-guard` is circular (it would need the same guard).

### 3. No changes to Changesets config

**Decision**: Keep `updateInternalDependencies: "patch"` and current Changesets config unchanged.

**Rationale**: The Changesets config is correct. The bug is in the publish step (workspace protocol rewrite), not in the version step. Changing `updateInternalDependencies` would mask the symptom, not fix the root cause. The `prepublishOnly` guardrail is the proper defense.

## Implementation Patterns

### prepublishOnly validation pattern

```js
// scripts/check-workspace-deps.js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
const depFields = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const violations = [];

for (const field of depFields) {
  const deps = pkg[field];
  if (!deps) continue;
  for (const [name, version] of Object.entries(deps)) {
    if (typeof version === 'string' && version.startsWith('workspace:')) {
      violations.push(`  ${field}.${name}: ${version}`);
    }
  }
}

if (violations.length > 0) {
  console.error(`ERROR: Found workspace: protocol in package.json`);
  console.error(`These should have been rewritten by pnpm before publish:\n`);
  violations.forEach(v => console.error(v));
  console.error(`\nThis usually means publish was not run from the workspace root.`);
  process.exit(1);
}
```

### Package.json script pattern

```json
{
  "scripts": {
    "prepublishOnly": "node ../../scripts/check-workspace-deps.js"
  }
}
```

The relative path `../../scripts/` is stable because:
- All publishable packages live at `packages/<name>/`
- The script lives at the repo root `scripts/`
- pnpm sets `cwd` to the package directory during `prepublishOnly`

## Key Sources

- [pnpm workspace protocol docs](https://pnpm.io/workspaces#publishing-workspace-packages) — pnpm rewrites `workspace:^` → `^X.Y.Z` during publish
- [npm lifecycle scripts](https://docs.npmjs.com/cli/v10/using-npm/scripts#life-cycle-scripts) — `prepublishOnly` runs before pack/publish
- [Changesets publish flow](https://github.com/changesets/changesets/blob/main/packages/cli/src/commands/publish/npm-utils.ts) — uses `npm publish` or `pnpm publish` internally
- [changesets/action@v1](https://github.com/changesets/action) — GitHub Action that runs version + publish

## Root Cause Deep Dive

The `workspace:` protocol is a pnpm feature. When `pnpm publish` runs, it rewrites `workspace:^` to `^<version>` in the tarball's `package.json`. This happens in pnpm's publish pipeline, not in Changesets.

`pnpm changeset publish` calls Changesets' publish logic, which in turn calls `pnpm publish` for each changed package. The rewrite should happen automatically.

Possible failure modes for orchestrator specifically:
1. **Race condition**: Orchestrator's deps weren't yet version-bumped when it was published (ordering issue in Changesets' publish sequence)
2. **Workspace context loss**: The `changesets/action` somehow lost workspace context for orchestrator specifically
3. **Selective pnpm bug**: A pnpm version-specific bug with `workspace:^` (not `workspace:*`) when many workspace deps exist

The `prepublishOnly` guard makes the root cause academic — regardless of what went wrong, the publish will be rejected if deps aren't rewritten.

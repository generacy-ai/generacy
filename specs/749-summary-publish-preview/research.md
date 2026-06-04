# Research: publish-preview hardening

## Decisions

### D1. SHA exposure: both version-string suffix AND `package.json#gitHead`

**Decision**: Append `-<sha7>` to the version string produced by
`changeset version --snapshot preview` AND write the full 40-char SHA to
`gitHead` and `generacy.sourceSha` in every published `package.json`.

**Rationale**: Clarification Q1=C. The version already carries a
timestamp suffix; the additional `-<sha7>` is a minor extension that
makes "which commit?" immediately human-visible via
`npm view <pkg>@preview version`. The full SHA in `package.json` is what
the staleness check reads (no short-SHA collision risk) and is the
conventional npm field that tools already look for.

**Alternatives considered**:
- Provenance metadata only (Q1 option D): rigorous but requires
  `npm view --json` + a GitHub attestation lookup. Adds ops friction
  for a one-line "which commit?" question.
- Version-suffix only (Q1 option A): hides the full SHA, forces the
  staleness check to disambiguate short SHAs across the entire repo
  history.
- `gitHead` only (Q1 option B): invisible to humans; would not catch
  the "version timestamp looks current but code is behind" smell that
  motivated this work.

**Key sources**:
- [npm: package.json gitHead](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#githead)
  — gitHead is NOT auto-populated by `changeset version --snapshot`
  (it's set by `npm publish` from a git tag, which snapshot mode
  bypasses). We must write it explicitly.
- [changesets snapshot docs](https://github.com/changesets/changesets/blob/main/docs/snapshot-releases.md)
- #744/#746 incident retro: `0.0.0-preview-20260603190235` shipped
  without `deriveTunnelName`.

### D2. Staleness comparison: strict ancestry

**Decision**: Refuse to publish when
`git merge-base --is-ancestor <candidate-sha> <current-preview-sha>` is true
AND `candidate-sha != current-preview-sha`.

**Rationale**: Clarification Q2=A. This enforces "only move forward,"
which is exactly the regression that motivated #749 (publishing a commit
that is behind the merged tip). Force-pushes and cherry-picks fall
outside the default contract — operators handle those with the explicit
`force_rollback=true` escape hatch (D5) rather than by weakening the
default to a softer timestamp check.

**Alternatives considered**:
- Timestamp comparison (committer date): robust to history rewrites but
  lets a force-pushed regression through silently.
- Equal-or-descendant on `develop` history: branch-safe variant; rejected
  because resolving "is X reachable on `develop`" requires fetching the
  full `develop` history and is slightly more brittle than ancestry.
- Simple SHA inequality only: trusts the trigger, which is the original
  bug. Rejected.

### D3. First-publish behavior: fail open

**Decision**: When `npm view <pkg>@preview gitHead` returns nothing
(no `@preview` tag, or it exists but lacks the field), publish
unconditionally. The publish establishes the baseline.

**Rationale**: Clarification Q3=A. Failing closed would block the very
first post-rollout publish and every registry-wipe/new-package case.
There is nothing to be stale against.

**Alternatives considered**:
- Refuse + manual bootstrap dispatch (Q3 option B): adds ceremony with
  no detectable safety win.
- Only auto-publish path is trusted (Q3 option C): unclear semantics
  for the rollback story (Q5=B).

### D4. Staleness failure mode: fail fast, no retry

**Decision**: When the staleness check trips, exit non-zero with a
clear message identifying both SHAs. Do not re-checkout, re-run, or
self-redispatch.

**Rationale**: Clarification Q4=A. Combined with D6 (build resolved
`origin/develop` HEAD), the staleness check only fires in genuine
history-rewrite / rollback scenarios — exactly when failing loudly is
correct. Retrying or self-redispatching would either thrash or mask a
real history problem.

**Alternatives considered**:
- In-job retry loop (Q4 option B): self-healing within a run but
  conflates "race we just fixed" with "history was rewritten."
- Self-redispatch (Q4 option C): adds API permission requirements and
  decouples observability from the original trigger.

### D5. Rollback escape hatch: `force_rollback: boolean` input

**Decision**: Add `force_rollback: boolean` input to `workflow_dispatch`
(default `false`). When `true`, log a clearly identifiable warning and
skip the staleness check. The `push: develop` trigger does not honor
this input.

**Rationale**: Clarification Q5=B. Gives operators a deliberate,
auditable escape hatch for legitimate rollback during incidents
without weakening the default guard. Force-push and cherry-pick
recoveries route through this same path.

**Alternatives considered**:
- No input (Q5 option A): forces a revert PR to `develop`, which is
  unacceptably slow during an incident.
- `target_sha` input (Q5 option C): doesn't actually enable rollback —
  the staleness guard would still refuse to go backward — so it solves
  a different problem (republishing the same SHA after a failed
  publish, which is rare).

### D6. Race defense: resolve `origin/develop` HEAD at build time

**Decision**: After `actions/checkout@v6` (which checks out the event
ref), explicitly `git fetch origin develop` and `git checkout
origin/develop` before any build step. Use the resolved SHA
(`git rev-parse HEAD`) for both build and metadata.

**Rationale**: This is the PRIMARY defense against the original race in
#744/#746. `actions/checkout` checks out the SHA the event was queued
against; if a merge lands between event-queue and job-start, that SHA
is already stale by the time we build. Resolving `origin/develop` at
build time closes that window. The staleness check (D2) then only
catches the residual edge cases (history rewrites, deliberate
rollback).

**Alternatives considered**:
- Rely on staleness check alone: would force `force_rollback=true` on
  every benign race, eroding the audit value of the warning.
- `actions/checkout@v6` with `ref: develop`: same effect as the default
  for `push: develop` events; doesn't help for `workflow_dispatch` (we
  want to track HEAD, not the dispatch ref).

### D7. Anchor package for "current preview SHA" lookup

**Decision**: Read `gitHead` from `npm view @generacy-ai/generacy@preview
gitHead`. All published packages share a `gitHead` per workflow run, so
any one is sufficient.

**Rationale**: `@generacy-ai/generacy` is the only package the project
treats as "always published, never private, never moved" — it's the CLI
entry point. Picking one anchor keeps the staleness check to a single
network round-trip.

**Alternatives considered**:
- Iterate all packages and require unanimity: ~16x slower, adds spurious
  failure modes (e.g., if a brand-new package was added on this run, it
  won't have a current `@preview` baseline yet — see D3).
- Use a sentinel "version-marker" package: would need a new private
  package just for this. Overkill.

### D8. Concurrency group: keep existing

**Decision**: Keep `concurrency: { group: ${{ github.workflow }},
cancel-in-progress: false }`. Do not add ref/SHA to the group.

**Rationale**: The existing group already serializes all preview
publishes, which is what we want: two concurrent publishes can't both
read `npm view` and both pass the staleness check against the same
baseline.

**Alternatives considered**:
- `cancel-in-progress: true`: would let `push: develop` events cancel
  an in-flight `workflow_dispatch` rollback. Wrong direction —
  rollbacks should not be cancelled.

## Implementation Patterns

### Stamping `gitHead` and version suffix

```js
// scripts/stamp-source-sha.mjs (sketch)
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
const short = sha.slice(0, 7);
const config = JSON.parse(readFileSync('.changeset/config.json', 'utf8'));
const ignore = new Set(config.ignore || []);

for (const dir of readdirSync('packages')) {
  const p = join('packages', dir, 'package.json');
  if (!existsSync(p)) continue;
  const pkg = JSON.parse(readFileSync(p, 'utf8'));
  if (pkg.private || !pkg.name || ignore.has(pkg.name)) continue;
  if (!pkg.version.endsWith(`-${short}`)) pkg.version = `${pkg.version}-${short}`;
  pkg.gitHead = sha;
  pkg.generacy = { ...(pkg.generacy ?? {}), sourceSha: sha };
  writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
}
```

### Staleness check

```js
// scripts/check-preview-staleness.mjs (sketch)
import { execSync } from 'node:child_process';

const anchor = '@generacy-ai/generacy';
const candidate = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();

let current = '';
try {
  current = execSync(`npm view ${anchor}@preview gitHead`, {
    encoding: 'utf8',
  }).trim();
} catch {
  // dist-tag may not exist yet — D3 fail-open
}

if (!current || !/^[0-9a-f]{40}$/.test(current)) {
  console.log(`No baseline gitHead for ${anchor}@preview — publishing unconditionally`);
  process.exit(0);
}

if (current === candidate) {
  console.log(`Candidate ${candidate} equals current preview ${current} — allowed (republish)`);
  process.exit(0);
}

try {
  execSync(`git merge-base --is-ancestor ${candidate} ${current}`, { stdio: 'ignore' });
  // exit 0 from is-ancestor === candidate IS an ancestor of current === stale
  console.error(`STALE: candidate ${candidate} is an ancestor of current preview ${current}`);
  console.error(`Refusing to publish. Set force_rollback=true to override.`);
  process.exit(1);
} catch {
  // non-zero from is-ancestor === candidate is NOT an ancestor === fresh
  process.exit(0);
}
```

### Workflow input gating

```yaml
on:
  push: { branches: [develop] }
  workflow_dispatch:
    inputs:
      force_rollback:
        description: 'Skip staleness guard for deliberate rollback.'
        type: boolean
        default: false
```

The staleness step uses `if: github.event.inputs.force_rollback != 'true'`
(workflow_dispatch input values arrive as strings) and the warning step
uses the inverse condition.

## Key Sources

- npm docs: [package.json fields](https://docs.npmjs.com/cli/v10/configuring-npm/package-json),
  [dist-tag](https://docs.npmjs.com/cli/v10/commands/npm-dist-tag).
- changesets: [snapshot releases](https://github.com/changesets/changesets/blob/main/docs/snapshot-releases.md).
- GitHub Actions: [workflow_dispatch inputs](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#workflow_dispatch).
- Existing patterns in this repo:
  - `scripts/verify-pack-no-workspace-deps.js` (Node ESM, `node:` builtins
    only, no deps).
  - `.github/workflows/publish-preview.yml` (current workflow).
  - `.changeset/config.json` (ignore list).
- Incident retro context: spec.md §Summary and §Impact; #744 (`deriveTunnelName`)
  and #746 (cloud-deployed cluster).

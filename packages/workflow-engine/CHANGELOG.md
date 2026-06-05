# @generacy-ai/workflow-engine

## 0.2.0

### Minor Changes

- 223d320: feat: cluster-side backstop for expired/near-expiry GH_TOKEN (#762)

  Detect an expired or near-expiry GitHub token and request a refresh instead of
  silently 401-looping. `workflow-engine` now surfaces `GhAuthError` and
  `parseGhStatusCode` so callers can distinguish auth failures, and the
  `orchestrator` adds a credential-expiry watcher plus GitHub auth-health state
  (exposed on the health route) so the label and PR-feedback monitors drive a
  credential-refresh request rather than repeatedly failing on 401s.

## 0.1.2

### Patch Changes

- e69ed75: Follow-up to the bulk worker-scale catch-up (#719). The orchestrator was bumped
  to 0.2.0 in that batch with `^0.1.1` pinning on `@generacy-ai/workflow-engine`,
  but workflow-engine itself wasn't bumped — leaving stable on 0.1.1 from May 20.
  The orchestrator's published 0.2.0 imports `FilesystemWorkflowStore` (added to
  `workflow-engine/src/index.ts`'s top-level re-exports in a later develop commit),
  so loading `@generacy-ai/orchestrator@0.2.0` against `workflow-engine@0.1.1`
  fails with:

      Failed to load @generacy-ai/orchestrator: The requested module
      '@generacy-ai/workflow-engine' does not provide an export named
      'FilesystemWorkflowStore'

  Patch bump (rather than minor) so the orchestrator's existing `^0.1.1` semver
  range picks up `0.1.2` automatically — no orchestrator re-publish needed.

  The broader process gap (per-PR changesets not enforced) is tracked in #720.

## 0.1.1

### Patch Changes

- 6779a85: Bulk patch bump to populate the `stable` npm dist-tag for the 14 packages that were left at 0.1.0 by the previous changeset cycle (which only listed `@generacy-ai/generacy` and `@generacy-ai/cluster-relay`).

  After this changeset is consumed by changesets/action and the resulting version-packages PR merges to main, all 16 public `@generacy-ai/*` packages in this repo will be on `stable` on npm.

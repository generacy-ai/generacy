# @generacy-ai/control-plane

## 0.2.0

### Minor Changes

- 95f3c52: Add `prepare-workspace` lifecycle action: a subset of `bootstrap-complete` that unseals whatever wizard credentials are currently stored and writes the post-activation sentinel, but **does not** start code-server or VS Code Tunnel. Intended for use by the wizard's GitHubAppInstall step so the cluster's workspace clone runs in parallel with the remaining wizard steps (peer-repos, app-config), making the app-config manifest available by the time the user reaches that wizard step. `bootstrap-complete` remains the action fired by ReadyStep at the end of the wizard.

## 0.1.1

### Patch Changes

- 6779a85: Bulk patch bump to populate the `stable` npm dist-tag for the 14 packages that were left at 0.1.0 by the previous changeset cycle (which only listed `@generacy-ai/generacy` and `@generacy-ai/cluster-relay`).

  After this changeset is consumed by changesets/action and the resulting version-packages PR merges to main, all 16 public `@generacy-ai/*` packages in this repo will be on `stable` on npm.

- Updated dependencies [6779a85]
  - @generacy-ai/credhelper@0.1.1

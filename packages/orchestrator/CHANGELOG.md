# Changelog

## 0.1.2

### Patch Changes

- 8b1a12d: Fix workspace:^ dependency leak in published package. Add prepublishOnly guardrail to all publishable packages to prevent future publishes with unresolved workspace: protocol specifiers.
- Updated dependencies [95f3c52]
  - @generacy-ai/control-plane@0.2.0

## 0.1.1

### Patch Changes

- 6779a85: Bulk patch bump to populate the `stable` npm dist-tag for the 14 packages that were left at 0.1.0 by the previous changeset cycle (which only listed `@generacy-ai/generacy` and `@generacy-ai/cluster-relay`).

  After this changeset is consumed by changesets/action and the resulting version-packages PR merges to main, all 16 public `@generacy-ai/*` packages in this repo will be on `stable` on npm.

- Updated dependencies [6779a85]
  - @generacy-ai/activation-client@0.1.1
  - @generacy-ai/config@0.1.1
  - @generacy-ai/control-plane@0.1.1
  - @generacy-ai/credhelper@0.1.1
  - @generacy-ai/generacy-plugin-claude-code@0.1.1
  - @generacy-ai/workflow-engine@0.1.1

All notable changes to the `@generacy-ai/orchestrator` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Automatic PR ready-for-review marking: When the orchestrator workflow completes successfully (all phases done), the draft PR is now automatically marked as ready for review. This eliminates the need for manual intervention and ensures reviewers are notified immediately upon completion.
  - Added `PrManager.markReadyForReview()` method to convert draft PRs to ready state
  - Integrated with workflow completion flow in `claude-cli-worker.ts`
  - Idempotent operation: safely handles non-draft PRs without errors

### Changed

- Updated workflow completion behavior to transition PRs from draft to ready state automatically

## [0.1.0] - Initial Release

### Added

- Initial release of the orchestrator package
- Multi-phase workflow execution: specify → clarify → plan → tasks → implement → validate
- GitHub integration with draft PR creation and management
- Label-based workflow state tracking
- SSE-based progress reporting

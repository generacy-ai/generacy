# Changelog

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

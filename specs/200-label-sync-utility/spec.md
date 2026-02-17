# Feature: Label Sync Utility for Watched Repositories

**Issue**: [#200](https://github.com/generacy-ai/generacy/issues/200)
**Parent Epic**: [#195 - Implement label-driven orchestrator package](https://github.com/generacy-ai/generacy/issues/195)
**Status**: Draft

## Overview

Implement a label sync utility within the orchestrator package that creates and updates the full set of label protocol labels on all configured ("watched") repositories. This ensures every repository managed by the orchestrator has the correct set of workflow labels with consistent names, colors, and descriptions.

## Context

The orchestrator relies on a label-driven workflow protocol where GitHub issue labels control the state machine (phases, gates, agent status). For this to work, every watched repository must have all required labels pre-provisioned. Currently, the `SyncLabelsAction` in `@generacy-ai/workflow-engine` handles label sync for a single repository as a workflow action. The `LabelOperations` class in `@generacy-ai/github-issues` provides the low-level GitHub API layer.

This feature lifts label sync to the orchestrator level, adding:
- Multi-repository support via a "watched repos" configuration
- Automatic execution on orchestrator startup
- Automatic execution when a new repo is added to configuration
- Proper rate limit handling for GitHub API across multiple repos

## User Stories

1. **As an orchestrator operator**, I want labels to be automatically synced on startup so that new deployments are immediately ready for workflow processing.
2. **As an orchestrator operator**, I want to add a new repository to the watched list and have its labels provisioned automatically so I don't need to run a manual setup script.
3. **As an orchestrator operator**, I want the sync to be idempotent so I can run it repeatedly without side effects or errors.

## Existing Code

| Component | Package | Path |
|-----------|---------|------|
| `SyncLabelsAction` | `@generacy-ai/workflow-engine` | `packages/workflow-engine/src/actions/github/sync-labels.ts` |
| `LabelOperations` | `@generacy-ai/github-issues` | `packages/github-issues/src/operations/labels.ts` |
| `WORKFLOW_LABELS` | `@generacy-ai/workflow-engine` | `packages/workflow-engine/src/actions/github/sync-labels.ts` (lines 30-79) |
| Orchestrator config | `@generacy-ai/orchestrator` | `packages/orchestrator/src/config/schema.ts` |

The `WORKFLOW_LABELS` array defines 32 labels across 6 categories: phase (6), waiting-for (10), completed (13), issue type (3), agent (3), needs (2).

## Functional Requirements

### FR-1: Watched Repositories Configuration
- Add a `repositories` section to the orchestrator configuration schema
- Each entry specifies `owner` and `repo` (or `owner/repo` shorthand)
- Support environment variable override for the repository list

### FR-2: Label Definition Registry
- Extract the canonical label definitions from `WORKFLOW_LABELS` into a shared, importable module
- The orchestrator's label sync utility should reference this single source of truth
- Additional labels from issue #200 spec (e.g., `process:speckit-feature`, `process:speckit-bugfix`, `epic-child`) must be included

### FR-3: Sync on Startup
- On orchestrator startup, run label sync for all watched repositories
- Sync must complete before the orchestrator begins processing webhook events
- Log results (created/updated/unchanged counts per repo)

### FR-4: Sync on Configuration Change
- When a new repository is added to the watched list (config reload or API call), trigger label sync for the new repo only
- Do not re-sync repositories that were already synced in the current session unless explicitly requested

### FR-5: Idempotent Create/Update
- If a label does not exist, create it
- If a label exists with wrong color or description, update it
- If a label exists and matches, skip it
- Never delete labels (additive-only)

### FR-6: GitHub API Rate Limiting
- Respect GitHub's REST API rate limits (5,000 requests/hour for authenticated requests)
- Implement backoff when approaching rate limit threshold
- Batch operations where possible (list all labels first, then diff)
- Log rate limit status after sync completion

## Non-Functional Requirements

- **Performance**: Sync for a single repo with all labels unchanged should complete in < 2 API calls (list + no updates)
- **Reliability**: Partial failures (one repo fails) should not prevent sync of remaining repos
- **Observability**: Emit structured log entries for each repo sync result
- **Testability**: Core sync logic must be testable without live GitHub API calls

## Success Criteria

- [ ] All label protocol labels created on watched repos
- [ ] Consistent colors and descriptions across all repos
- [ ] Idempotent — safe to run repeatedly with no side effects
- [ ] Runs automatically on orchestrator startup
- [ ] Handles GitHub API rate limiting gracefully
- [ ] Partial repo failure doesn't block other repos
- [ ] Structured logging of sync results

## Out of Scope

- Label deletion or cleanup of non-protocol labels
- UI for managing watched repositories (config-only for now)
- Webhook-based label change detection (reactive sync)
- Label sync for issue-level labels (this is repo-level provisioning only)

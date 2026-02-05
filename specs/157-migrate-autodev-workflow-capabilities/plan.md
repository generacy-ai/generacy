# Implementation Plan: Migrate autodev workflow capabilities to Generacy actions

**Feature**: Create Generacy workflow actions that implement the autodev GitHub issue workflow capabilities
**Branch**: `157-migrate-autodev-workflow-capabilities`
**Status**: Complete

## Summary

Migrate 23 autodev MCP tools to Generacy workflow actions using namespace-based plugin registration and a provider abstraction for GitHub authentication. This is a clean reimplementation using Generacy-native patterns (facets, action contexts, workflow steps) rather than a direct port of MCP tool code.

## Key Decisions (from Clarifications)

| Decision | Answer | Impact |
|----------|--------|--------|
| Authentication | **C** - Provider abstraction layer | Supports both gh CLI and Octokit |
| Registration | **B** - Namespace-based plugins | Extensible action registry |
| Dependency #155 | **A** - Satisfied | Proceed without waiting |
| Migration scope | **B** - Clean reimplementation | Generacy-native patterns |
| Orchestrator | **B** - Separate issue | Focus on actions only |

## Technical Context

### Language & Framework
- **Language**: TypeScript 5.x
- **Runtime**: Node.js 20+
- **Package Manager**: pnpm (workspace protocol)
- **Build**: tsup (esbuild-based bundler)
- **Testing**: Vitest

### Dependencies

**Internal packages**:
- `@generacy-ai/workflow-engine` - Base action framework
- `@generacy-ai/latency` - Facet definitions (when available)
- `@generacy-ai/contracts` - Shared type definitions

**External dependencies**:
- None required (uses gh CLI for GitHub operations)
- Optional: `@octokit/rest` for direct GitHub App auth (future)

### Current Action System (packages/workflow-engine)

```
packages/workflow-engine/
├── src/
│   ├── types/action.ts       # ActionType, ActionHandler, ActionContext
│   ├── actions/
│   │   ├── index.ts          # Registry: registerActionHandler()
│   │   ├── base-action.ts    # BaseAction abstract class
│   │   ├── cli-utils.ts      # executeCommand() helper
│   │   └── builtin/          # Existing actions
│   │       ├── agent-invoke.ts
│   │       ├── pr-create.ts
│   │       ├── workspace-prepare.ts
│   │       └── ...
│   └── executor/index.ts     # WorkflowExecutor
```

## Architecture

### Namespace-Based Action Registration

Refactor the existing ActionType enum to support namespace-based dynamic registration:

```typescript
// Current: Fixed enum
type ActionType = 'workspace.prepare' | 'agent.invoke' | ...

// New: Namespace pattern with plugin registration
interface ActionNamespace {
  namespace: string;          // e.g., 'github', 'workflow', 'epic'
  actions: ActionHandler[];   // Handlers in this namespace
}

// Registration
actionRegistry.registerNamespace('github', githubActions);
actionRegistry.get('github.preflight'); // Returns handler
```

### GitHub Client Abstraction

Provider pattern for authentication flexibility:

```typescript
interface GitHubClient {
  // Issue operations
  getIssue(owner: string, repo: string, number: number): Promise<Issue>;
  updateIssue(owner: string, repo: string, number: number, data: IssueUpdate): Promise<void>;
  addIssueComment(owner: string, repo: string, number: number, body: string): Promise<Comment>;

  // PR operations
  createPullRequest(owner: string, repo: string, data: PRCreate): Promise<PR>;
  updatePullRequest(owner: string, repo: string, number: number, data: PRUpdate): Promise<void>;
  getPRComments(owner: string, repo: string, number: number): Promise<Comment[]>;

  // Label operations
  addLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void>;
  removeLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void>;

  // Git operations (local)
  commit(message: string, files: string[]): Promise<void>;
  push(remote?: string, branch?: string): Promise<void>;
  fetch(remote?: string, prune?: boolean): Promise<void>;
  merge(branch: string): Promise<MergeResult>;
}

// Implementations
class GhCliGitHubClient implements GitHubClient { ... }      // Uses `gh` CLI
class OctokitGitHubClient implements GitHubClient { ... }   // Uses Octokit SDK (future)
```

### Action Namespaces

```
github.*      - GitHub API operations (issues, PRs, labels)
workflow.*    - Workflow state management (phases, gates)
epic.*        - Epic-specific operations (children, rollup)
git.*         - Local Git operations (commit, push, merge)
```

## Project Structure

```
packages/workflow-engine/
├── src/
│   ├── types/
│   │   ├── action.ts                 # MODIFY: Add namespace support
│   │   └── github.ts                 # NEW: GitHub types
│   │
│   ├── actions/
│   │   ├── index.ts                  # MODIFY: Namespace registry
│   │   ├── base-action.ts            # EXISTING (unchanged)
│   │   ├── cli-utils.ts              # EXISTING (unchanged)
│   │   │
│   │   ├── builtin/                  # EXISTING actions
│   │   │   └── ...
│   │   │
│   │   ├── github/                   # NEW: GitHub action namespace
│   │   │   ├── index.ts              # Namespace registration
│   │   │   ├── client/               # GitHub client abstraction
│   │   │   │   ├── interface.ts      # GitHubClient interface
│   │   │   │   ├── gh-cli.ts         # gh CLI implementation
│   │   │   │   └── index.ts
│   │   │   ├── preflight.ts          # github.preflight
│   │   │   ├── get-context.ts        # github.get_context
│   │   │   ├── commit-and-push.ts    # github.commit_and_push
│   │   │   ├── merge-from-base.ts    # github.merge_from_base
│   │   │   ├── create-draft-pr.ts    # github.create_draft_pr
│   │   │   ├── mark-pr-ready.ts      # github.mark_pr_ready
│   │   │   ├── update-pr.ts          # github.update_pr
│   │   │   ├── read-pr-feedback.ts   # github.read_pr_feedback
│   │   │   ├── respond-feedback.ts   # github.respond_pr_feedback
│   │   │   └── add-comment.ts        # github.add_comment
│   │   │
│   │   ├── workflow/                 # NEW: Workflow action namespace
│   │   │   ├── index.ts              # Namespace registration
│   │   │   ├── update-phase.ts       # workflow.update_phase
│   │   │   ├── check-gate.ts         # workflow.check_gate
│   │   │   ├── update-stage.ts       # workflow.update_stage
│   │   │   └── review-changes.ts     # workflow.review_changes
│   │   │
│   │   └── epic/                     # NEW: Epic action namespace
│   │       ├── index.ts              # Namespace registration
│   │       ├── post-tasks-summary.ts # epic.post_tasks_summary
│   │       ├── check-completion.ts   # epic.check_completion
│   │       ├── update-status.ts      # epic.update_status
│   │       ├── create-pr.ts          # epic.create_pr
│   │       ├── close.ts              # epic.close
│   │       └── dispatch-children.ts  # epic.dispatch_children
│   │
│   └── executor/
│       └── index.ts                  # MODIFY: Register new namespaces
│
├── tests/
│   ├── actions/
│   │   ├── github/
│   │   │   ├── preflight.test.ts
│   │   │   ├── commit-and-push.test.ts
│   │   │   └── ...
│   │   ├── workflow/
│   │   │   ├── update-phase.test.ts
│   │   │   └── ...
│   │   └── epic/
│   │       ├── check-completion.test.ts
│   │       └── ...
│   └── integration/
│       └── github-client.test.ts
│
└── package.json                      # ADD: Optional @octokit/rest peer dep
```

## Constitution Check

Checking against `.specify/memory/constitution.md`:

- [x] **Facet-based architecture**: Actions consume GitHubClient facet
- [x] **Two-way uncoupling**: Actions don't know implementation details
- [x] **Clean reimplementation**: Not porting MCP tool code directly
- [x] **Namespace plugins**: Aligns with Latency composition primitives
- [x] **No orchestrator scope**: Deferred to generacy-cloud#73

## Action Migration Mapping

### github.* namespace (10 actions)

| MCP Tool | Action | Input | Output |
|----------|--------|-------|--------|
| `preflight_check` | `github.preflight` | `issue_url` | `issue_number`, `branch`, `pr_exists`, `label_status` |
| `get_feature_context` | `github.get_context` | `issue_number` | `spec`, `plan`, `tasks`, `phase` |
| `review_pending_changes` | `github.review_changes` | `include_untracked?` | `files[]`, `has_changes` |
| `commit_and_push` | `github.commit_and_push` | `message`, `issue_number`, `files?` | `commit_sha`, `pushed` |
| `merge_from_base` | `github.merge_from_base` | `abort_on_conflict?` | `commits_merged`, `conflicts[]` |
| `create_draft_pr` | `github.create_draft_pr` | `issue_number`, `title`, `body?` | `pr_number`, `pr_url` |
| `mark_draft_pr_ready` | `github.mark_pr_ready` | `pr_number` | `success` |
| `update_pr_progress` | `github.update_pr` | `issue_number?` | `pr_number`, `updated` |
| `read_pr_feedback` | `github.read_pr_feedback` | `pr_number`, `include_resolved?` | `comments[]` |
| `respond_pr_feedback` | `github.respond_pr_feedback` | `pr_number`, `responses[]` | `posted[]` |
| `add_issue_comment` | `github.add_comment` | `issue_number`, `body`, `phase?` | `comment_id` |

### workflow.* namespace (4 actions)

| MCP Tool | Action | Input | Output |
|----------|--------|-------|--------|
| `update_phase_labels` | `workflow.update_phase` | `issue_number`, `phase`, `action` | `labels_added`, `labels_removed` |
| `check_review_gate` | `workflow.check_gate` | `issue_number`, `phase` | `can_proceed`, `blocked_by?` |
| `update_stage_comment` | `workflow.update_stage` | `issue_number`, `stage`, `status`, `progress[]` | `comment_id` |
| `manage_clarification_labels` | `workflow.update_phase` | (merged into update_phase) | |
| `update_dependency_label` | `workflow.update_phase` | (merged into update_phase) | |

### epic.* namespace (6 actions)

| MCP Tool | Action | Input | Output |
|----------|--------|-------|--------|
| `post_tasks_summary` | `epic.post_tasks_summary` | `issue_number`, `grouping?` | `comment_id` |
| `check_epic_completion` | `epic.check_completion` | `epic_issue_number` | `percentage`, `ready_for_pr`, `children[]` |
| `update_epic_status` | `epic.update_status` | `epic_issue_number`, `force_update?` | `comment_id` |
| `create_epic_pr` | `epic.create_pr` | `epic_issue_number`, `title?` | `pr_number`, `pr_url` |
| `close_epic_issue` | `epic.close` | `epic_issue_number`, `pr_number?` | `closed` |
| `dispatch_children` | `epic.dispatch_children` | `epic_issue_number`, `child_issues[]` | `dispatched[]`, `failed[]` |

### Infrastructure (1 action)

| MCP Tool | Action | Input | Output |
|----------|--------|-------|--------|
| `sync_labels` | `github.sync_labels` | `dry_run?` | `created[]`, `updated[]` |

## Implementation Phases

### Phase 1: Foundation (Registry & Client Abstraction)
1. Refactor ActionType to support namespaces
2. Create GitHubClient interface and gh CLI implementation
3. Update action registry for namespace lookups

### Phase 2: Core GitHub Actions
4. Implement `github.preflight`
5. Implement `github.get_context`
6. Implement `github.commit_and_push`
7. Implement `github.merge_from_base`

### Phase 3: PR Management Actions
8. Implement `github.create_draft_pr`
9. Implement `github.mark_pr_ready`
10. Implement `github.update_pr`
11. Implement `github.read_pr_feedback`
12. Implement `github.respond_pr_feedback`
13. Implement `github.add_comment`

### Phase 4: Workflow Management Actions
14. Implement `workflow.update_phase`
15. Implement `workflow.check_gate`
16. Implement `workflow.update_stage`

### Phase 5: Epic Management Actions
17. Implement `epic.post_tasks_summary`
18. Implement `epic.check_completion`
19. Implement `epic.update_status`
20. Implement `epic.create_pr`
21. Implement `epic.close`
22. Implement `epic.dispatch_children`

### Phase 6: Infrastructure & Testing
23. Implement `github.sync_labels`
24. Integration tests
25. Documentation

## Testing Strategy

### Unit Tests
- Each action has its own test file
- Mock GitHubClient for isolation
- Test input validation, error handling, output format

### Integration Tests
- Test GitHubClient implementations against real gh CLI
- Test action registration and namespace lookup
- Test full workflow scenarios with mocked GitHub responses

### Test Patterns
```typescript
// Example test structure
describe('github.preflight', () => {
  it('validates required issue_url input', async () => { ... });
  it('extracts issue number from URL', async () => { ... });
  it('detects current branch state', async () => { ... });
  it('returns label status', async () => { ... });
  it('handles invalid URL gracefully', async () => { ... });
});
```

## Error Handling

### Error Categories
1. **Validation errors**: Missing/invalid inputs
2. **GitHub API errors**: Rate limits, auth failures, not found
3. **Git errors**: Merge conflicts, push failures
4. **Network errors**: Timeouts, connection failures

### Error Response Format
```typescript
interface ActionError {
  code: string;           // e.g., 'GITHUB_NOT_FOUND', 'MERGE_CONFLICT'
  message: string;        // Human-readable description
  recoverable: boolean;   // Can the workflow retry?
  details?: unknown;      // Additional context (conflicts, etc.)
}
```

## Dependencies on Other Work

| Dependency | Status | Impact |
|------------|--------|--------|
| #155 @generacy-ai/generacy package | Satisfied | Can proceed |
| generacy-cloud#73 Orchestrator | Separate issue | No blocking |
| Latency facets | Future | Actions can be converted later |

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| gh CLI behavior differences | Medium | Medium | Comprehensive integration tests |
| GitHub API rate limits | Low | High | Built-in rate limit handling |
| Namespace collision | Low | Low | Prefixed namespaces (github.*, workflow.*) |
| Breaking changes to workflow-engine | Medium | High | Feature branch, careful review |

## Success Criteria (from Spec)

1. [x] `github.preflight` validates environment and returns issue context
2. [x] `github.commit_and_push` commits with proper message format
3. [x] `github.create_draft_pr` creates PR linked to issue
4. [x] `workflow.update_phase` manages phase labels correctly
5. [x] `workflow.check_gate` returns gate status accurately
6. [x] `epic.dispatch_children` sends children to orchestrator queue
7. [x] All actions handle errors gracefully with meaningful messages
8. [x] Actions work with GitHub App authentication (via provider abstraction)
9. [x] Rate limiting handled appropriately
10. [x] Comprehensive logging for debugging

---

*Generated by speckit*

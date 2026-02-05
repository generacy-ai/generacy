# Research: Migrate autodev workflow capabilities

## Technology Decisions

### 1. GitHub Client Abstraction

**Decision**: Use provider pattern with GitHubClient interface

**Rationale**:
- Aligns with Latency's "two-way uncoupling" philosophy
- Actions don't know whether they're using gh CLI or Octokit
- Enables different auth strategies per environment:
  - Local dev: gh CLI with user auth
  - CI workers: gh CLI with GITHUB_TOKEN
  - Cloud workers: GitHub App installation tokens via Octokit

**Alternatives Considered**:
| Option | Pros | Cons |
|--------|------|------|
| Direct gh CLI | Simplest, proven | Ties to CLI availability |
| Direct Octokit | Full API control | Heavy dependency, complex auth |
| **Provider pattern** | Flexible, testable | More initial work |

**Implementation**:
```typescript
interface GitHubClient {
  getIssue(owner: string, repo: string, number: number): Promise<Issue>;
  // ... other methods
}

// Default implementation uses gh CLI
class GhCliGitHubClient implements GitHubClient {
  async getIssue(owner: string, repo: string, number: number): Promise<Issue> {
    const result = await executeCommand('gh', [
      'issue', 'view', String(number),
      '-R', `${owner}/${repo}`,
      '--json', 'number,title,body,labels,state'
    ]);
    return JSON.parse(result.stdout);
  }
}
```

### 2. Namespace-Based Action Registry

**Decision**: Extend ActionType to support `namespace.action` pattern

**Rationale**:
- Aligns with Latency's composition primitives (plugins declare `provides`)
- Enables third-party action plugins without enum changes
- Clear grouping: `github.*`, `workflow.*`, `epic.*`
- Backward compatible with existing actions

**Alternatives Considered**:
| Option | Pros | Cons |
|--------|------|------|
| Extend enum | Consistent with current | 23+ new enum values |
| Separate registry | No refactor | Duplication |
| **Namespace pattern** | Extensible, clean | Registry refactor needed |

**Implementation**:
```typescript
// Registry supports both patterns
type ActionIdentifier = string;  // 'github.preflight' or 'workspace.prepare'

class ActionRegistry {
  private namespaces = new Map<string, Map<string, ActionHandler>>();

  registerNamespace(namespace: string, handlers: ActionHandler[]): void {
    const ns = new Map();
    handlers.forEach(h => ns.set(h.name, h));
    this.namespaces.set(namespace, ns);
  }

  get(identifier: ActionIdentifier): ActionHandler | undefined {
    const [namespace, name] = identifier.split('.');
    return this.namespaces.get(namespace)?.get(name);
  }
}
```

### 3. Clean Reimplementation vs Port

**Decision**: Clean reimplementation using Generacy-native patterns

**Rationale**:
- Autodev MCP tools are tightly coupled to MCP server model
- Generacy has different context model (ActionContext vs MCP params)
- Clean code is more maintainable long-term
- Capabilities remain identical; only implementation differs

**What to reuse from autodev**:
- Type definitions (Issue, Label, PR structures)
- Label configuration schema
- Stage comment HTML templates
- Business logic patterns (phase transitions, gate checks)

**What to rewrite**:
- Tool handlers → Action handlers
- MCP params → ActionContext inputs
- Direct gh calls → GitHubClient interface
- JSON return → ActionResult format

### 4. Error Handling Strategy

**Decision**: Structured errors with recovery hints

**Pattern**:
```typescript
interface ActionError {
  code: string;
  message: string;
  recoverable: boolean;
  retryAfter?: number;      // For rate limits
  details?: {
    conflicts?: string[];   // For merge conflicts
    missing?: string[];     // For not found errors
  };
}
```

**Error codes**:
| Code | Meaning | Recoverable |
|------|---------|-------------|
| `VALIDATION_ERROR` | Invalid input | No |
| `GITHUB_NOT_FOUND` | Issue/PR/branch not found | No |
| `GITHUB_RATE_LIMIT` | API rate limit hit | Yes (wait) |
| `GITHUB_AUTH_ERROR` | Auth failed | No |
| `MERGE_CONFLICT` | Git merge conflict | Partial |
| `NETWORK_ERROR` | Connection failed | Yes (retry) |

### 5. Stage Comment HTML Generation

**Decision**: Template-based HTML generation (reuse autodev patterns)

**Rationale**:
- Stage comments have specific HTML structure for GitHub rendering
- Autodev templates are battle-tested
- No need to reinvent the formatting

**Template approach**:
```typescript
function renderStageComment(stage: Stage, progress: Progress[]): string {
  const header = `<!-- stage:${stage} -->\n## ${stageTitle(stage)}`;
  const items = progress.map(p => renderProgressItem(p)).join('\n');
  return `${header}\n\n${items}`;
}
```

## Implementation Patterns

### Action Handler Pattern

```typescript
export class PreflightAction extends BaseAction {
  readonly type = 'github.preflight';

  canHandle(step: StepDefinition): boolean {
    return parseActionType(step) === this.type;
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    const issueUrl = this.getRequiredInput<string>(step, context, 'issue_url');

    // Parse issue URL
    const { owner, repo, number } = parseGitHubIssueUrl(issueUrl);

    // Get GitHub client from context or create default
    const client = context.github ?? new GhCliGitHubClient();

    // Perform checks
    const issue = await client.getIssue(owner, repo, number);
    const branch = await this.detectBranch(number);
    const labelStatus = this.analyzeLabelStatus(issue.labels);

    return this.successResult({
      issue_number: number,
      issue_title: issue.title,
      current_branch: branch.current,
      expected_branch: branch.expected,
      on_correct_branch: branch.current === branch.expected,
      label_status: labelStatus,
    });
  }
}
```

### Input/Output Types

```typescript
// github.preflight
export interface PreflightInput {
  issue_url: string;
  expected_branch?: string;
}

export interface PreflightOutput {
  issue_number: number;
  issue_title: string;
  issue_type: 'feature' | 'bug' | 'epic' | 'unknown';
  current_branch: string;
  expected_branch: string;
  on_correct_branch: boolean;
  pr_exists: boolean;
  pr_number?: number;
  uncommitted_changes: boolean;
  unresolved_comments: number;
  label_status: LabelStatus;
  epic_context?: EpicContext;
  next_command?: string;
}
```

### Testing Pattern

```typescript
describe('github.preflight', () => {
  let action: PreflightAction;
  let mockClient: MockGitHubClient;

  beforeEach(() => {
    mockClient = new MockGitHubClient();
    action = new PreflightAction();
  });

  it('extracts issue number from GitHub URL', async () => {
    mockClient.mockIssue(42, { title: 'Test issue', labels: [] });

    const result = await action.execute(
      { action: 'github.preflight', with: { issue_url: 'https://github.com/owner/repo/issues/42' } },
      createMockContext({ github: mockClient })
    );

    expect(result.success).toBe(true);
    expect(result.output.issue_number).toBe(42);
  });
});
```

## Key Sources & References

### Autodev MCP Tools (source)
- `/workspaces/claude-plugins/plugins/autodev/mcp-server/src/tools/` - Tool implementations
- `/workspaces/claude-plugins/plugins/autodev/mcp-server/src/types/` - Type definitions
- `/workspaces/claude-plugins/plugins/autodev/mcp-server/src/labels/` - Label management

### Generacy Workflow Engine (target)
- `/workspaces/generacy/packages/workflow-engine/src/actions/` - Action framework
- `/workspaces/generacy/packages/workflow-engine/src/types/action.ts` - Action types
- `/workspaces/generacy/packages/workflow-engine/src/executor/` - Workflow execution

### Latency Architecture (patterns)
- `/workspaces/tetrad-development/docs/latency-architecture.md` - Facet philosophy
- `/workspaces/tetrad-development/docs/latency-execution-plan.md` - Migration plan

### GitHub CLI Reference
- `gh issue view --help` - Issue operations
- `gh pr create --help` - PR operations
- `gh api --help` - Direct API access

---

*Generated by speckit*

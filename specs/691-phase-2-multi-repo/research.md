# Research: Phase 2 Multi-Repo — Cross-Repo Change Fan-Out

## Technology Decisions

### 1. Unpushed Commit Detection

**Decision**: Use `git rev-list --count origin/<branch>..HEAD` inside `getStatus()`.

**Rationale**: This is the standard git plumbing command for counting ahead-of-remote commits. It's fast (index-only operation), reliable, and doesn't require network access (uses local tracking refs).

**Edge cases**:
- **No remote tracking branch** (new local branch never pushed): `rev-list` exits non-zero. Treat as `hasUnpushed: false, unpushedCount: 0` — the working tree dirtiness check (`has_changes`) already handles new untracked files. The branch creation + push flow in the handler handles the "no remote branch yet" case.
- **Detached HEAD**: `branch` is empty string. Handler short-circuits (can't determine primary branch name).

**Alternative rejected**: `git status -sb` with `[ahead N]` parsing. Fragile regex on porcelain output; `rev-list` is the plumbing equivalent.

### 2. Handler Architecture

**Decision**: Pure exported async function, not a class.

**Rationale**: The handler has no state between invocations. Each call is independent — it reads context, performs git operations, and returns. A class would add constructor/lifecycle overhead for no benefit.

**Pattern**:
```typescript
export interface SiblingFanoutContext {
  primaryWorkdir: string;
  siblingWorkdirs: Record<string, string>;
  issueNumber: number;
  primaryRepoName: string;
  org: string;
  workflowStore: WorkflowStore;
  workflowState: WorkflowState;
  logger: Logger;
  tokenProvider?: () => Promise<string | undefined>;
}

export async function siblingFanoutHandler(ctx: SiblingFanoutContext): Promise<void>
```

This context interface is independent of #690's exact `PhaseAfterContext` shape. A thin adapter maps between them when #690 lands.

### 3. GitHubClient Instantiation Strategy

**Decision**: One `GhCliGitHubClient` per sibling, created at fan-out time.

**Rationale**: `GhCliGitHubClient` is workdir-scoped (all git commands run in `this.workdir`). Creating per-sibling is cheap (no network, just sets a path string). Reusing the primary's client would require swapping `workdir` mid-operation.

### 4. Primary PR Title Fetch

**Decision**: Fetch via `gh pr view --json title` on the primary workdir at fan-out time.

**Rationale**: The PR title might have been edited by a reviewer since the workflow started. Fetching live ensures the sibling PR title matches. One extra `gh` CLI call per fan-out invocation — acceptable.

**Fallback**: If no primary PR exists yet (e.g., fan-out runs before the primary's `create-draft-pr` step), use the issue title with a `[Multi-repo]` prefix.

### 5. Cross-Repo Close Reference Format

**Decision**: `Closes generacy-ai/<primary-repo>#<issue-number>` in the PR body.

**Rationale**: GitHub's documented cross-repo close syntax. Works when both repos are in the same org. The PR body (not title) is the correct location — GitHub only parses close keywords in the body and commit messages.

### 6. Sequential vs. Parallel Sibling Processing

**Decision**: Sequential processing of siblings.

**Rationale**:
- Typical case is 1-2 siblings. Parallelism overhead (Promise.allSettled, error aggregation) adds complexity for negligible time savings.
- Sequential makes partial failure semantics clearer — first failure terminates, already-processed siblings are left as-is.
- `gh` CLI may have auth token rate limiting concerns with parallel calls.

**Alternative rejected**: `Promise.allSettled` with error collection. Over-engineered for the expected 1-2 sibling case. Can be reconsidered if workspaces grow beyond 5 repos.

### 7. Branch Existence Check Strategy

**Decision**: Check remote (`git ls-remote --heads origin <branch>`) first, then local.

**Rationale**: The sibling repo may have been pushed to by a previous partial run. Remote check catches this. If remote exists → `git fetch origin <branch> && git checkout <branch>`. If not → create from default branch.

**Flow**:
1. `branchExists(branch, remote=true)` — does origin have it?
2. If yes → `git fetch origin <branch>` + `checkout(branch)` (may need to create local tracking branch)
3. If no → `getDefaultBranch()` + `createBranch(branch, defaultBranch)`

## Implementation Patterns

### Idempotency Pattern

Every operation in the fan-out is idempotent:
- **Branch exists** → checkout (not create)
- **PR exists** → skip creation (not duplicate)
- **linkedPRs entry exists** → `addLinkedPR` replaces (not appends)
- **Already pushed** → push is a no-op if HEAD matches remote

This means a failed-then-retried phase naturally recovers without rollback.

### Error Propagation Pattern

```
sibling detection error → log + skip sibling → continue
push error             → throw → phase fails → user sees error
PR create error        → throw → phase fails → user sees error
```

Matches the spec's "fail loud" for push/PR, "log and skip" for detection.

### Token Resolution

The handler needs a GitHub token for `gh` CLI operations on sibling repos. This follows the existing `tokenProvider` pattern from #620:
- In orchestrator context: resolved from `wizard-credentials.env`
- In worker context: resolved from credhelper session env
- The `GhCliGitHubClient` constructor accepts `tokenProvider` — no special handling needed

## Key Sources

- [GitHub cross-repo close references](https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue) — `Closes owner/repo#number` syntax
- Phase 1 PR #693 — `siblingWorkdirs` threading
- Issue C PR #689 — `LinkedPR` type and `addLinkedPR` helper
- Issue D PR #698 — `phaseAfterHandlers` API (pending)

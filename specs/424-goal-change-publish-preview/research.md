# Research: Gate publish-preview.yml on Manual Dispatch

## Technology Decisions

### 1. Trigger Type: `workflow_dispatch`

**Decision**: Use `workflow_dispatch` as the sole trigger.

**Rationale**:
- GitHub Actions `workflow_dispatch` is the standard mechanism for manual-only workflows
- Supports both the Actions UI "Run workflow" button and CLI via `gh workflow run`
- All existing job steps (checkout, pnpm setup, changeset versioning, npm publish, devcontainer feature publish) are trigger-agnostic — they work identically under any trigger type
- The `concurrency` group (`github.workflow`) is also trigger-independent

**Alternatives Considered**:
| Alternative | Why Rejected |
|-------------|-------------|
| Keep `push` trigger + add path filter | Doesn't prevent publishing when develop is pushed — spawn-refactor changes touch the same paths |
| Add environment protection rule | Adds approval friction to a workflow that should be one-click for maintainers |
| Use `workflow_call` | Requires a parent workflow to invoke it — unnecessary indirection for manual triggering |
| Disable workflow via GitHub UI | Not codified in repo; easy to accidentally re-enable; doesn't appear in PR diff |

### 2. Documentation Approach

**Decision**: Add an inline YAML comment block at the top of `publish-preview.yml` explaining the manual process + reference in PR description.

**Rationale**:
- Inline comments are discoverable by anyone reading the workflow file
- No additional files to maintain
- A standalone `docs/preview-release-procedure.md` would be premature for a single workflow — the comment is sufficient

### 3. No Changes to Job Logic

**Decision**: Do not modify any job steps, `needs` chains, or `concurrency` settings.

**Rationale**:
- `needs: publish-npm` is trigger-agnostic — it simply means "wait for this job to finish"
- `concurrency.group: ${{ github.workflow }}` resolves to the workflow name regardless of trigger
- All steps use `github.ref` and `github.sha` which are populated by `workflow_dispatch` (defaulting to the selected ref)

## Key References

- [GitHub Docs: workflow_dispatch](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#workflow_dispatch) — confirms ref selection, input support, and compatibility
- [GitHub Docs: gh workflow run](https://cli.github.com/manual/gh_workflow_run) — CLI interface for manual dispatch

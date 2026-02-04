# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-02-04 20:17

### Q1: GitHub Authentication Model
**Context**: The spec mentions 'GitHub App authentication' in acceptance criteria #8, but the existing actions use `gh` CLI. The autodev MCP tools currently use `gh` CLI commands under the hood. Migrating to Generacy actions requires deciding whether to keep gh CLI dependency, use GitHub App tokens (JWT), or use the Octokit SDK directly. This impacts how credentials flow from orchestrator to worker actions.
**Question**: Should the migrated actions use the `gh` CLI (as autodev does today), GitHub App installation tokens via Octokit SDK, or support both? If GitHub App, should the orchestrator manage token acquisition and pass tokens to actions?
**Options**:
- A: Keep gh CLI approach (simplest migration, requires gh auth on workers)
- B: Use Octokit SDK with GitHub App tokens (orchestrator manages auth, more scalable)
- C: Support both via a provider abstraction layer (future-proof but more work)

**Answer**: *Pending*

### Q2: Action Registration Approach
**Context**: The existing action system uses a fixed ActionType enum (`workspace.prepare`, `agent.invoke`, etc.) with a Map-based registry. Adding 23 new action types requires either extending this enum significantly or introducing a dynamic namespace-based registration pattern. The choice affects how third-party actions could be added later.
**Question**: Should the new github/workflow/epic actions be added as individual entries in the existing ActionType enum, or should the registry be refactored to support dynamic namespace-based registration (e.g., `github.*` as a plugin)?
**Options**:
- A: Extend existing ActionType enum with all new types (consistent with current pattern, larger enum)
- B: Refactor to namespace-based plugin registration (more extensible, larger refactor scope)
- C: Add a separate 'integration actions' registry alongside existing one (minimal refactor, some duplication)

**Answer**: *Pending*

### Q3: Dependency on #155
**Context**: The spec states 'Depends on: #155 (@generacy-ai/generacy npm package)'. The @generacy-ai/generacy package already exists in packages/generacy/. It's unclear what specific functionality from #155 is needed before this work can begin, or if the dependency is already satisfied.
**Question**: Is the dependency on #155 still blocking, or has the required @generacy-ai/generacy package functionality already been implemented? What specific exports or capabilities from #155 are needed?
**Options**:
- A: Dependency is satisfied - proceed without waiting
- B: Dependency is partial - specific capabilities still needed (please list)
- C: Dependency is blocking - must wait for #155 to complete

**Answer**: *Pending*

### Q4: Migration vs Rewrite Scope
**Context**: The autodev MCP tools contain significant logic for label management, stage comments with HTML formatting, branch detection, conflict resolution, etc. 'Migration' could mean porting the existing TypeScript MCP tool code into action handlers, or reimplementing the capabilities cleanly for the Generacy architecture. The existing code has accumulated complexity (e.g., multiple label management tools, stage comment HTML generation).
**Question**: Should this migration port the existing autodev MCP tool implementations as closely as possible, or should it be a clean reimplementation that achieves the same capabilities but uses Generacy-native patterns (action contexts, event emitters, workflow store)?
**Options**:
- A: Direct port - copy and adapt existing code for minimal risk
- B: Clean reimplementation - use Generacy patterns, same capabilities
- C: Hybrid - port core logic, reimagine the interface layer

**Answer**: *Pending*

### Q5: Orchestrator Integration Scope
**Context**: The spec lists 5 orchestrator integration requirements (issue monitoring, PR feedback monitoring, job dispatch, phase tracking, review gate enforcement). The existing orchestrator has routes for /workflows, /queue, /integrations, /events but it's unclear how much of this already supports the needed capabilities vs requires new implementation. This could significantly expand the scope beyond just action handlers.
**Question**: Is orchestrator integration (polling, monitoring, dispatch) in scope for this issue, or should this issue focus only on creating the action handlers and leave orchestrator integration for a separate issue?
**Options**:
- A: Full scope - actions + orchestrator integration
- B: Actions only - orchestrator integration is a separate issue
- C: Actions + minimal orchestrator hooks (dispatch interface only)

**Answer**: *Pending*


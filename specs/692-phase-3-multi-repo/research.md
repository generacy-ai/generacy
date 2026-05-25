# Research: Phase 3 Multi-Repo Review Coordination

**Feature**: #692 — on-sibling-review gate condition and review-phase sibling coordination

## Technology Decisions

### T1: GitHub Review State API

**Decision**: Use `gh pr view --json reviewDecision` to check sibling PR approval status.

**Rationale**:
- Returns `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or empty string
- Native to GitHub — no label mirroring needed
- Automatically handles review dismissal on force-push
- Works across repos without requiring speckit label setup

**Alternatives rejected**:
- **Label-based**: Would require `approved` or `completed:implementation-review` labels on sibling repos. Sibling repos don't have speckit label apparatus. Would need label sync and create coupling.
- **Check-run status**: Different concern (CI, not human review). Out of scope per spec.

### T2: Multi-Gate Architecture

**Decision**: Refactor `GateChecker` to support multiple gates per phase via new `checkGates()` method (returns `GateDefinition[]`).

**Rationale**:
- `implement` phase needs two independent gates: `waiting-for:implementation-review` (always) and `waiting-for:sibling-review` (on-sibling-review)
- Gates are independently enable-able with distinct labels
- AND semantics: all gates must be satisfied before proceeding

**Implementation pattern**:
```typescript
// Before: single gate
const gate = gateChecker.checkGate(phase, workflowName, config);

// After: multiple gates
const gates = gateChecker.checkGates(phase, workflowName, config);
for (const gate of gates) { /* evaluate each */ }
```

**Alternative rejected**:
- **Folding into existing gate**: Would couple primary review and sibling review into a single gate label, making them non-independently-controllable.

### T3: LinkedPR URL Parsing

**Decision**: Parse `LinkedPR.url` with regex to extract `owner`, `repo`, and PR `number`.

**Pattern**: `https://github.com/<owner>/<repo>/pull/<number>`

**Regex**: `/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<number>\d+)/`

**Rationale**:
- No same-org assumption
- URL is already persisted in `LinkedPR` schema by Phase 2
- Simple, testable pure function

### T4: Gate Evaluation Order

**Decision**: When multiple gates match a phase, evaluate in config-definition order. First unsatisfied gate's label is applied.

**Rationale**:
- Deterministic behavior
- Config author controls priority
- If `always` gate comes first and is already completed (has `completed:implementation-review`), the `on-sibling-review` gate can still block

### T5: Sibling Ready-for-Review Timing

**Decision**: Flip siblings at two points (both idempotent):

1. **Gate activation** (in `phase-loop.ts`): When `on-sibling-review` gate evaluates to active, flip all siblings before pausing. This ensures reviewers can start reviewing siblings immediately.
2. **markReadyForReview() backstop** (in `pr-manager.ts`): After all phases complete, flip siblings alongside the primary. Covers ungated workflows.

**Rationale**: Clarification Q3 answer specified option C (both). Idempotency via `gh pr ready` being a no-op on non-draft PRs means double-flipping has zero side effects.

## Existing Patterns Used

### Gate Condition Evaluation (phase-loop.ts:403-425)

The existing pattern for `on-questions`:
1. `checkGate()` returns `GateDefinition` with condition type
2. Caller evaluates the condition (e.g., `hasPendingClarifications()`)
3. Sets `gateActive = true/false` based on evaluation
4. If active: apply label, emit event, return early

The `on-sibling-review` condition follows the same pattern:
1. `checkGates()` returns gates including `on-sibling-review`
2. Caller evaluates by querying each linkedPR's `reviewDecision`
3. If any linked PR is not approved: `gateActive = true`
4. Before pausing: flip all siblings to ready-for-review

### PrManager Method Extension (pr-manager.ts:189-208)

`markReadyForReview()` follows try/catch-with-warn pattern. Sibling flipping follows the same:
- Best-effort per sibling
- Log warning on failure, don't fail the workflow
- Skip already-ready siblings (API is idempotent)

### WorkerContext Threading (types.ts:231-256)

Pattern from Phase 1: `siblingWorkdirs` was added as optional field on `WorkerContext`. `linkedPRs` follows the same — optional field, populated by caller (`claude-cli-worker.ts`).

## Key Sources

- Phase 2 implementation (#691): Sibling fan-out handler, `LinkedPR` schema, `addLinkedPR()`
- Phase 1 implementation (#687): `siblingWorkdirs` threading pattern
- Existing gate system: `gate-checker.ts`, `phase-loop.ts:398-494`, `config.ts:35-48`
- GitHub CLI docs: `gh pr view --json reviewDecision`, `gh pr ready`

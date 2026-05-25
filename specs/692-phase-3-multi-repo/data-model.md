# Data Model: Phase 3 Multi-Repo Review Coordination

**Feature**: #692 — on-sibling-review gate condition and review-phase sibling coordination

## Type Extensions

### GateCondition (types.ts:105)

```typescript
// Before
condition: 'always' | 'on-request' | 'on-questions' | 'on-failure';

// After
condition: 'always' | 'on-request' | 'on-questions' | 'on-failure' | 'on-sibling-review';
```

Must also update `GateDefinitionSchema` in `config.ts:13`:
```typescript
condition: z.enum(['always', 'on-request', 'on-questions', 'on-failure', 'on-sibling-review']),
```

### WorkerContext (types.ts:231-256)

```typescript
export interface WorkerContext {
  // ... existing fields ...

  /** Sibling repository working directories (repo name -> absolute path) */
  siblingWorkdirs?: Record<string, string>;

  /** PRs opened in sibling repos during cross-repo fan-out (from WorkflowState) */
  linkedPRs?: LinkedPR[];  // NEW
}
```

Import: `LinkedPR` from `@generacy-ai/workflow-engine` (already exported from `packages/workflow-engine/src/types/store.ts:23-32`).

### GateChecker Return Type

```typescript
// New method signature
checkGates(
  phase: WorkflowPhase,
  workflowName: string,
  config: WorkerConfig,
): GateDefinition[];

// Old method preserved for backward compat (returns first match)
checkGate(...): GateDefinition | null;
```

## New Types

### ParsedPRUrl (linked-pr-url-parser.ts)

```typescript
export interface ParsedPRUrl {
  owner: string;
  repo: string;
  number: number;
}
```

Pure function:
```typescript
export function parsePRUrl(url: string): ParsedPRUrl | null;
```

### SiblingReviewStatus (sibling-review-checker.ts)

```typescript
export interface SiblingReviewResult {
  /** Whether all linked PRs are approved */
  allApproved: boolean;
  /** Per-PR status for logging */
  statuses: Array<{
    repo: string;
    number: number;
    reviewDecision: string;
    approved: boolean;
  }>;
}
```

Function:
```typescript
export async function checkSiblingReviews(
  linkedPRs: LinkedPR[],
  github: GitHubClient,
  logger: Logger,
): Promise<SiblingReviewResult>;
```

## Existing Types (Unchanged)

### LinkedPR (workflow-engine/src/types/store.ts:23-32)

```typescript
export interface LinkedPR {
  repo: string;    // Short name, e.g., "generacy-cloud"
  number: number;  // PR number in that repo
  branch: string;  // Branch the PR was opened from
  url: string;     // Full URL to the PR
}
```

### WorkflowState (workflow-engine/src/types/store.ts:49-72)

Already has `linkedPRs?: LinkedPR[]` at line 67. No change needed.

### GateDefinition (types.ts:99-106)

```typescript
export interface GateDefinition {
  phase: WorkflowPhase;
  gateLabel: string;
  condition: 'always' | 'on-request' | 'on-questions' | 'on-failure' | 'on-sibling-review';
  // ^^^ only the condition union type changes
}
```

## Configuration Changes

### Default Gates (config.ts:35-48)

```typescript
gates: z.record(z.string(), z.array(GateDefinitionSchema)).default({
  'speckit-feature': [
    { phase: 'clarify', gateLabel: 'waiting-for:clarification', condition: 'on-questions' },
    { phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'always' },
    { phase: 'implement', gateLabel: 'waiting-for:sibling-review', condition: 'on-sibling-review' },
    //                     ^^^ NEW gate entry on the same phase
  ],
  'speckit-bugfix': [
    { phase: 'clarify', gateLabel: 'waiting-for:clarification', condition: 'on-questions' },
    { phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'on-request' },
    // No sibling-review gate for bugfix (single-repo typical)
  ],
  'speckit-epic': [
    { phase: 'clarify', gateLabel: 'waiting-for:clarification', condition: 'on-questions' },
    { phase: 'tasks', gateLabel: 'waiting-for:tasks-review', condition: 'always' },
  ],
}),
```

## Data Flow

```
WorkflowState.linkedPRs (disk)
  ↓ loaded by claude-cli-worker after phase-after handlers
WorkerContext.linkedPRs (memory)
  ↓ accessed by phase-loop gate evaluation
checkSiblingReviews(context.linkedPRs, ...) → SiblingReviewResult
  ↓ gh pr view --json reviewDecision per PR
gateActive = !result.allApproved
  ↓ if activating
flipSiblingsReady(context.linkedPRs, ...) → mark all draft siblings as ready
```

## Validation Rules

- `LinkedPR.url` must match `github.com/<owner>/<repo>/pull/<number>` pattern. `parsePRUrl()` returns `null` on invalid URLs; caller logs warning and skips.
- `linkedPRs` empty array → gate immediately satisfied (vacuous truth).
- `linkedPRs` undefined → treated as empty, gate immediately satisfied.
- `reviewDecision` values: `'APPROVED'` is the only passing state. `'CHANGES_REQUESTED'`, `'REVIEW_REQUIRED'`, `''` (no reviews yet) all keep the gate active.

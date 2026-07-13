# Data Model: #935

## Modified types

### `ParsedEpicBody` (`packages/cockpit/src/resolver/types.ts:20`)

```typescript
export interface ParsedEpicBody {
  /** L3-heading phases in body order. May be empty for flat-list bodies. */
  phases: ParsedPhase[];
  /**
   * Task-list refs collected outside any phase — appearing before the first
   * `### ` heading, under a `## Ad-hoc` L2 section, or after a `####+`
   * terminator. First-appearance order, deduped within adhoc.
   * NEW in #935.
   */
  adhocRefs: IssueRef[];
  /** Deduped union across phases + adhoc, sorted by (repo, number). */
  allRefs: IssueRef[];
  /** Ref-shaped lines that couldn't be resolved (FR-003 warnings). */
  warnings: string[];
}
```

### `LoudResolverErrorCode` (`packages/cockpit/src/resolver/errors.ts`)

`NO_PHASE_HEADINGS` is no longer emitted by `resolveEpic`. Retained in the union for one release (deprecated) so existing callers pattern-matching on the code don't hard-fault. Removed after `/verify` confirms no consumers.

### `GhWrapper` (`packages/cockpit/src/gh/wrapper.ts:182`)

New method:

```typescript
interface GhWrapper {
  // …existing…
  /**
   * Overwrite the body of an issue. Not conditional — callers implement
   * their own read-modify-verify loop for concurrent-safe append/remove.
   */
  updateIssueBody(repo: string, issue: number, body: string): Promise<void>;
}
```

Implementation: `gh issue edit <n> --repo <r> --body-file -` with `body` on stdin.

## New types (writer + scope module)

### `BodyShape`

```typescript
type BodyShape = 'phased' | 'flat';

// Determined by: does the body contain at least one `### ` heading?
function detectShape(body: string): BodyShape;
```

### `ScopeMutation`

```typescript
type ScopeMutation =
  | { kind: 'add'; ref: IssueRef }
  | { kind: 'remove'; ref: IssueRef };

interface ScopeWriteResult {
  /** True if the mutation was already satisfied — body unchanged. */
  noop: boolean;
  /** The resulting body (equal to input body when noop). */
  body: string;
}

/**
 * Pure function — no I/O. Applies the mutation according to shape rules.
 *
 * Add rules:
 *  - phased body: insert `- [ ] owner/repo#N` under `## Ad-hoc` (create if missing).
 *  - flat body: append `- [ ] owner/repo#N` at body tail (ensuring trailing newline).
 *  - idempotent: if the ref is already present as a task-list entry anywhere in
 *    the body, returns `{ noop: true, body }` unchanged.
 *
 * Remove rules:
 *  - Delete the first task-list line matching the ref (checked or unchecked).
 *  - Does NOT delete an empty `## Ad-hoc` heading. (verb symmetry — remove is
 *    single-line, not section-cleanup)
 *  - idempotent: if the ref is not present, returns `{ noop: true, body }`.
 */
function applyScopeMutation(body: string, mutation: ScopeMutation): ScopeWriteResult;
```

### `ScopeContendedError`

```typescript
class ScopeContendedError extends Error {
  readonly code: 'SCOPE_ADD_CONTENDED';  // spec-defined name; used for both add and remove
  readonly attempts: number;              // always 5 at throw time
  readonly ref: IssueRef;
  readonly mutation: 'add' | 'remove';
  readonly scope: { repo: string; number: number };
}
```

### `RetryOptions` (internal to scope/retry.ts)

```typescript
interface RetryOptions {
  /** Total attempts before throwing SCOPE_ADD_CONTENDED. Default 5. */
  maxAttempts?: number;
  /** Backoff schedule (ms). Length must be >= maxAttempts. Default [100, 250, 500, 1000, 2000]. */
  backoff?: number[];
  /** Test seam — pluggable sleep. */
  sleep?: (ms: number) => Promise<void>;
}
```

## MCP schema additions (`packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts`)

### `CockpitScopeAddInputSchema`

```typescript
export const CockpitScopeAddInputSchema = z.object({
  scope: EpicRefInputSchema,       // The scope (task-list-bearing) issue.
  issue: IssueRefInputSchema,      // The ref to append.
}).strict();
export type CockpitScopeAddInput = z.infer<typeof CockpitScopeAddInputSchema>;
```

### `CockpitScopeRemoveInputSchema`

```typescript
export const CockpitScopeRemoveInputSchema = z.object({
  scope: EpicRefInputSchema,
  issue: IssueRefInputSchema,
}).strict();
export type CockpitScopeRemoveInput = z.infer<typeof CockpitScopeRemoveInputSchema>;
```

### `CockpitQueueInputSchema` (MODIFIED)

Was `{ epic, phase }`. Now discriminated union:

```typescript
export const CockpitQueueInputSchema = z.union([
  z.object({ epic: EpicRefInputSchema, phase: z.string().min(1) }).strict(),
  z.object({ issue: IssueRefInputSchema }).strict(),
]);
export type CockpitQueueInput = z.infer<typeof CockpitQueueInputSchema>;
```

## MCP tool result types

### `CockpitScopeAddData`

```typescript
export interface CockpitScopeAddData {
  scope: { owner: string; repo: string; number: number };
  ref: { owner: string; repo: string; number: number };
  /** Body shape at the time of write. */
  shape: BodyShape;
  /** True if the ref was already present. */
  alreadyPresent: boolean;
  /** Number of retry attempts consumed (1 = single-try success). */
  attempts: number;
}
```

### `CockpitScopeRemoveData`

```typescript
export interface CockpitScopeRemoveData {
  scope: { owner: string; repo: string; number: number };
  ref: { owner: string; repo: string; number: number };
  /** True if the ref was already absent. */
  alreadyAbsent: boolean;
  attempts: number;
}
```

### `CockpitQueueData` (unchanged for phase form; new for issue form)

Phase form: as today — `{ epic, phase, queued[], skipped[] }`.

Issue form:

```typescript
interface CockpitQueueIssueData {
  issue: { owner: string; repo: string; number: number };
  /** eligibility outcome for the single ref */
  outcome: 'queued' | 'skipped';
  /** if skipped, why */
  reason?: 'closed' | 'already-labeled' | 'not-found';
  workflowLabel: string;
  assignee: string;
  url: string;
}
```

Handler returns `CockpitQueueData | CockpitQueueIssueData` — dispatched at the type level via the discriminator (`phase` vs `issue`).

## Error class taxonomy (MCP `ToolResult.class` values)

New errors added to `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts`:

- `'contended'` — retry budget exhausted (`SCOPE_ADD_CONTENDED`)
- `'scope-not-found'` — scope issue doesn't exist or isn't readable

Existing values re-used (`'invalid-args'`, `'invalid-cursor'`, `'unknown-gate'`, etc.) — no fork.

## Event schema

**No wire-schema changes.** The `initial: true` flag exists on `CockpitEventSchema` (`packages/generacy/src/cli/commands/cockpit/watch/emit.ts:17`) today. The change is emission behaviour in `computeTransitions`, not schema.

## Validation rules

- `IssueRef.repo` — matches `/^[^/\s]+\/[^/\s#]+$/`
- `IssueRef.number` — positive integer
- `body` — arbitrary UTF-8 string (max 65535 chars per GitHub); no client-side length gate
- `## Ad-hoc` heading detection — `/^##\s+ad-hoc\s*$/i` (case-insensitive, first-token only)
- Task-list line format — `- [ ] owner/repo#N` (writer emits unchecked always; reader accepts checked or unchecked)

## Relationships

```
resolveEpic()
  ├─ getIssue()                     [gh wrapper]
  └─ parseEpicBody(body) → { phases, adhocRefs, allRefs, warnings }
      └─ allRefs feeds runOnePoll → snapshots → computeTransitions → events

cockpitScopeAdd({ scope, ref })
  └─ scope/retry.ts loop:
       ├─ getIssue(scope) → body
       ├─ applyScopeMutation(body, {add, ref}) → newBody
       ├─ updateIssueBody(scope, newBody)
       ├─ getIssue(scope) → verifyBody
       └─ retry if verifyBody !== newBody, else return

cockpitQueue({ issue })              [new issue-form branch]
  └─ classifyRow(ref, workflowLabel, view) → eligibility
      └─ if eligible: addAssignees + addLabel   [same as phase form]
```

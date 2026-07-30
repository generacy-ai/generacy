# Contract: `spawnClaudeForFeedback` return-type widening (FR-011)

**Kind**: Private (module-scoped) API change on `PrFeedbackHandler`.
**File**: `packages/orchestrator/src/worker/pr-feedback-handler.ts`.
**Scope**: This is not a package-exported API. The changeset gate treats this as an internal orchestrator change (`@generacy-ai/orchestrator` → `patch`).

## Before

```typescript
// pr-feedback-handler.ts:412 (call site)
const success = await this.spawnClaudeForFeedback(
  checkoutPath,
  prompt,
  workflowId,
  prNumber,
  item.workflowName,
);

// pr-feedback-handler.ts:687 (definition)
private async spawnClaudeForFeedback(
  checkoutPath: string,
  prompt: string,
  workflowId: string,
  prNumber: number,
  workflowName: string,
): Promise<boolean>;
```

## After

```typescript
// pr-feedback-handler.ts:412 (call site)
const { success, exitCode, timedOut } = await this.spawnClaudeForFeedback(
  checkoutPath,
  prompt,
  workflowId,
  prNumber,
  item.workflowName,
);

// pr-feedback-handler.ts:687 (definition)
private async spawnClaudeForFeedback(
  checkoutPath: string,
  prompt: string,
  workflowId: string,
  prNumber: number,
  workflowName: string,
): Promise<SpawnClaudeResult>;

// Co-located type (not exported from package)
export interface SpawnClaudeResult {
  success: boolean;
  exitCode: number | null;
  timedOut: boolean;
}
```

## Semantic invariants

1. `timedOut === true` implies `success === false`. A timeout that races with a natural exit-0 finish is treated as timeout; the SIGTERM timer fires and this cycle's work is bounded (per FR-013).
2. `exitCode === null` is legal and signals "process died via signal before exit code was captured" — matches Node's `ChildProcess.exitCode` semantics. Handler treats `null` identically to a non-zero exit code for disposition purposes (both are `success: false`).
3. When `timedOut === true`, `exitCode` will typically be `143` (SIGTERM) but callers MUST NOT switch on the specific numeric value — `timedOut` is the authoritative signal.

## Runtime plumbing

`runCli` block at `pr-feedback-handler.ts:757-791` already computes `timedOut` (local flag at `:757`) and `exitCode` (awaited at `:779`). The return-shape change hoists both into the return object rather than dropping them on the floor.

Timeout log line at `:787-790` continues to fire; only the return statement at `:791` changes from `return false` to `return { success: false, exitCode, timedOut: true }`. The clean-exit path (`:794-806`) similarly returns `{ success, exitCode, timedOut: false }`. The catch block (`:807-814`) returns `{ success: false, exitCode: null, timedOut }` — preserving whatever `timedOut` was set to before the throw.

## Test doubles to update

`packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts` — approximately 5 sites that mock `spawnClaudeForFeedback` migrate from `.mockResolvedValue(true)` / `.mockResolvedValue(false)` to full triples. Common values:

| Scenario | Triple |
|---|---|
| Happy path | `{ success: true, exitCode: 0, timedOut: false }` |
| Timeout with partial push | `{ success: false, exitCode: 143, timedOut: true }` |
| Timeout with no push | `{ success: false, exitCode: 143, timedOut: true }` (paired with `commitAndPushChanges` mock returning `false`) |
| Clean non-zero exit | `{ success: false, exitCode: 1, timedOut: false }` |
| Signal without exit code | `{ success: false, exitCode: null, timedOut: true }` |

# Data Model: Failure-alert bottom-of-thread comment (#865)

This change adds **one new public method** to an existing manager class, **one new plain-object shape** to describe its input, and **one new exported constant** for future consumers. It adds **no new persisted state**, no new relay payloads, no new Zod schemas, and no new fields on any cross-method context object (`WorkerContext`, `PhaseResult`, `StageCommentData`).

## New types

### `FailureAlertData` (`packages/orchestrator/src/worker/types.ts`)

**New exported interface** — the input shape for `StageCommentManager.postFailureAlert`. Plain object; not persisted, not on the wire, not schema-validated (single internal producer, single internal consumer).

```ts
/**
 * Input to StageCommentManager.postFailureAlert. Composed by phase-loop.ts at
 * each of the four terminal-error sites (pre-validate install failure,
 * unexpected spawn error, post-phase failure, no-progress guard) and passed
 * as-is to the manager.
 *
 * `runId` is minted once per PhaseLoop.executeLoop invocation via
 * crypto.randomUUID() — see plan.md D7 for the scoping rationale.
 */
export interface FailureAlertData {
  /** Which stage the failing phase belongs to (used in the marker). */
  stage: StageType;
  /** Stable per-runPhaseLoop-invocation UUID (dedup key inside the marker). */
  runId: string;
  /** The failing phase name (used in the summary line and no-progress site's synthesized error). */
  phase: WorkflowPhase;
  /**
   * Verbatim reuse of #847's buildErrorEvidence output. NO re-derivation;
   * NO independent bounding — evidence is already bounded upstream.
   */
  evidence: NonNullable<StageCommentData['errorEvidence']>;
}
```

**Contract**:
- All four sub-fields MUST be set (`runId` MUST be a UUID minted at the start of the current `runPhaseLoop` invocation).
- `evidence` MUST be the same object passed to the adjacent `updateStageComment({ status: 'error', ..., errorEvidence })` call — the alert is a *second consumer* of that object (FR-008), not a fresh derivation.

## New exported constant

### `FAILURE_ALERT_MARKER_PREFIX` (`packages/orchestrator/src/worker/types.ts`)

**New exported string constant** — the fixed prefix that every failure-alert marker begins with. Rendered inside HTML comments on the alert-comment body.

```ts
/**
 * HTML-marker prefix used on failure-alert comments. Full marker shape:
 *   <!-- generacy:failure-alert:<stage>:<runId> -->
 * where <stage> is a StageType and <runId> is a UUID minted at
 * PhaseLoop.executeLoop entry.
 *
 * Future cockpit tooling MAY parse this prefix to discover alert history on
 * an issue. Format changes require a contract-file edit
 * (specs/865-found-during-cockpit-v1/contracts/failure-alert-comment.md).
 */
export const FAILURE_ALERT_MARKER_PREFIX = '<!-- generacy:failure-alert:';
```

**Contract**:
- Every failure-alert comment body MUST include a marker starting with this prefix and ending with ` -->` (with intervening `<stage>:<runId>`).
- Dedup search inside `StageCommentManager.postFailureAlert` MAY use either the full marker (`prefix + stage + ':' + runId + ' -->'`) OR the prefix + stage (`prefix + stage + ':'`) — for `#865`'s per-invocation dedup, the full marker is used to match the specific `runId`.

## Modified types

None. Existing types are all unchanged:

- **`StageCommentData`** (`types.ts:187`) — unchanged. `errorEvidence` field from `#847` is reused verbatim; the alert reads it, does not extend or wrap it.
- **`PhaseResult`** (`types.ts:122`) — unchanged. Evidence derivation reuses `PhaseResult.error.{message, stderr}` + `exitCode` exactly as `#847` does.
- **`WorkerContext`** (`types.ts:245`) — unchanged. `runId` is scoped to `PhaseLoop.executeLoop`; not on the context.
- **`STAGE_MARKERS`** (`types.ts:90`) — unchanged. The alert marker is a *different* prefix (`generacy:failure-alert:` vs. `generacy-stage:`), deliberately separate so cockpit tooling can distinguish the two surfaces.
- **`STAGE_TITLES` / `STATUS_ICONS`** (`stage-comment-manager.ts:8, 17`) — unchanged. The alert-body renderer has its own summary-line format independent of the stage-comment renderer.

## New method on existing class

### `StageCommentManager.postFailureAlert` (`packages/orchestrator/src/worker/stage-comment-manager.ts`)

**New public async method** on the existing `StageCommentManager` class. Companion to `updateStageComment`, sharing the same `github` / `owner` / `repo` / `issueNumber` / `logger` construction context.

**Signature**:
```ts
async postFailureAlert(data: FailureAlertData): Promise<void>;
```

**Behavior**:
1. Compose the marker: `` `${FAILURE_ALERT_MARKER_PREFIX}${data.stage}:${data.runId} -->` ``.
2. Call `this.github.getIssueComments(this.owner, this.repo, this.issueNumber)`.
3. Iterate the returned comments; if any body includes the marker, log `info` (`Failure alert already exists — suppressing duplicate post`) and return without posting.
4. Otherwise, render the alert body via a private `renderFailureAlert(marker, data)` (see contracts) and call `this.github.addIssueComment(this.owner, this.repo, this.issueNumber, body)`.
5. Log `info` (`Posted failure alert comment`) with `{ stage, runId, commentId }`.

**Contract**:
- MUST call `addIssueComment` (NOT `updateComment`) — this is the notification-firing distinction (see plan.md D1).
- MUST call `getIssueComments` BEFORE `addIssueComment`. The dedup scan is the first API call.
- MUST NOT throw on dedup hit — a repeated invocation for the same `(stage, runId)` is a no-op.
- MAY throw on GitHub API errors from `getIssueComments` or `addIssueComment`. The caller (`phase-loop.ts`) already runs adjacent to a `return { ..., completed: false }` — surfacing a rare GitHub API failure with a stack trace is acceptable and preferable to a silent swallow.

## No changes to existing surfaces

### `PhaseResult` — unchanged

All fields the alert needs are already present:

```ts
export interface PhaseResult {
  phase: WorkflowPhase;      // → data.phase
  success: boolean;
  exitCode: number;          // → evidence.exitDescriptor (via buildErrorEvidence)
  durationMs: number;
  output: OutputChunk[];
  sessionId?: string;
  gateHit?: { gateLabel: string; reason: string };
  error?: {
    message: string;         // → evidence.exitDescriptor (via buildErrorEvidence)
    stderr: string;          // → evidence.stderrTail (via buildErrorEvidence → boundStderrTail)
    phase: WorkflowPhase;
  };
  implementResult?: ImplementPartialResult;
}
```

### `StageCommentData` — unchanged

The canonical stage-comment surface is preserved byte-identically (FR-008). `errorEvidence` is read by both `renderStageComment` (existing, from `#847`) and by `phase-loop.ts` on its way to `postFailureAlert` (new). No mutation of the shape, no new field.

### `GitHubClient` — unchanged

Reuses existing methods:
- `getIssueComments(owner, repo, issueNumber): Promise<{ id: number; body: string }[]>` — same call as `findOrCreateStageComment`.
- `addIssueComment(owner, repo, issueNumber, body): Promise<{ id: number }>` — same call as `findOrCreateStageComment`.

No new methods, no new fields on the response types.

## Side-effect ordering (behavioral)

For a terminal-error site, before this change:
1. Log the phase failure.
2. `labelManager.onError(phase)`.
3. `stageCommentManager.updateStageComment({ status: 'error', ..., errorEvidence: this.buildErrorEvidence(...) })` — in-place edit (silent).
4. `return { results, completed: false, lastPhase: phase, gateHit: false }`.

After this change:
1. Log the phase failure.
2. `labelManager.onError(phase)`.
3. `const evidence = this.buildErrorEvidence(...)`. **← extracted so both calls share the same object (FR-008)**
4. `stageCommentManager.updateStageComment({ status: 'error', ..., errorEvidence: evidence })` — in-place edit (silent). **Unchanged.**
5. `stageCommentManager.postFailureAlert({ stage, runId, phase, evidence })` — new bottom-of-thread comment (notifies). **← new**
6. `return { results, completed: false, lastPhase: phase, gateHit: false }`.

Two additive steps: extract `evidence` into a shared variable, then post the alert. Existing steps unchanged in order and semantics.

For the no-progress site (`phase-loop.ts:~278`), before this change:
1. Log the no-progress observation.
2. `labelManager.onError(phase)`.
3. `stageCommentManager.updateStageComment({ status: 'error', ..., prUrl: context.prUrl })` — **NO `errorEvidence` argument**.
4. Set `result.success = false; result.error = { message, stderr: '', phase }`.
5. `return { results, completed: false, lastPhase: phase, gateHit: false }`.

After this change (FR-007 closes the evidence gap):
1. Log the no-progress observation.
2. Set `result.success = false; result.error = { message, stderr: 'no progress: tasks_remaining stayed at N ...', phase }`. **← moved earlier so evidence has data to read**
3. `const evidence = this.buildErrorEvidence(phase, result)`. **← new**
4. `labelManager.onError(phase)`.
5. `stageCommentManager.updateStageComment({ status: 'error', ..., prUrl: context.prUrl, errorEvidence: evidence })`. **← errorEvidence argument added**
6. `stageCommentManager.postFailureAlert({ stage, runId, phase, evidence })`. **← new**
7. `return { results, completed: false, lastPhase: phase, gateHit: false }`.

Order reshuffled (setting `result.error` moves above `updateStageComment`) so that evidence derivation has data. The observable side-effect ordering is unchanged (labels → comment → return); the reshuffle is entirely internal to the guard block.

## `runId` scope (not a data type — behavioral)

`runId` is a `string` local to `PhaseLoop.executeLoop`. Minted at the top of the method:
```ts
const runId = crypto.randomUUID();
```
Captured by closure at each of the four terminal-error sites and passed as `data.runId` to `postFailureAlert`. NOT stored on `WorkerContext`, `PhaseResult`, `StageCommentData`, `FilesystemWorkflowStore`, or Redis. NOT logged as its own field on non-error paths (only appears in the log lines from `postFailureAlert` and in the marker).

**Uniqueness**: `crypto.randomUUID()` returns a 128-bit v4 UUID. Two concurrent `executeLoop` invocations on the same issue produce distinct `runId`s → distinct markers → distinct alerts, which is the intended behavior.

**Stability**: within one `executeLoop` invocation, the same `runId` is used for every terminal-error site the loop might hit. Multi-phase failures (rare — loop typically stops at first failure) share one marker → dedup suppresses second post. Restart mid-loop mints a new `runId` on the next invocation → possible fresh alert after restart, which is acceptable per Q4/A.

# Contract: `TerminalLabelOpError`

**Owner**: `packages/orchestrator/src/worker/terminal-label-op-error.ts` (NEW).
**Throwers**: `LabelManager.retryWithBackoff` (final-attempt exhaustion).
**Catchers**: `phase-loop.ts` and `claude-cli-worker.ts` (via `isTerminalLabelOpError(e)`); translated to `WorkerResult { status: 'failed-terminal' }`.

## Shape

```ts
export type TerminalLabelOpSite =
  | 'gate-hit'         // onGateHit — waiting-for:<gate> + agent:paused
  | 'phase-start'      // onPhaseStart — phase:<current>
  | 'phase-complete'   // onPhaseComplete — completed:<current>
  | 'error'            // onError — failed:<phase> + agent:error
  | 'resume-start'     // onResumeStart — cleanup waiting-for:* + add agent:in-progress
  | 'workflow-complete'; // onWorkflowComplete — remove agent:in-progress

export class TerminalLabelOpError extends Error {
  readonly site: TerminalLabelOpSite;
  readonly labelOp: string;
  readonly ghStderr: string;
  readonly cause?: unknown;

  constructor(args: {
    site: TerminalLabelOpSite;
    labelOp: string;
    ghStderr: string;
    cause?: unknown;
  });
}

export function isTerminalLabelOpError(e: unknown): e is TerminalLabelOpError;
```

## Fields

| Field       | Purpose                                                                                                             |
|-------------|---------------------------------------------------------------------------------------------------------------------|
| `site`      | Boundary that failed. Surfaces in the alert body's summary line so operators can triage without reading worker logs. |
| `labelOp`   | Human-readable descriptor of the failing operation (`"addLabels([waiting-for:merge-conflicts, agent:paused])"`).     |
| `ghStderr`  | Verbatim stderr from the failing `gh` invocation (already extracted into the underlying `Error.message` by `gh-cli.ts`). Passed through to the `<details><summary>stderr…` block in the alert body. |
| `cause`     | The underlying `Error` (or arbitrary thrown value). Retained for structured logging; not surfaced in the alert.     |

## Propagation Rules

- **R1**: `TerminalLabelOpError` is thrown ONLY from `LabelManager.retryWithBackoff` after `maxAttempts` (3) exhausted attempts.
- **R2**: Every `LabelManager` public method that calls `retryWithBackoff` passes a `{ site, labelOp }` context object so the error is constructed with the right site value. Sites and their public methods map 1:1 per the enum above.
- **R3**: The catch layer in `phase-loop.ts` (`pausePreMergeConflict` and any other on-boundary caller) wraps `TerminalLabelOpError` into a `PhaseLoopResult { status: 'failed-terminal' }`.
- **R4**: The catch layer in `claude-cli-worker.ts` `processItem` translates either a caught `TerminalLabelOpError` or a `PhaseLoopResult.status === 'failed-terminal'` into `WorkerResult { status: 'failed-terminal', failureMetadata }`.
- **R5**: The dispatcher never sees `TerminalLabelOpError` directly — it sees `WorkerResult`. A leaked terminal error at the dispatcher is a bug, and the dispatcher's generic `catch` will release the item (undesired, but not crash-looping because the FR-002 ensure-pass has already converged).

## Non-Rules

- **NR-1**: `TerminalLabelOpError` is NOT retry-eligible. `retryWithBackoff` throws it AFTER exhausting retries; catching it and calling `retryWithBackoff` again would double-retry. The type name intentionally reflects the terminal semantics.
- **NR-2**: `TerminalLabelOpError` is NOT a subclass of any other domain error — it is a fresh `extends Error` root, distinguishable from every other thrown value via `isTerminalLabelOpError()`.

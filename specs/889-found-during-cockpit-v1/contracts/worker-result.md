# Contract: `WorkerResult`

**Owner**: `packages/orchestrator/src/worker/worker-result.ts` (NEW).
**Consumers**: `WorkerDispatcher.runWorker`, `ClaudeCliWorker.processItem`.
**Stability**: internal to `@generacy-ai/orchestrator`; no cross-package export required in #889.

## Shape

```ts
export type WorkerResult =
  | { readonly status: 'completed' }
  | {
      readonly status: 'failed-terminal';
      readonly failureMetadata: {
        readonly site: 'gate-hit' | 'phase-start' | 'phase-complete' | 'error' | 'resume-start' | 'workflow-complete';
        readonly labelOp: string;
        readonly ghStderr: string;
      };
    };
```

## Semantics

| `status`            | Dispatcher action                                                                                                   |
|---------------------|---------------------------------------------------------------------------------------------------------------------|
| `'completed'`       | `queue.complete(workerId, item)`. Unchanged happy-path behavior.                                                    |
| `'failed-terminal'` | Best-effort recovery (agent:error label + failure-alert comment); then `queue.complete(workerId, item)` — NOT released. |

**Not represented in the union**: `'released'`. Release is the default behavior of `WorkerDispatcher.runWorker`'s `catch` block on an *unhandled throw* from the handler. Every generic error (network hiccup, unhandled TypeError, etc.) still releases as it does today. `failed-terminal` is only for cases that `processItem` explicitly caught and translated.

## Invariants

- **I1**: `WorkerHandler` never throws `TerminalLabelOpError` back at the dispatcher. That class is caught in `processItem` and translated to `failed-terminal`. A leaked `TerminalLabelOpError` at the dispatcher is a bug and would cause a release (undesired, but not a crash-loop because the FR-002 memoized ensure-pass has already created the missing label — the second reclaim converges).
- **I2**: On `status: 'failed-terminal'`, the dispatcher NEVER re-throws and NEVER calls `queue.release(...)`. The three best-effort recovery steps (agent:error, alert comment, SSE) each swallow their own errors.
- **I3**: `failureMetadata` is present-and-non-empty on the `failed-terminal` variant. Empty strings are legal but a lint smell — the fixture test uses non-empty values.

## Test Fixtures (referenced by `worker-dispatcher.terminal.test.ts`)

```ts
const FIXTURE_TERMINAL: WorkerResult = {
  status: 'failed-terminal',
  failureMetadata: {
    site: 'gate-hit',
    labelOp: 'addLabels([waiting-for:merge-conflicts, agent:paused])',
    ghStderr: "could not add label: 'waiting-for:merge-conflicts' not found",
  },
};
```

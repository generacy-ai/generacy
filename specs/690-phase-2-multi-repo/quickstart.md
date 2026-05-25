# Quickstart: Generic `phase:after` Extension Hook

## Registering a Handler

Pass handlers via `PhaseLoopDeps.phaseAfterHandlers` when constructing the phase loop:

```typescript
import { PhaseAfterHandler, PhaseAfterContext } from './types';

const myHandler: PhaseAfterHandler = async (ctx: PhaseAfterContext) => {
  console.log(`Phase ${ctx.phase} completed`);
  console.log(`PR URL: ${ctx.commitResult.prUrl}`);
  console.log(`Has changes: ${ctx.commitResult.hasChanges}`);

  // Access full WorkerContext fields
  console.log(`Working dir: ${ctx.workdir}`);
  console.log(`Issue: ${ctx.item.issueNumber}`);

  // Check abort signal
  if (ctx.signal.aborted) return;

  // Do post-phase work...
};

// In claude-cli-worker.ts (or wherever PhaseLoopDeps is constructed):
const loopResult = await phaseLoop.executeLoop(context, config, {
  labelManager,
  stageCommentManager,
  gateChecker,
  cliSpawner,
  outputCapture,
  prManager,
  conversationLogger,
  jobEventEmitter,
  phaseAfterHandlers: [myHandler],  // <-- register here
}, phaseSequence);
```

## Handler Behavior

- Handlers run **after** commit/push + label update, **before** gate check
- Handlers run only on **normal phase completion** (not WIP increments or retries)
- Handlers execute **sequentially** in array order
- First handler that **throws** stops remaining handlers and fails the phase
- **No handlers registered** = identical behavior to today

## Error Handling

```typescript
const failingHandler: PhaseAfterHandler = async (ctx) => {
  throw new Error('Something went wrong');
  // This stops all subsequent handlers
  // The phase fails and gate check is skipped
};

const secondHandler: PhaseAfterHandler = async (ctx) => {
  // This never runs if failingHandler throws first
};
```

## Testing

Run existing + new tests:

```bash
cd packages/orchestrator
pnpm test -- --run src/worker/__tests__/phase-loop.test.ts
```

# Contract: `resolveWorkerCount`

**Module**: `packages/generacy/src/cli/commands/launch/worker-count-resolver.ts` (NEW)
**Issue**: [#716](https://github.com/generacy-ai/generacy/issues/716)

## Signature

```ts
import type { LaunchConfig, LaunchOptions } from './types.js';

export interface WorkerCountResolution {
  workerCount: number;
  source: 'flag' | 'prompt' | 'default';
  tierCapSource: 'launch-config' | 'fallback';
  warnings: string[];
}

export const CLI_FALLBACK_TIER_CAP = 8;
export const SUGGESTED_FROM_HOST = 2;

export async function resolveWorkerCount(
  opts: LaunchOptions,
  launchConfig: LaunchConfig,
  isTTY: boolean,
): Promise<WorkerCountResolution>;
```

## Behavior

### Step 1 — Determine tier cap

```ts
const tierCap = launchConfig.tierCap ?? CLI_FALLBACK_TIER_CAP;
const tierCapSource = launchConfig.tierCap != null ? 'launch-config' : 'fallback';
```

If `tierCapSource === 'fallback'`, the caller emits:

> `tierCap fallback (${CLI_FALLBACK_TIER_CAP}) in use because launch-config did not include tierCap. Update once cloud companion lands.`

### Step 2 — Resolve worker count

#### Case A: `opts.workers` is set

```ts
if (opts.workers != null) {
  if (!Number.isInteger(opts.workers) || opts.workers < 1) {
    throw new Error(`--workers must be a positive integer; got: ${opts.workers}`);
  }
  if (opts.workers > tierCap) {
    throw new Error(
      `--workers=${opts.workers} exceeds tier cap of ${tierCap}` +
      (tierCapSource === 'fallback'
        ? ' (CLI fallback cap; real cap will be available after the cloud companion ships).'
        : '. Upgrade your tier at <cloud-app-url>/billing or reduce --workers.'),
    );
  }
  return { workerCount: opts.workers, source: 'flag', tierCapSource, warnings: [...] };
}
```

#### Case B: TTY available, no flag

```ts
const defaultWorkers = Math.min(tierCap, SUGGESTED_FROM_HOST);
const chosen = await promptWorkerCount(tierCap, defaultWorkers);
return { workerCount: chosen, source: 'prompt', tierCapSource, warnings: [...] };
```

#### Case C: No TTY, no flag (Q5)

```ts
const defaultWorkers = Math.min(tierCap, SUGGESTED_FROM_HOST);
return {
  workerCount: defaultWorkers,
  source: 'default',
  tierCapSource,
  warnings: [
    `No TTY detected and --workers not provided. Defaulting to ${defaultWorkers} workers. ` +
    `For reproducible scripted launches, pass --workers=${defaultWorkers} explicitly.`,
    ...,
  ],
};
```

## promptWorkerCount

Defined in `prompts.ts` alongside `promptClaimCode`:

```ts
import * as p from '@clack/prompts';

export async function promptWorkerCount(
  tierCap: number,
  defaultWorkers: number,
): Promise<number> {
  const value = await p.text({
    message: `How many workers should run on this host? (1–${tierCap})`,
    placeholder: String(defaultWorkers),
    initialValue: String(defaultWorkers),
    validate(input) {
      const trimmed = input.trim();
      if (!trimmed) return 'Please enter a number';
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return 'Must be a positive integer';
      }
      if (parsed > tierCap) {
        return `Cannot exceed tier cap of ${tierCap}`;
      }
      return undefined;
    },
  });
  exitIfCancelled(value);
  return Number((value as string).trim());
}
```

The `exitIfCancelled` guard already exists in `prompts.ts`; reuse it.

## Constants

```ts
export const CLI_FALLBACK_TIER_CAP = 8;     // Q3 — conservative cap until cloud field ships
export const SUGGESTED_FROM_HOST = 2;        // Q4 — v1 default before resource-aware logic
```

Both are exported for test reuse.

## Caller responsibilities

The caller (`launchAction` in `launch/index.ts`) is responsible for:
1. Computing `isTTY = process.stdout.isTTY === true` once before calling.
2. Emitting `resolution.warnings` via `p.log.warn` for each entry, before further user-visible CLI output.
3. Wrapping `resolveWorkerCount(...)` in a try/catch and `process.exit(1)` with the error message on throw (matches existing `fetchLaunchConfig` error handling pattern at `launch/index.ts:117-121`).
4. Threading `resolution.workerCount` into `scaffoldProject(projectDir, config, resolution.workerCount)`.
5. Storing `resolution.workerCount` for later use in the activation poll body (but note: in the cluster-launch flow, the orchestrator itself is the activation client — so the CLI's job is only to write `GENERACY_INITIAL_WORKERS=${WORKER_COUNT}` into compose; the orchestrator's `server.ts` reads that env var and threads it through `activate()`).

## Tests

Located at `packages/generacy/src/cli/commands/launch/__tests__/worker-count-resolver.test.ts`. Eight rows mirroring the behavioral matrix in `data-model.md`:

| # | opts.workers | tierCap | isTTY | expected workerCount | expected source | expected tierCapSource | expected warnings (count) |
|---|--------------|---------|-------|---------------------|-----------------|------------------------|--------------------------|
| 1 | 3            | 4       | true  | 3                   | flag            | launch-config          | 0                        |
| 2 | 3            | undef   | true  | 3                   | flag            | fallback               | 1 (fallback)             |
| 3 | 100          | 4       | true  | (throws)            | —               | —                      | error references upgrade |
| 4 | undef        | 4       | true  | (prompt result)     | prompt          | launch-config          | 0                        |
| 5 | undef        | undef   | true  | (prompt result)     | prompt          | fallback               | 1 (fallback)             |
| 6 | undef        | 4       | false | min(4,2)=2          | default         | launch-config          | 1 (no-TTY)               |
| 7 | undef        | undef   | false | min(8,2)=2          | default         | fallback               | 2 (no-TTY + fallback)    |
| 8 | undef        | 1       | true  | (prompt result)     | prompt          | launch-config          | 0; prompt default = 1    |

Row 4/5/8 mock `promptWorkerCount` via Vitest module-level mock to return a known value (no real Clack invocation).

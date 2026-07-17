# Data Model: Wire the smee doorbell end-to-end

## Overview

All new state is in-process (per-doorbell-run) or on-disk (a single
workspace-mirrored channel file). No new persistence layer, no schema
migration, no new IPC surface. Two module-local additions and one config
schema extension.

## Extended types (existing modules)

### `SmeeConfigSchema` (extension)

`packages/orchestrator/src/config/schema.ts`

```ts
export const SmeeConfigSchema = z.object({
  channelUrl: z.string().url().optional(),
  fallbackPollIntervalMs: z.number().int().min(30000).default(300000),
  channelFilePath: z.string().default('/var/lib/generacy/smee-channel'),
  /**
   * Cluster-scoped mirror path on the shared *_workspace volume. When set,
   * SmeeChannelResolver writes the resolved URL here (mode 0644) after the
   * cluster-internal atomic write succeeds. Mirror-write failures are
   * logged and non-fatal. Set to null / empty to disable mirroring.
   */
  workspaceMirrorPath: z
    .string()
    .default('/workspaces/.generacy/cockpit/smee-channel'),
});
```

**Loader override** (`packages/orchestrator/src/config/loader.ts`): env
`SMEE_WORKSPACE_MIRROR_PATH` overrides. Empty string disables the mirror
write entirely.

### `SmeeChannelResolverOptions` (extension)

`packages/orchestrator/src/services/smee-channel-resolver.ts`

```ts
export interface SmeeChannelResolverOptions {
  channelFilePath: string;
  presetUrl?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  /**
   * When set, resolver mirror-writes the resolved URL to this path (mode
   * 0644) alongside the cluster-internal write. Mirror-write failures are
   * logged and non-fatal. Undefined disables the mirror.
   */
  workspaceMirrorPath?: string;
}
```

**Behavior on `resolve()`**:
- After a successful tier-3 provision + persist, mirror-write.
- On a tier-2 persisted-read hit, mirror-write **iff** the mirror file
  either doesn't exist or its content differs from the persisted URL.

**Mode**: 0644. **Content**: bare URL, no metadata.

### `ChannelDiscoveryInput` (extension)

`packages/generacy/src/cli/commands/cockpit/doorbell/channel-discovery.ts`

```ts
export interface ChannelDiscoveryInput {
  env: NodeJS.ProcessEnv;
  channelFilePath: string;                    // cluster-internal fallback (unchanged default)
  fs: {
    readFile: (path: PathLike, encoding: BufferEncoding) => Promise<string>;
    stat?: (path: PathLike) => Promise<{ isFile(): boolean; isDirectory(): boolean }>;
  };
  logger?: { warn?: (msg: string) => void };
  /** Starting directory for the walk-up scan. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Absolute fallback if walk-up produces no hit. Defaults to `/workspaces/.generacy/cockpit/smee-channel`. */
  workspaceMirrorPath?: string;
}

export type ChannelSource = 'env' | 'workspace-walkup' | 'workspace-absolute' | 'file';

export interface ChannelDiscoveryResult {
  url: string;                                // must match SMEE_URL_PATTERN
  source: ChannelSource;
}
```

**Lookup order** (each stage returns on first match):
1. `env[COCKPIT_DOORBELL_SMEE_URL]` — if present and matches
   `SMEE_URL_PATTERN`, returns `{ source: 'env' }`.
2. Walk-up scan: starting at `cwd` (default `process.cwd()`), for each
   ancestor directory, attempt to read `<dir>/.generacy/cockpit/smee-channel`.
   First readable + `SMEE_URL_PATTERN`-matching file returns
   `{ source: 'workspace-walkup' }`. `ENOENT` moves to the next ancestor.
   Walk terminates at `path.parse(cwd).root`.
3. Absolute read of `workspaceMirrorPath` (default
   `/workspaces/.generacy/cockpit/smee-channel`). If readable + matches,
   returns `{ source: 'workspace-absolute' }`.
4. Absolute read of `channelFilePath` (default
   `/var/lib/generacy/smee-channel`). If readable + matches, returns
   `{ source: 'file' }`.

Malformed content or non-`ENOENT` errors at any stage log one warn and
proceed to the next stage. Complete miss returns `null` — the doorbell
starts in poll-fallback (unchanged behavior).

## New types

### `StartupRetrySchedule` (`packages/generacy/src/cli/commands/cockpit/doorbell/startup-retry.ts`)

```ts
export type GhErrorClass =
  | { kind: 'retriable'; hint: string }        // e.g. 'http-429', 'econnreset', 'http-503'
  | { kind: 'permanent'; reason: string };     // e.g. 'bad-credentials', 'not-found', 'malformed-output'

export interface StartupRetryOptions {
  /** Task run each attempt; must throw the raw gh error on failure. */
  task: () => Promise<unknown>;
  /** Human-readable label for logs. */
  label: 'acquireEpicBus' | 'resolveEpic';
  /** Injected rate-limit-aware scheduler (already wired in doorbellCommand). */
  rateLimitScheduler: RateLimitScheduler;
  /** Signal to abort retries when the doorbell stops. */
  abortSignal: AbortSignal;
  stderr: { write(chunk: string): boolean | void };
  logger: { warn: (msg: string) => void; info?: (msg: string) => void };
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  classify?: (err: unknown) => GhErrorClass;
  /**
   * Total time budget for the initial retry window before transitioning to
   * late-startup retry cadence. Default: 2 * 60_000 (~2 min).
   */
  initialWindowMs?: number;
  /**
   * Cadence of the late-startup retry after initial-window exhaustion.
   * Default: 5 * 60_000 (~5 min).
   */
  lateWindowIntervalMs?: number;
}

export type StartupRetryOutcome<T> =
  | { kind: 'success'; value: T }
  | { kind: 'permanent'; reason: string }      // caller emits stderr + exits 3
  | { kind: 'aborted' };                       // stop signal fired
```

**Semantics**:
- Attempt the task. On **success**, resolve `{ kind: 'success', value }`.
- On failure, call `classify(err)`:
  - **permanent**: emit `cockpit doorbell: permanent-error label=<label>
    reason=<reason>\n` on stderr; resolve `{ kind: 'permanent', reason }`.
    Caller (`runDoorbell`) exits with code `3`.
  - **retriable**:
    - If `now - startedAt < initialWindowMs`: sleep for
      `rateLimitScheduler.getCurrentIntervalMs()` (respecting
      `Retry-After` via `noteRetryAfter` if the error message contains
      one), then retry.
    - Otherwise: transition to late-window cadence. Sleep
      `lateWindowIntervalMs`, retry indefinitely until success, permanent,
      or `abortSignal` fires.
- On `abortSignal`, resolve `{ kind: 'aborted' }`. Caller drops the retry
  and proceeds to normal teardown.

**Diagnostic outputs** (stderr, one per event):
- On first retriable failure: `cockpit doorbell: startup-retry label=<label>
  reason=<hint> attempt=1\n`.
- On transition to late-window: `cockpit doorbell: startup-retry-exhausted
  label=<label> transitioning to late-startup retry\n`.
- On late-window recovery: `cockpit doorbell: startup-retry-recovered
  label=<label>\n`.
- On permanent error: `cockpit doorbell: permanent-error label=<label>
  reason=<reason>\n`.

### `classifyGhError` (helper)

```ts
export function classifyGhError(err: unknown): GhErrorClass;
```

Rules (see `research.md` Q4 for full rationale):

- **`err.code`** (Node error codes) → retriable:
  `ECONNRESET | ETIMEDOUT | ENOTFOUND | ECONNREFUSED | EPIPE`.
- **Message HTTP status marker** `429 | 500 | 502 | 503 | 504` → retriable
  with `hint = 'http-<status>'`.
- **Message includes `socket hang up`** → retriable with `hint = 'socket-hang-up'`.
- **Message HTTP `401`** or `Bad credentials` → permanent with
  `reason = 'bad-credentials'`.
- **Message HTTP `403`** or SAML/scope markers → permanent with
  `reason = 'scope-or-sso'`.
- **Message HTTP `404`** or "Could not resolve to an Issue" → permanent
  with `reason = 'not-found'`.
- **Message includes `parsing`/`expected JSON`** → permanent with
  `reason = 'malformed-output'`.
- **Default** (unrecognized) → permanent with `reason = 'unknown'`.

## Integration into `runDoorbell`

`runDoorbell` (`packages/generacy/src/cli/commands/cockpit/doorbell.ts`)
wraps the two startup call sites in `StartupRetrySchedule.runWithRetry`:

1. `runPollMode` — replace the raw `acquire(...)` call at line 149 with:
   ```ts
   const outcome = await runStartupRetry({
     task: () => acquire(acquireOptions),
     label: 'acquireEpicBus',
     rateLimitScheduler: deps.rateLimitScheduler,
     abortSignal: stopSignal,
     stderr, logger,
   });
   ```
   Then dispatch on `outcome.kind`.

2. `runSmeeMode` — replace `await source.start()` at line 236 with:
   ```ts
   const outcome = await runStartupRetry({
     task: () => source.start(),
     label: 'resolveEpic',
     ...
   });
   ```

If `outcome.kind === 'permanent'`, `runDoorbell` returns `3` (caller invokes
`exit(3)`). If `outcome.kind === 'aborted'`, it returns `0` (normal
shutdown). Only `outcome.kind === 'success'` continues to the next stage.

## Removed / renamed types

None. All changes are additive.

## State machine changes

None. `SourceSelector` state machine is unchanged. See `research.md` Q6.

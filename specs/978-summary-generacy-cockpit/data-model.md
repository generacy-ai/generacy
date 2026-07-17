# Data Model: Cockpit doorbell smee source

## Overview

All new state is in-process and per-doorbell-run. No persistence layer,
no shared memory with the orchestrator process, no cross-process signal.

## Core interfaces

### `ChannelDiscoveryInput` / `ChannelDiscoveryResult`

```ts
export interface ChannelDiscoveryInput {
  env: NodeJS.ProcessEnv;
  channelFilePath: string;         // default: '/var/lib/generacy/smee-channel'
  fs: Pick<typeof import('node:fs/promises'), 'readFile'>;
  logger?: { warn?: (msg: string) => void };
}

export type ChannelSource = 'env' | 'file';

export interface ChannelDiscoveryResult {
  url: string;                     // must match SMEE_URL_PATTERN
  source: ChannelSource;
}
```

**Validation**: `url` must match
`/^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/`. Any other input returns `null`.

### `RefSetView`

```ts
export interface RefSetView {
  epicRef: string;                 // "owner/repo#N"
  epicNumber: number;
  epicRepo: string;                // "owner/repo"
  issues: Set<string>;             // "owner/repo#N" for each parsed issue ref
  prs: Set<string>;                // "owner/repo#N" for each parsed pr ref (may overlap issues)
  watchedRepos: Set<string>;       // "owner/repo" for coarse pre-filter
}
```

**Derived from**: `ResolvedEpic.parsed.allRefs` (via `resolveEpic`).

**Refreshed**:
- Startup — once.
- On any `issues` payload where `issue.number === epicNumber && action ∈
  {edited, labeled, unlabeled}`.
- Safety-net timer every 10 min.

Debounced 500 ms across the first two triggers to collapse edit bursts.

### `SmeeDoorbellSourceOptions`

```ts
export interface SmeeDoorbellSourceOptions {
  channelUrl: string;
  epicRef: string;
  gh: GhWrapper;
  runner?: CommandRunner;
  logger: { warn: (msg: string) => void; info?: (msg: string) => void };
  onEvent: (event: CockpitStreamEvent) => Promise<void>;
  onReconnectAttempt: (failedAttempts: number) => void;
  onReconnectSuccess: () => void;
  onRefSetRefreshFailure?: (err: unknown) => void;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  refreshDebounceMs?: number;      // default 500
  safetyNetIntervalMs?: number;    // default 600_000 (10 min)
  baseReconnectDelayMs?: number;   // default 5_000
}
```

### `SmeeDoorbellSource` public API

```ts
export class SmeeDoorbellSource {
  constructor(options: SmeeDoorbellSourceOptions);
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

**Internal state**:

```ts
interface InternalState {
  refSet: RefSetView | null;                // null until first resolveEpic
  aggState: AggregateState;                 // initial: { seenCompletePhases: new Set(), epicComplete: false }
  prev: SnapshotMap;                        // initial: new Map()
  currentResolved: ResolvedEpic | null;
  reconnectAttempt: number;                 // 0-indexed, capped at 6 (~5-min ceiling)
  running: boolean;
  abortController: AbortController | null;
  refreshTimer: NodeJS.Timeout | null;      // safety-net
  refreshDebounceTimer: NodeJS.Timeout | null;
}
```

### `SourceSelector`

```ts
export type SourceMode = 'smee-attempt' | 'smee-active' | 'poll-fallback';

export interface SourceSelectorOptions {
  initial: 'smee-attempt' | 'poll-fallback';
  stderr: { write(chunk: string): boolean | void };
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
  demoteAfterConsecutiveFailures?: number;   // default 5
  demoteAfterMsWithoutSuccess?: number;      // default 300_000 (5 min)
  rePromoteIntervalMs?: number;              // default 300_000 (5 min)
  now?: () => number;
}

export type SourceReason =
  | 'startup-no-channel'
  | 'startup-smee-selected'
  | 'smee-runtime-lost'
  | 'smee-re-promoted';

export class SourceSelector {
  constructor(options: SourceSelectorOptions);
  currentSource: SourceMode;                 // read-only
  onReconnectAttempt(failedAttempts: number): void;
  onReconnectSuccess(): void;
  observeElapsed(): void;                    // called by a per-second tick
  onModeChange(cb: (next: SourceMode, reason: SourceReason) => void): void;
  stop(): void;                              // clears timers
}
```

**State fields**:

```ts
interface SelectorState {
  current: SourceMode;
  consecutiveReconnectFailures: number;
  lastSuccessfulConnectAt: number | null;
  demotedAt: number | null;
  rePromoteTimer: NodeJS.Timeout | null;
  elapsedTicker: NodeJS.Timeout | null;
  modeChangeCbs: Array<(next: SourceMode, reason: SourceReason) => void>;
}
```

## Validation rules

### `SMEE_URL_PATTERN`

`/^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/`

Sourced from
`packages/orchestrator/src/services/smee-channel-resolver.ts:27`. Copied
verbatim to avoid an orchestrator import in the CLI.

### Payload discriminator (`webhookToStreamEvent` inputs)

```ts
interface NormalizedPayload {
  githubEvent: string;              // from smee.io's "x-github-event"
  action: string;                   // from body.action
  body: Record<string, unknown>;    // smee.io's "body" field
}
```

Extracted from the SSE JSON:
- `x-github-event` at top level → `githubEvent`
- `body.action` → `action`
- `body` → `body`

### `webhookToStreamEvent` output type

Same as `CockpitStreamEvent` (`packages/generacy/src/cli/commands/cockpit/watch/stream-event.ts`):

```ts
type CockpitStreamEvent =
  | CockpitEventValidated         // issue-transition
  | PhaseCompleteEvent
  | EpicCompleteEvent;
```

Where `CockpitEventValidated.event ∈ {label-change, issue-closed,
pr-merged, pr-closed, pr-checks}` (Q1=A: unchanged).

## Relationships

```
runDoorbell
  ├─ discoverChannelUrl() ───► ChannelDiscoveryResult | null
  │
  ├─ SourceSelector ──── onModeChange ──► runSmeeMode | runPollMode
  │       │
  │       ├─ onReconnectAttempt / onReconnectSuccess (from SmeeDoorbellSource)
  │       └─ observeElapsed() (per-second tick)
  │
  └─ runSmeeMode:
        ├─ resolveEpic ──► ResolvedEpic ──► RefSetView
        │
        ├─ SmeeDoorbellSource
        │     ├─ fetch(channelUrl) ──► SSE reader loop
        │     ├─ parseSseEventBlock ──► NormalizedPayload
        │     ├─ webhookToStreamEvent(refSet, ...) ──► CockpitStreamEvent | null
        │     └─ maybeRefreshAggregate ──► extra CockpitStreamEvent[]
        │
        └─ onEvent ──► stdout via lineForEvent
```

## Lifecycle

### Doorbell process startup

1. Parse args, validate form.
2. `writeLine('armed\n')` — Q5=A.
3. `discoverChannelUrl(...)` → result or null.
4. Construct `SourceSelector` with `initial: 'smee-attempt' | 'poll-fallback'`.
5. Emit initial `source=…` stderr line via `SourceSelector.transitionTo(...)`.
6. Enter `runSmeeMode` or `runPollMode`.

### Runtime transitions

- Smee-mode → poll-fallback: `SmeeDoorbellSource.stop()`, then start
  `runPollMode` block (extract of today's `acquire → subscribe → wait`).
  Emit `source=poll-fallback reason=smee-runtime-lost`.
- Poll-fallback → smee-mode (re-promote): `runPollMode` block released,
  new `SmeeDoorbellSource.start()` attempted. On connect success, emit
  `source=smee reason=smee-re-promoted`. On connect fail, silently stay
  in poll-fallback (no source= line yet — the next re-promote timer will
  retry). The counter resets on any successful connect.

### Shutdown

- `SIGINT/SIGTERM` or `--exit-on-epic-complete` reaches `epic-complete`.
- Call `SmeeDoorbellSource.stop()` and/or `poll-mode release()`.
- `SourceSelector.stop()` clears timers.
- Drain stdout, exit 0.

## Constants

| Name | Value | Location |
|---|---|---|
| `DEFAULT_CHANNEL_FILE_PATH` | `'/var/lib/generacy/smee-channel'` | `channel-discovery.ts` |
| `SMEE_URL_PATTERN` | `/^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/` | `channel-discovery.ts` |
| `DEFAULT_REFRESH_DEBOUNCE_MS` | `500` | `smee-source.ts` |
| `DEFAULT_SAFETY_NET_INTERVAL_MS` | `600_000` (10 min) | `smee-source.ts` |
| `DEFAULT_BASE_RECONNECT_DELAY_MS` | `5_000` | `smee-source.ts` |
| `MAX_BACKOFF_MS` | `300_000` (5 min) | `smee-source.ts` |
| `DEFAULT_DEMOTE_AFTER_FAILURES` | `5` | `source-selector.ts` |
| `DEFAULT_DEMOTE_AFTER_MS_WITHOUT_SUCCESS` | `300_000` (5 min) | `source-selector.ts` |
| `DEFAULT_RE_PROMOTE_INTERVAL_MS` | `300_000` (5 min) | `source-selector.ts` |
| `AGGREGATE_TRIGGER_DEBOUNCE_MS` | `500` | `aggregate-on-demand.ts` |

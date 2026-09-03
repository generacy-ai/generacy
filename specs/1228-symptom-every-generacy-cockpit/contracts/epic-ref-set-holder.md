# Contract: `EpicRefSetHolder`

**Feature**: #1228 | **File**: `packages/generacy/src/cli/commands/cockpit/doorbell/ref-set-holder.ts`

## Purpose

Single shared owner of the bound epic's resolved ref set (`RefSetView` via `buildRefSet`)
so that one refresh feeds every consumer: `SmeeDoorbellSource` (webhook-debounce +
safety-net triggers) and `AnswersFileSource` (unknown-ref miss triggers). Required by
FR-001/FR-002; clarify Q3 → option B.

## Public Interface

```ts
export class EpicRefSetHolder {
  constructor(opts: {
    epicRef: string;                   // owner/repo#N (validated)
    gh: GhWrapper;
    logger: { warn(m: string): void; info?(m: string): void };
    resolve?: typeof resolveEpic;      // test seam
    missRefreshMinIntervalMs?: number; // default 30_000
    now?: () => number;
  });

  /** Current ref set; null until the first successful refresh(). */
  get current(): RefSetView | null;
  /** Last successful ResolvedEpic (smee aggregate refresh needs it). */
  get resolved(): ResolvedEpic | null;

  /** Unthrottled resolve+store. Throws on failure ONLY when there is no prior
   *  successful set (startup — caller demotes to poll-fallback); after first
   *  success, failures warn and retain the previous set. */
  refresh(): Promise<void>;

  /** Throttled resolve for the tailer's unknown-ref path. If a resolve ran within
   *  missRefreshMinIntervalMs, returns immediately without resolving. Never throws;
   *  failures warn and retain the previous set. Concurrent calls share one
   *  in-flight resolve. */
  refreshOnMiss(): Promise<void>;
}
```

## Guarantees

1. **Never degrades**: after the first successful resolve, `current` is never null and a
   failed refresh keeps the previous set.
2. **Throttle**: `refreshOnMiss()` performs at most one `resolveEpic` per
   `missRefreshMinIntervalMs` (default 30 s), regardless of caller count; the throttle
   window is shared with `refresh()` executions (an unthrottled refresh also resets it).
3. **Single flight**: overlapping refresh calls coalesce onto one in-flight
   `resolveEpic` promise.
4. **Same construction as smee**: the stored set is exactly `buildRefSet(resolved)` — the
   epic itself is always a member; repo keys are lowercased.

## Consumer contracts

- **SmeeDoorbellSource**: replaces its private `refSet`/`currentResolved` fields with
  reads of `holder.current` / `holder.resolved`; its startup blocking resolve calls
  `holder.refresh()` and still propagates the failure (poll-fallback demotion
  unchanged); debounced webhook and safety-net refreshes call `holder.refresh()`.
  `onRefSetRefreshFailure` semantics unchanged.
- **AnswersFileSource**: reads `holder.current` for the scope test; on an unknown
  issue-ref awaits `holder.refreshOnMiss()` and re-checks once; drops (+`info` log) only
  if still foreign. When constructed **without** a holder (hermetic harness mode,
  `COCKPIT_DOORBELL_HARNESS=1`, no gh), the tailer applies the legacy case-insensitive
  owner/repo compare instead — see research.md D3.

## Non-goals

- No caching TTL / background refresh of its own — cadence is driven entirely by
  consumers' triggers (webhook debounce, safety-net timer, unknown-ref miss).
- No scope mutation (`cockpit_scope_add` writes the epic body; the holder only reads).

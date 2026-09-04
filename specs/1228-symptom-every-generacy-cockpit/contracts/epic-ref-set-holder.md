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
   *  in-flight resolve. The returned outcome tells the caller whether the set it
   *  is about to read is AUTHORITATIVE for a permanent-drop decision. */
  refreshOnMiss(): Promise<MissRefreshOutcome>;
}

export type MissRefreshOutcome =
  | 'resolved'         // a resolve ran and succeeded — authoritative
  | 'throttled'        // no resolve ran; last attempt SUCCEEDED in-window — authoritative
  | 'throttled-stale'  // no resolve ran; last attempt FAILED — NOT authoritative
  | 'failed';          // a resolve ran and threw; previous set (if any) retained
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
  issue-ref awaits `holder.refreshOnMiss()` and re-checks once. The re-check's disposition
  depends on the outcome, because advance-on-emit makes a wrong drop permanent:
  - set present + `resolved` / `throttled` / `failed` ⇒ drop (+`info` log). The
    re-resolve duty of FR-002 is discharged (or the set is provably fresh).
  - set present + `throttled-stale` ⇒ **defer** the line: leave the cursor un-advanced
    and retry on the next tick. No authoritative re-resolve has happened, so a
    late-created child would otherwise be lost. Self-limiting — the throttle window
    expires within `missRefreshMinIntervalMs`.
  - **no set at all** (the oracle has never resolved successfully — startup 403 / rate
    limit) ⇒ **fail open** to the legacy case-insensitive owner/repo compare, with a
    `warn`. Testing membership against a null set rejects every answer *including the
    bound epic's own*, so the pre-#1228 repo-granular scope is strictly better than
    dropping blind.

  When constructed **without** a holder (hermetic harness mode,
  `COCKPIT_DOORBELL_HARNESS=1`, no gh), the tailer applies the legacy case-insensitive
  owner/repo compare instead — see research.md D3.

## Non-goals

- No caching TTL / background refresh of its own — cadence is driven entirely by
  consumers' triggers (webhook debounce, safety-net timer, unknown-ref miss).
- No scope mutation (`cockpit_scope_add` writes the epic body; the holder only reads).

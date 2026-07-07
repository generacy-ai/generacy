# Data Model — #836

**No new data model.** This is a runtime-behavior bugfix in a single helper function; nothing about types, interfaces, or persisted state changes.

The existing `WatchDeps` interface (`packages/generacy/src/cli/commands/cockpit/watch.ts` lines 63–71) is unchanged:

```ts
export interface WatchDeps {
  gh?: GhWrapper;
  runner?: CommandRunner;
  logger?: { warn: (msg: string) => void };
  intervalOverride?: number;
  onTick?: () => void;
  /** Optional external abort — used by tests to stop the loop deterministically. */
  abortSignal?: AbortSignal;
}
```

Q2 explicitly defers adding `unrefTimer?: boolean` — no shape change in this PR.

The `SnapshotMap`, `WatchEvent`, `ResolvedEpic`, and NDJSON transition-line schemas are all unchanged (out of scope per spec).

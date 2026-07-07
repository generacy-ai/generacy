# Data Model: `cockpit advance` label-pair fix (#845)

This change introduces **no new types**, no new persisted state, and no new relay payloads. It removes one side-effect from an existing command and updates human-facing text on three surfaces.

## Existing types (referenced, unchanged)

### `ManualAdvanceMarker` (`packages/generacy/src/cli/commands/cockpit/manual-advance-marker.ts`)

```ts
export interface ManualAdvanceMarker {
  gate: string;
  actor?: string;
  ts: string;
}
```

- Validation regexes unchanged (`GATE_REGEX = /^[a-z][a-z0-9-]*$/`, `ACTOR_REGEX = /^[A-Za-z0-9-]+$/`).
- The `formatManualAdvanceComment(marker)` return string changes in its *sentence text* only. The HTML-comment prelude is byte-stable.

### `GateDefinition` (`packages/generacy/src/cli/commands/cockpit/gate-vocabulary.ts`)

```ts
interface GateDefinition {
  name: string;
  waitingLabel: string;   // "waiting-for:<name>"
  completedLabel: string; // "completed:<name>"
  // …
}
```

- Referenced by `advance.ts`. Unchanged.

### `AdvanceOptions` (`packages/generacy/src/cli/commands/cockpit/advance.ts`)

```ts
interface AdvanceOptions {
  gate?: string;
  helpGates?: boolean;
}
```

- Unchanged. No `--force` flag introduced (per spec: "Keep the idempotence/gate-mismatch checks unchanged").

## Label-pair invariant (behavioral, not typed)

The change enforces at the CLI layer an invariant already enforced at the orchestrator layer:

> **Poll-path resume requires BOTH `waiting-for:<gate>` AND `completed:<gate>` on the issue.**
>
> - The monitor (`label-monitor-service.ts:156–180`) verifies this pair; a `completed:*` without its `waiting-for:*` is logged as an orphan and returns `null` (no `resume` event).
> - The worker's resume path owns clearing all three of `waiting-for:*`, `completed:*`, and `agent:paused`.
> - Therefore: no caller (this command, future advance wrappers, or manual operator flows) may remove `waiting-for:*`.

This invariant is documented in `advance.ts`'s rewritten header comment and in `tetrad-development/docs/label-protocol.md`.

## Side-effect ordering (behavioral)

Before this change (`runAdvance` happy path):
1. `postIssueComment(marker)`
2. `addLabel(completed:<gate>)`
3. `removeLabel(waiting-for:<gate>)` ← **REMOVED**

After this change:
1. `postIssueComment(marker)`
2. `addLabel(completed:<gate>)`

No new steps. No reordering of the remaining two.

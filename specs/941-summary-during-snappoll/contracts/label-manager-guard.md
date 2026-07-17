# Contract: `LabelManager.applyLabels` guard (FR-003)

## Purpose

Reject any orchestrator-internal write of `completed:<human-gate>` at the label-writing seam, before the call reaches GitHub. Provides the diagnostic surface for the anonymous-advance defect in #941 and forecloses re-introduction by future refactors.

## Signature change

```ts
class LabelManager {
  // BEFORE
  private async applyLabels(labels: string[]): Promise<void>;

  // AFTER
  private async applyLabels(
    labels: string[],
    allow?: AllowGateComplete,
  ): Promise<void>;
}
```

- `labels`: array of label names to add. Unchanged.
- `allow`: **NEW**, optional token from the closed union `AllowGateComplete`. When present, the guard is bypassed for the entire call (opting the caller in as an authorized human-gate completer).

## Public API additions

```ts
// packages/orchestrator/src/worker/label-manager.ts

export const AllowGateComplete: Readonly<{
  readonly CockpitAdvance: 'cockpit-advance';
}>;

export type AllowGateComplete =
  (typeof AllowGateComplete)[keyof typeof AllowGateComplete];

export class HumanGateCompletionUnauthorizedError extends Error {
  readonly label: string;
  readonly allowedTokens: readonly string[];
}

/** Predicate exposed for reuse and testability. */
export function isHumanGateCompletion(label: string): boolean;
```

## Invariants

1. **Rejection is synchronous and pre-network.** The guard throws before any HTTP call. `HumanGateCompletionUnauthorizedError` never surfaces as a wire error, only as a code-side exception.
2. **Rejection is per-label, not per-call.** If `labels = ['agent:paused', 'completed:implementation-review']` is passed without a token, the whole call throws — no partial writes.
3. **Phase completions are always allowed.** `completed:implement`, `completed:validate`, `completed:tasks`, `completed:specify`, `completed:clarify`, `completed:plan` all pass the guard token-less because their suffixes are never in `HUMAN_GATE_SUFFIXES`.
4. **Non-`completed:*` labels are unaffected.** `phase:*`, `waiting-for:*`, `agent:*`, `failed:*`, `blocked:*`, `workflow:*` etc. flow through untouched.
5. **The token is one-way opt-in.** Presence of `allow` bypasses the guard for that call regardless of value (there is only one legal value; passing a bogus value that satisfies the TypeScript type is a build-side concern, not a runtime one).
6. **Guard interacts predictably with `retryWithBackoff`.** A guarded throw is a permanent error, but the retry loop retries three times anyway — the surfaced `TerminalLabelOpError.cause` will be `HumanGateCompletionUnauthorizedError`. This is the intended diagnostic surface.

## Human-gate suffix set

Computed once at module load from `phase-resolver.js` exports:

```
Object.keys(GATE_MAPPING) ∪ ⋃ Object.keys(WORKFLOW_GATE_MAPPING[*])
```

Current effective set:

```
clarification, spec-review, plan-review, tasks-review,
implementation-review, sibling-review, merge-conflicts
```

Future gate names automatically inherit the guard.

## Error shape

```ts
throw new HumanGateCompletionUnauthorizedError('completed:implementation-review');
```

- `err.message` — human-readable, includes the offending label and the list of allowed tokens.
- `err.label` — machine-parseable, the label that failed the check.
- `err.allowedTokens` — snapshot of `Object.values(AllowGateComplete)` at construction time.

## Test surface (FR-007)

- Given no token, adding `completed:<any human-gate>` → throws `HumanGateCompletionUnauthorizedError`. Verify each suffix individually.
- Given `AllowGateComplete.CockpitAdvance`, adding `completed:<any human-gate>` → passes to `github.addLabels`.
- Given no token, adding `completed:<any WorkflowPhase>` → passes to `github.addLabels`.
- Given no token, adding non-`completed:*` labels → passes to `github.addLabels`.
- Batched calls with mixed labels reject atomically (no partial writes).

## Non-goals

- **No test for retry behavior.** `retryWithBackoff` retrying an authorization error 3× is inefficient but not wrong; adding a `no-retry` predicate is out of scope for this change.
- **No new logging inside the guard.** The existing `retryWithBackoff` failure log at attempt 3 already carries `{ site, labelOp, error }`; the `HumanGateCompletionUnauthorizedError.message` is self-descriptive.
- **No dynamic mutation of `AllowGateComplete`.** The frozen object is a compile-time closed union. Adding a member requires a code change + audit-marker design.

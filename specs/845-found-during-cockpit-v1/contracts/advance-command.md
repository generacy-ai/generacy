# Contract: `runAdvance` (updated for #845)

**Module**: `packages/generacy/src/cli/commands/cockpit/advance.ts`
**Function**: `runAdvance(issue, opts, deps)`
**Delta reason**: Poll-path resume detection in `label-monitor-service.ts` requires `waiting-for:<gate>` AND `completed:<gate>` present at scan time. Removing `waiting-for:*` in `advance` strands issues on poll-only clusters.

## Signature

Unchanged.

```ts
export async function runAdvance(
  issue: string | undefined,
  opts: AdvanceOptions,
  deps: AdvanceCommandDeps,
): Promise<void>;
```

## Side-effect contract (happy path)

**Before** (contract removed):

1. `gh.postIssueComment(nwo, number, markerBody)`
2. `gh.addLabel(nwo, number, "completed:<gate>")`
3. `gh.removeLabel(nwo, number, "waiting-for:<gate>")` ← **REMOVED**

**After** (contract enforced):

1. `gh.postIssueComment(nwo, number, markerBody)`
2. `gh.addLabel(nwo, number, "completed:<gate>")`

### Invariants

- **I-1 (label-pair)**: `runAdvance` MUST NOT call `gh.removeLabel` with any label whose name starts with `waiting-for:`. Verified by test (`advance.test.ts`, regression case).
- **I-2 (ordering)**: The marker comment MUST be posted before the `completed:<gate>` label is added, so that timeline order for later readers matches semantic order.
- **I-3 (idempotence, AD-6)**: If `completed:<gate>` is already present on the issue at the top of `runAdvance`, the function returns `void` after printing `already advanced <ref>: completed:<gate> is present (no-op)` — no comment posted, no label mutation.
- **I-4 (refusal, AD-4)**: If an active `waiting-for:*` label exists and does not equal `waiting-for:<gate>`, the function throws `CockpitExit(3)` before any side effect.

## Failure modes (unchanged)

| Condition | Exit code | Message shape |
|---|---|---|
| Missing `<issue>` arg | 2 | `Error: cockpit advance: missing required argument <issue>` |
| Missing `--gate` option | 2 | `Error: cockpit advance: missing required option --gate` |
| Unknown gate name | 2 | `Error: cockpit advance: unknown gate "<name>". Valid gates: …` |
| Invalid issue ref | 2 | `Error: cockpit advance: <parse error>` |
| `gh issue view` fails | 1 | `Error: cockpit advance: gh issue view: <cause>` |
| Gate refusal (I-4) | 3 | `Error: cockpit advance: gate refusal: issue <ref> is …` |
| `gh issue comment` fails | 1 | `Error: cockpit advance: gh issue comment: <cause>` |
| `gh issue edit` (add) fails | 1 | `Error: cockpit advance: gh issue edit (add completed:<gate>): <cause>` |

Note: The `gh issue edit (remove waiting-for:*): <cause>` failure mode is **removed** — the call no longer exists.

## Stdout summary (happy path)

**Before**:
```
advanced <owner>/<repo>#<n>: waiting-for:<gate> → completed:<gate> (comment: <url>)
```

**After** (per clarifications Q1→C):
```
advanced <owner>/<repo>#<n>: completed:<gate> added — waiting-for:<gate> left in place for the worker to clear on resume (comment: <url>)
```

- The `(comment: <url>)` suffix is emitted only when `commentUrl` is truthy (unchanged behavior).
- Idempotence and refusal messages unchanged.

## Test signals

- **SC-002**: Existing happy-path `expect(calls).toEqual([...])` assertion is updated to drop the trailing `remove:waiting-for:<gate>` entry.
- **SC-003 (regression)**: New assertion in the happy-path test:
  ```ts
  const removeSpy = gh.removeLabel as ReturnType<typeof vi.fn>;
  for (const call of removeSpy.mock.calls) {
    expect(call[2]).not.toMatch(/^waiting-for:/);
  }
  ```
  Deleting the fix reintroduces the removeLabel call and this assertion fails.

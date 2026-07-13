# Implementation Plan: Cockpit watch — startup sweep for actionable states

**Feature**: `generacy cockpit watch` emits an NDJSON line per actionable-state issue/PR at first poll (marked `initial: true`), so a `queue → watch` restart is never silently blind to already-pending gates.
**Branch**: `839-found-during-cockpit-v1`
**Status**: Complete

## Summary

`packages/generacy/src/cli/commands/cockpit/watch/diff.ts::computeTransitions` currently short-circuits on `prev.size === 0 → return []`. That silent baseline is exactly the bug: the documented `queue → watch` flow leaves the developer with a watcher that never mentions the gates `queue` just moved into place. Fix: replace the blanket short-circuit with a *first-poll sweep* that emits one line per issue/PR whose `Snapshot` is currently actionable. Actionability = any label in `{waiting-for:*, completed:validate, failed:*, needs:intervention, agent:error}` OR (for PRs only) `checksRollup === 'failure'`. Every non-actionable state stays silent at baseline. Polls 2..N are byte-identical to today.

Rev-3 semantics (not rev 2): the sensor emits only the actionable subset at first poll, and the plugin (`/cockpit:watch`) remains stateless per line. Re-emitting the same still-pending line on watcher restart is the desired behavior, not noise.

The wire contract for the new marker is deliberately narrow: `initial: z.literal(true).optional()`. First-poll lines carry `initial: true`; polls 2..N omit the field entirely. Consumers key on truthiness (`if (event.initial)`), never on `=== false`.

## Technical Context

- **Language / Runtime**: TypeScript, Node.js >=22, ESM
- **Package**: `@generacy-ai/generacy` (`packages/generacy/`)
- **Sensor layer touched**: `packages/generacy/src/cli/commands/cockpit/watch/` (diff.ts, emit.ts) + one new file for the actionable-label predicate
- **Consumers untouched**: `/cockpit:watch` plugin markdown, cloud/UI (no downstream consumer today)
- **Test framework**: vitest
- **Dependencies changed**: none
- **Public API changed**: additive only — `CockpitEvent` gains `initial?: true`; `CockpitEventSchema` gains `initial: z.literal(true).optional()`

## Files Touched

| File | Change |
|------|--------|
| `packages/generacy/src/cli/commands/cockpit/watch/actionable.ts` (new) | Exports `ACTIONABLE_LABELS` constant set + `isActionableLabel(label)` predicate + `isActionableSnapshot(snap)` (labels-first + PR-rollup extension per FR-002/Q5). Single source of truth for actionable classification (SC-006). |
| `packages/generacy/src/cli/commands/cockpit/watch/diff.ts` | Replace `if (prev.size === 0) return [];` with `if (prev.size === 0) return computeInitialSweep(curr, ts);`. New `computeInitialSweep()` iterates `curr` (sorted by `(repo, kind, number)`, matching `snapshotKey` construction — Q4), filters via `isActionableSnapshot()`, emits one event per hit with `event: 'label-change'`, `from: null`, `to: classified.state`, `sourceLabel: classified.sourceLabel`, and `initial: true`. `CockpitEvent` interface gains `initial?: true`. `makeEvent()` gains optional `initial` param. |
| `packages/generacy/src/cli/commands/cockpit/watch/emit.ts` | `CockpitEventSchema` gains `initial: z.literal(true).optional()` (Q3 — strict typing, no `false` variant). |
| `packages/generacy/src/cli/commands/cockpit/__tests__/watch.diff.test.ts` | Existing `emits nothing on first poll (prev empty)` test amended: rename to `emits nothing on first poll when no snapshot is actionable` and switch the input to non-actionable labels. Add new tests: (1) actionable-label at first poll → 1 line with `initial: true`, `from: null`, correct `sourceLabel`; (2) mixed actionable + non-actionable at first poll → only actionable emitted; (3) issue carrying `completed:specify` + `waiting-for:clarification` → emits initial (SC-007 / Q2 regression); (4) PR with `checksRollup: 'failure'` and no `failed:*` label → emits initial (SC-009 / Q5 regression); (5) deterministic sort by `(repo, kind, number)` across mixed input (SC-008); (6) polls 2..N — `initial` field is ABSENT (not `false`) on returned events (SC-005). |
| `packages/generacy/src/cli/commands/cockpit/__tests__/watch.emit.test.ts` | Add tests: (1) `CockpitEventSchema.parse` accepts `initial: true`; (2) rejects `initial: false`; (3) accepts payload with `initial` absent (existing tests already cover this implicitly; make one explicit). |
| `packages/generacy/src/cli/commands/cockpit/__tests__/watch.actionable.test.ts` (new) | Unit tests for `isActionableLabel` and `isActionableSnapshot`: coverage of every FR-002 label pattern (`waiting-for:*`, `completed:validate`, `failed:*`, `needs:intervention`, `agent:error`), negative coverage (other `completed:*`, `phase:*`, `agent:in-progress`), and PR-rollup extension (`checksRollup: 'failure'` for PRs only; issues never rollup-actionable). |

Nothing else changes. `runOnePoll`, `snapshot.ts`, `poll-loop.ts`, `classify-issue.ts`, resolver, and label-map are untouched. The `/cockpit:watch` plugin markdown is not modified (FR-007 / SC-004).

## Design Detail

### Actionable classification lives in a new engine module

`packages/generacy/src/cli/commands/cockpit/watch/actionable.ts`:

```ts
import type { Snapshot } from './snapshot.js';

/** Labels that mark an issue/PR as needing developer attention right now. */
export const ACTIONABLE_EXACT_LABELS = new Set<string>([
  'completed:validate',
  'needs:intervention',
  'agent:error',
]);

const ACTIONABLE_PREFIXES = ['waiting-for:', 'failed:'] as const;

export function isActionableLabel(label: string): boolean {
  if (ACTIONABLE_EXACT_LABELS.has(label)) return true;
  return ACTIONABLE_PREFIXES.some((p) => label.startsWith(p));
}

/**
 * Actionable at first-poll baseline: (a) any label in the actionable set,
 * OR (b) for PRs, `checksRollup === 'failure'` (FR-002 / Q5).
 *
 * NOTE: Operates on raw `Snapshot.labels[]`, NOT `classified.state` — an issue
 * carrying both `completed:specify` and `waiting-for:clarification` is ranked
 * terminal by the classifier's tier precedence, and trusting `classified.state`
 * would silently skip the exact issues this feature exists to surface (FR-011 / Q2).
 */
export function isActionableSnapshot(snap: Snapshot): boolean {
  if (snap.labels.some(isActionableLabel)) return true;
  if (snap.kind === 'pr' && snap.checksRollup === 'failure') return true;
  return false;
}
```

Single source of truth — grepping `'completed:validate'` outside this file returns nothing new (SC-006).

### `computeTransitions` grows a first-poll branch

The current line 134 `if (prev.size === 0) return [];` becomes a delegation. `computeInitialSweep` sorts by `snapshotKey` (which is already lexicographically `(repo, kind, number)`) before filtering + emitting:

```ts
function computeInitialSweep(curr: SnapshotMap, ts: string): CockpitEvent[] {
  const out: CockpitEvent[] = [];
  const sortedKeys = [...curr.keys()].sort();  // snapshotKey = `${repo}#${kind}#${number}`
  for (const key of sortedKeys) {
    const snap = curr.get(key)!;
    if (!isActionableSnapshot(snap)) continue;
    out.push(makeEvent(
      snap,
      'label-change',
      null,                         // from: null (Q1 — renders as "(none) → <state>")
      snap.classified.state,        // to: classified state (FR-011 — the "wider net" decides emission, classifier decides `to`)
      snap.classified.sourceLabel,  // sourceLabel: classifier-derived, per FR-011
      ts,
      { initial: true },            // Q3 — marker present only on first-poll lines
    ));
  }
  return out;
}
```

`makeEvent` grows an optional 7th arg `{ initial?: true }`; if present-and-true, sets it on the returned event, otherwise omits the field entirely (never emits `initial: false`). Polls 2..N call sites do not pass the option, so their events remain byte-identical to today.

### Schema — strict `z.literal(true).optional()`

Per Q3, `initial` is either present-and-`true` or absent. `CockpitEventSchema.parse({ ...event, initial: false })` must throw. Test guards SC-005.

```ts
export const CockpitEventSchema = z.object({
  // ...existing fields...
  initial: z.literal(true).optional(),
});
```

### snapshotKey sort order = `(repo, kind, number)` — for free

`snapshotKey(repo, kind, number)` returns `` `${repo}#${kind}#${number}` `` (`snapshot.ts:34`). String-sorting those keys yields `(repo, kind, number)` ascending as long as `kind` is one of `'issue' | 'pr'` (both lowercase, deterministic). Numbers within the same repo/kind are sub-lexicographic (e.g., `#2` before `#10`) — technically not strict integer order. Two options in `computeInitialSweep`:

- **A (default in plan)**: sort keys lexicographically; document the sub-lexicographic-number quirk. Byte-stable for any fixed input (SC-008 satisfied — the metric is stability, not strict integer order).
- **B (fallback if the number-order quirk is observable in a test fixture)**: parse `(repo, kind, number)` back out of each key and sort by tuple. One extra parse per entry; still O(N log N).

Plan settles on A for minimal diff. If a test fixture surfaces the quirk in a load-bearing assertion (e.g., a fixture with `#2` and `#10` for the same repo/kind), swap to B. Nothing else changes.

## Constitution Check

No `.specify/memory/constitution.md` exists — general project conventions honored:

- **Small, surgical diff** (CLAUDE.md YAGNI): one new file (actionable predicate), three edits (diff.ts, emit.ts, one test file), two new test files. No refactor of `classify` or `label-map`.
- **Fix the root cause, don't paper over** (CLAUDE.md): Q2's counterexample — classifier tier precedence outranking waiting-for — is filed separately, NOT patched here. This sweep's label-scan avoids that trap independently.
- **No comments on obvious code, only WHY** (CLAUDE.md): the `isActionableSnapshot` doc comment explains WHY it scans raw labels (FR-011 rationale), not what it does.
- **No backwards-compat shims** (CLAUDE.md): `initial: z.literal(true).optional()` — the only wire-shape change — is additive; no downstream consumer today. Cloud/UI parity is not a concern (Assumptions §3).
- **Don't add error handling for scenarios that can't happen** (CLAUDE.md): the sweep is a pure function over `curr: SnapshotMap`; no I/O added.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Test-mirrors-code failure pattern (per #836's rationale — tests that inject the escape hatch cannot catch the bug the escape hatch bypasses). | The regression tests hit `computeTransitions` directly with fixtures where `prev.size === 0` and `curr` contains one snapshot with a `waiting-for:*` label — that's the exact production path. No `onTick` or `abortSignal` involvement; the property being tested (emission at first poll) is directly observable. Additionally, one integration test through `runOnePoll` with a stub `gh` asserting the emitted line has `initial: true`. |
| Classifier's tier precedence changes upstream and starts ranking `waiting-for:*` above `completed:specify` (Q2's related bug gets fixed separately). | The sweep continues to work — it still scans raw labels. The `sourceLabel` field on emitted lines just becomes the more accurate one. No test changes required. |
| A future actionable label (e.g., a new `waiting-for:*` subkey) is added to WORKFLOW_LABELS but not to `ACTIONABLE_EXACT_LABELS`. | `ACTIONABLE_PREFIXES` covers `waiting-for:*` and `failed:*` open-endedly. Only new exact labels (`completed:*`, `needs:*`, `agent:*` variants) require an update. A follow-up guard test could enumerate WORKFLOW_LABELS and assert the predicate stays coherent, but that is out of scope (Assumptions §4). |
| Downstream consumer relies on `initial === false` on transition lines. | No such consumer exists (Assumptions §3). If one appears, `z.literal(true).optional()` is a compile-time break at that consumer, which is the correct signal. |
| Sub-lexicographic number ordering (`#10` before `#2`) surprises an operator. | SC-008 measures byte-stability, not strict integer order. If a fixture's assertion depends on integer order, switch to sort variant B (parse-tuple) — noted in Design Detail. |

## Suggested Next Step

`/speckit:tasks` to generate the ordered task list.

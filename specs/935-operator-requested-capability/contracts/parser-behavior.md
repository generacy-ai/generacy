# Contract: `parseEpicBody` — extended for adhoc refs

**Module**: `packages/cockpit/src/resolver/parse-epic-body.ts`

## Signature (unchanged)

```typescript
export function parseEpicBody(body: string): ParsedEpicBody;
```

## Return shape (modified)

```typescript
interface ParsedEpicBody {
  phases: ParsedPhase[];    // unchanged
  adhocRefs: IssueRef[];    // NEW — task-list refs collected outside any phase
  allRefs: IssueRef[];      // union of phase refs + adhoc refs
  warnings: string[];       // unchanged
}
```

## Grammar additions

Existing productions (unchanged):
- L3 heading `^### (.+)$` — opens a phase
- L4+ heading `^####+ ` — closes current phase
- L2 heading `^## ` — ignored (skip line)
- Task-list `^\s*- \[[ xX]\] (first-token)` — captures ref

New production:
- **Adhoc heading** `^## Ad-hoc\s*$` (case-insensitive) — closes current phase (like L4+)

New collection rule:
- Task-list line with `current == null` (i.e. before any phase, under `## Ad-hoc`, or after `####+`) → ref goes into `adhocRefs` AND `globalRefs`. Dedup keyed by `${repo}#${number}` — first occurrence wins.

## Regex

```typescript
const AD_HOC_HEADING_RE = /^##\s+ad-hoc\s*$/i;
```

Placed in the walk *before* `HEADING_L2_RE` so the specific case fires first.

## Semantics

| Body pattern | phases | adhocRefs | allRefs |
|--------------|--------|-----------|---------|
| Standard epic: `### Phase 1: …\n- [ ] a/b#1\n### Phase 2: …\n- [ ] a/b#2` | 2 | [] | [a/b#1, a/b#2] |
| Epic with adhoc: `### Phase 1: …\n- [ ] a/b#1\n## Ad-hoc\n- [ ] a/b#9` | 1 | [a/b#9] | [a/b#1, a/b#9] |
| Flat body: `- [ ] a/b#3\n- [ ] a/b#4` | 0 | [a/b#3, a/b#4] | [a/b#3, a/b#4] |
| Empty body: `` | 0 | [] | [] |
| Epic + preamble refs: `Some prose.\n- [ ] a/b#1\n\n### Phase 1: …\n- [ ] a/b#2` | 1 | [a/b#1] | [a/b#1, a/b#2] |
| Adhoc without adhoc heading (preamble): `- [ ] a/b#5\n### Phase 1: …` | 1 | [a/b#5] | [a/b#5] |

## Warnings

Warning taxonomy (from #826) unchanged. `warnings[]` still records `bare '#N'` / `titled but not ref-shaped` / `URL path not /(issues|pull)/N` rejections regardless of phase / adhoc context.

## Invariants

- **I-1** — `allRefs.length === new Set(allRefs.map(dedupKey)).size` (deduped)
- **I-2** — `adhocRefs` ⊆ `allRefs` and `⋃ phase.refs` ⊆ `allRefs`, and their union with dedup = `allRefs`
- **I-3** — Pure function; no I/O; no throws for well-formed strings
- **I-4** — Adhoc and phase refs are dedup-collision-safe: a ref appearing both in a phase and under `## Ad-hoc` counts once, attributed to whichever appeared first in body order — subsequent occurrences don't emit warnings (they're silent dedup drops per existing `currentSeen` guard)

# Contract: `resolveEpic` — fail-loud relaxation

**Module**: `packages/cockpit/src/resolver/resolve.ts`

## Signature (unchanged)

```typescript
export async function resolveEpic(options: ResolveEpicOptions): Promise<ResolvedEpic>;
```

## Changes

- Removes the `NO_PHASE_HEADINGS` throw at line 57-59.
- Retains `NO_REFS` throw when `parsed.allRefs.length === 0`.

## Error codes

- `INVALID_EPIC_REF` — malformed ref string (unchanged)
- `GH_FETCH_FAILED` — `gh` API error (unchanged)
- `NO_REFS` — body has neither phase nor adhoc refs (unchanged)
- `NO_PHASE_HEADINGS` — **REMOVED** as a runtime throw. Retained in the `LoudResolverErrorCode` union for one release cycle to avoid breaking pattern-matching consumers. Grep-verified callers: none dispatch on this code today.

## Downstream contract

- `resolvedEpic.parsed.phases.length === 0` is now a valid successful return, indicating flat-list mode.
- `resolvedEpic.parsed.adhocRefs.length > 0` may coexist with `phases.length > 0` — an epic with an `## Ad-hoc` section.
- Callers must not assume `phases.length > 0`. Verified caller updates in this plan:
  - `status.ts` — routes to flat renderer
  - `queue.ts` (phase form) — throws user-facing error if `phases.length === 0` and `--phase` was passed
  - `queue.ts` (issue form) — bypasses `resolveEpic` entirely (single-ref)
  - `event-bus-registry.ts` — transits `allRefs`, unaffected

# Contract: `computeTransitions` — mid-stream first-sight

**Module**: `packages/generacy/src/cli/commands/cockpit/watch/diff.ts`

## Signature (unchanged)

```typescript
export function computeTransitions(
  prev: SnapshotMap,
  curr: SnapshotMap,
  now?: () => string,
): CockpitEvent[];
```

## Changes

Replace the silent-baseline branch:

```typescript
// BEFORE:
for (const [key, currSnap] of curr) {
  const prevSnap = prev.get(key);
  if (prevSnap == null) continue;   // ← silent
  // …
}

// AFTER:
for (const [key, currSnap] of curr) {
  const prevSnap = prev.get(key);
  if (prevSnap == null) {
    // Mid-stream first-sight — emit initial:true if actionable.
    if (isActionableSnapshot(currSnap)) {
      out.push(
        makeEvent(
          currSnap,
          'label-change',
          null,
          currSnap.classified.state,
          currSnap.classified.sourceLabel,
          ts,
          { initial: true },
        ),
      );
    }
    continue;
  }
  // …existing per-key diff…
}
```

## Semantics

- Cycle 1 (prev.size === 0): unchanged — `computeInitialSweep` emits `initial:true` for every actionable ref.
- Cycle N > 1, key present in both: unchanged — normal diff.
- Cycle N > 1, key in curr but not prev: **NEW** — emit one `initial: true` label-change event if actionable; skip if not actionable.
- Cycle N > 1, key in prev but not curr: unchanged — no event (removals stay silent, matching FR-002 "removal emits nothing retroactive").

## Invariants

- **I-1** — Any ref appended to a live scope body via `scope add` triggers one and only one `initial: true` event on the next poll cycle.
- **I-2** — The event carries the ref's *first-observed* state, not `null → null`; `from: null` and `to: <state>`, matching sweep semantics.
- **I-3** — Removals are silent (unchanged behaviour). `scope remove` produces no event on the removed ref; subsequent polls simply drop it from `curr`.

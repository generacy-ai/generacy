# Phase 1 Data Model — #873

Additive changes only. No renames, no removals, no `CockpitState` enum edits.

## Extended: `Issue` (in `@generacy-ai/cockpit`)

**File**: `packages/cockpit/src/gh/wrapper.ts:7-16`

```ts
export interface Issue {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED';
  stateReason: 'COMPLETED' | 'NOT_PLANNED' | null;   // NEW — required field, `null` when open or unknown reason
  labels: string[];
  url: string;
  body: string;
  author?: { login: string };
  createdAt: string;
}
```

**Validation** (`IssueRawSchema` at `wrapper.ts:260`): accept `stateReason: z.string().nullable().optional()`. Mapper normalizes:

- `'COMPLETED'` → `'COMPLETED'`
- `'NOT_PLANNED'` → `'NOT_PLANNED'`
- `null` / `undefined` / any other string → `null`

**Rationale**: closed-state distinction (Q4-B) needs `NOT_PLANNED` propagated. Field is `null` for open issues by convention (GitHub returns null for open). Unknown future strings coerce to `null` to keep the type surface finite.

**Callers to touch**:
- `listIssues()` — extend `--json` list at `wrapper.ts:525` from `number,title,state,labels,url,body,author,createdAt` → `number,title,state,stateReason,labels,url,body,author,createdAt`.
- `getIssue()` — extend `--json` list at `wrapper.ts:545` identically.
- Both mappers (`parseIssues` shape + `getIssue` return object at `wrapper.ts:562-571`) populate the field via the normalizer.

## Extended: `IssueSnapshot`, `PrSnapshot`

**File**: `packages/generacy/src/cli/commands/cockpit/watch/snapshot.ts:9-29`

```ts
export interface IssueSnapshot {
  kind: 'issue';
  repo: string;
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED';                          // UNCHANGED
  stateReason: 'COMPLETED' | 'NOT_PLANNED' | null;   // NEW
  labels: string[];
  classified: ClassifiedIssue;
}

export interface PrSnapshot {
  kind: 'pr';
  repo: string;
  number: number;
  url: string;
  lifecycle: PrLifecycle;
  state: 'OPEN' | 'CLOSED';                          // UNCHANGED
  stateReason: 'COMPLETED' | 'NOT_PLANNED' | null;   // NEW
  labels: string[];
  classified: ClassifiedIssue;
  checksRollup: ChecksRollup;
}
```

**Builder signatures**: `buildIssueSnapshot()` and `buildPrSnapshot()` accept the extended `Issue` shape and pass `issue.stateReason` through verbatim. No transformation at the snapshot layer.

**PR note**: PRs technically don't carry `stateReason` on the underlying GitHub type (only issues do). GitHub's `gh search` mixes issues and PRs into a single result set; `stateReason` on a PR row is `null`. `PrSnapshot.stateReason` is included for shape symmetry (single predicate signature over `Snapshot` union) and always resolves `null` in practice.

## New: `isDoneSnapshot(snap: Snapshot): boolean`

**File**: `packages/generacy/src/cli/commands/cockpit/shared/is-done-snapshot.ts` (NEW)

```ts
import type { Snapshot } from '../watch/snapshot.js';

/**
 * Issue `state: closed` dominates any label-derived actionability tier.
 *
 * A closed issue carrying `completed:validate` (or any other actionable-label
 * residue) is done, not actionable. This helper is the single decision
 * surface: both `isActionableSnapshot` (watch) and the status renderer route
 * through it. If you need to expand actionability tiers, extend
 * `isActionableSnapshot` — do not add a second done-gate.
 *
 * The predicate reads raw `snap.state`, NOT `snap.classified.state`. The
 * classified `'terminal'` tier is exactly the label residue this fix stops
 * trusting; reading it would perpetuate the bug pattern (#873).
 */
export function isDoneSnapshot(snap: Snapshot): boolean {
  return snap.state === 'CLOSED';
}
```

**Consumers**:
- `packages/generacy/src/cli/commands/cockpit/watch/actionable.ts` — `isActionableSnapshot` short-circuits `false` when `isDoneSnapshot(snap)` is `true`.
- (Indirect) `packages/generacy/src/cli/commands/cockpit/watch/diff.ts::computeInitialSweep` — reaches `isDoneSnapshot` transitively via `isActionableSnapshot`.
- (Test-only) `packages/generacy/src/cli/commands/cockpit/status/**` — status renderer inspects `issueState` on `StatusRow` directly rather than calling the predicate (the render branch is on a raw field, not on `Snapshot`). A JSDoc `@see isDoneSnapshot` cross-reference on `fmtRow` keeps the invariant grep-linked.

## Extended: `StatusRow`

**File**: `packages/generacy/src/cli/commands/cockpit/status/row.ts:4-15`

```ts
export interface StatusRow {
  repo: string;
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  state: CockpitState;                                // UNCHANGED — label-derived
  sourceLabel: string;                                // UNCHANGED
  issueState: 'OPEN' | 'CLOSED';                      // NEW — Q2-A raw signal
  stateReason: 'COMPLETED' | 'NOT_PLANNED' | null;    // NEW — Q4-B render + JSON signal
  prNumber: number | null;
  checks: 'pending' | 'success' | 'failure' | 'none' | 'error';
  url: string;
  phase: string | null;
}
```

**Builder signature**: `buildStatusRow()` receives the extended `Issue` shape and populates `issueState = issue.state`, `stateReason = issue.stateReason`. All other fields unchanged.

**Envelope**: `renderJsonEnvelope()` at `packages/generacy/src/cli/commands/cockpit/status/render-table.ts:54-68` is a plain `JSON.stringify` over `StatusRow[]`. New fields flow through automatically.

## Rendering rules (render-table.ts)

**File**: `packages/generacy/src/cli/commands/cockpit/status/render-table.ts::fmtRow`

Pseudo-branch (post-change):

```ts
function fmtRow(row: StatusRow, colorizer: Colorizer): string {
  // ... existing repoCol / numCol / prCol / checksCol / titleCol computation ...

  let stateCol: string;
  let sourceCol: string;
  if (row.issueState === 'CLOSED') {
    if (row.stateReason === 'NOT_PLANNED') {
      stateCol = colorizer.doneNotPlanned('✗ closed  '.padEnd(COL_STATE));
      sourceCol = colorizer.doneNotPlanned('(not planned)'.padEnd(COL_SOURCE_LABEL));
    } else {
      // COMPLETED or defensive null on a closed row
      stateCol = colorizer.doneMerged('✓ merged   '.padEnd(COL_STATE));
      sourceCol = colorizer.doneMerged('merged/closed'.padEnd(COL_SOURCE_LABEL));
    }
  } else {
    const stateRaw = row.state.padEnd(COL_STATE);
    stateCol = colorizer.state(stateRaw, row.state);
    sourceCol = row.sourceLabel.padEnd(COL_SOURCE_LABEL);
  }

  return `${repoCol}   ${numCol}   ${stateCol}   ${sourceCol}   ${prCol}   ${checksCol}   ${titleCol}`;
}
```

Exact column-width tuning of `✓ merged   ` / `✗ closed  ` (spaces vs. glyph width) is a rendering-detail task, not a design decision.

## Colorizer extension

**File**: `packages/generacy/src/cli/commands/cockpit/status/color.ts`

Add two members to the `Colorizer` interface (identity + chalk implementations):

```ts
export interface Colorizer {
  state(text: string, state: CockpitState): string;   // UNCHANGED
  doneMerged(text: string): string;                    // NEW — green
  doneNotPlanned(text: string): string;                // NEW — dim/grey
}
```

- `identityColorizer` returns text unchanged for both.
- `chalkColorizer` uses `chalk.green` and `chalk.gray` respectively (dim over red per research decision 4).

## Relationships / data flow

```
gh (GitHub API)
  └─ stateReason ────────────────┐
                                 ▼
Issue (extended)
  └─┬─ buildIssueSnapshot ──▶ IssueSnapshot (extended)
    │                          └─ isActionableSnapshot ──▶ isDoneSnapshot
    │                                                       (single invariant surface)
    └─ buildStatusRow ─────▶ StatusRow (extended)
                              └─ fmtRow (render-table)  ──▶ ✓/✗ text + colour
                              └─ renderJsonEnvelope ────▶ JSON with issueState + stateReason
```

## Validation rules

- `stateReason` string must be one of `'COMPLETED' | 'NOT_PLANNED' | null` after the mapper. Any other string in raw JSON coerces to `null` (silent — GitHub may add new reasons; we degrade gracefully to the "merged/closed" render).
- `issueState === 'CLOSED'` MUST short-circuit `isActionableSnapshot` regardless of labels present. Regression test at `watch.actionable.test.ts`: `{ state: 'CLOSED', labels: ['completed:validate'] }` → `false`.
- `issueState === 'OPEN'` MUST leave `isActionableSnapshot` behaviour unchanged. Regression test: `{ state: 'OPEN', labels: ['completed:validate'] }` → `true` (baseline preserved).
- Live open→closed observed on poll N vs. N-1: `diffIssue` emits exactly one `issue-closed` event with `to: 'terminal'`, no additional label-change event derived from the same tick. (Existing behaviour, not modified — assertion is a regression test only.)

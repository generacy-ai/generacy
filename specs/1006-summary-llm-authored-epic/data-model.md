# Data Model: LLM-authored H4 phase-header epic detection

**Feature**: `1006-summary-llm-authored-epic` | **Date**: 2026-07-19

This feature adds one new warning family to the parser's `warnings: string[]` output and one additive field to the CLI status envelope + MCP tool return. No wire-schema changes, no persisted types, no throws.

## Types touched

### `ParsedEpicBody` (`packages/cockpit/src/resolver/types.ts`) — UNTOUCHED

**Shape preserved.**

```ts
export interface ParsedEpicBody {
  phases: ParsedPhase[];
  adhocRefs: IssueRef[];
  allRefs: IssueRef[];
  warnings: string[]; // ← the new warning is one more entry in the existing array
}
```

The new warning is a `string` pushed to `warnings[]`. No structural change; existing consumers work.

### `StatusEnvelope` (`packages/generacy/src/cli/commands/cockpit/status/render-table.ts`) — MODIFIED (additive)

**Before**:
```ts
export interface StatusEnvelope {
  scope: { kind: 'epic'; owner: string; repo: string; issue: number };
  rows: StatusRow[];
}
```

**After**:
```ts
export interface StatusEnvelope {
  scope: { kind: 'epic'; owner: string; repo: string; issue: number };
  rows: StatusRow[];
  /**
   * Parser warnings surfaced to machine-readable consumers (auto-skill sweep,
   * `--json` piped through `jq`, MCP `cockpit_status` tool return). Sourced
   * directly from `parseEpicBody(body).warnings`. Empty array when clean.
   * Additive / non-breaking (#1006 FR-012).
   */
  warnings: string[];
}
```

### `renderJsonEnvelope` signature — MODIFIED (additive)

**Before**:
```ts
export function renderJsonEnvelope(
  epic: { owner: string; repo: string; issue: number },
  rows: StatusRow[],
): string;
```

**After**:
```ts
export function renderJsonEnvelope(
  epic: { owner: string; repo: string; issue: number },
  rows: StatusRow[],
  warnings: string[],
): string;
```

The third arg is `[]` on clean bodies; sourced from `resolved.parsed.warnings` at the CLI callsite.

### `cockpit_status` MCP tool `data` — MODIFIED transitively (no handler code change)

`packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_status.ts:86` currently returns `{ status: 'ok', data: parsedJson }`, where `parsedJson` is the CLI envelope parsed verbatim. Because the CLI envelope now includes `warnings`, the MCP tool return `data` also includes it — automatic parity, no handler edit required. The test in `mcp/__tests__/cockpit_status.test.ts` MUST assert this parity explicitly.

## Warning-family taxonomy — extension

The existing rejection-family taxonomy from #826 is unchanged. This feature adds one **structural** warning family that fires at end-of-parse rather than mid-line:

| Family                                              | Marker substring                     | Fires when                                                                                                                                                                                                                    |
|-----------------------------------------------------|--------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Bare `#N` shorthand (#826)                          | `bare '#N'`                          | Per-line during walk; first token matches `^#\d+$` and `parseRef` returns null.                                                                                                                                               |
| Titled but not ref-shaped (#826)                    | `titled but not ref-shaped`          | Per-line during walk; first token is ref-shaped but no `^…$`-anchored `ref-shapes.ts` shape matches.                                                                                                                          |
| URL path not /(issues\|pull)/N (#826)               | `URL path not /(issues\|pull)/N`     | Per-line during walk; first token matches `^https?://` and `parseRef` returns null.                                                                                                                                           |
| **H4 phase headers (#1006, NEW)**                   | **`phase headers must be '###'`**    | **End-of-body; `phases.length > 0` AND `phases.every(refs.length === 0)` AND `adhocRefs.length > 0` AND at least one `####+` heading whose trimmed text matches `/^\s*P\d+\b/i` OR `/\bphase\b/i` was seen.**                  |

**Grep audit (SC-006)**: `rg "phase headers must be '###'" packages/cockpit/src/` returns exactly one match — the emission site inside `parseEpicBody`. The marker substring must not appear in any other resolver rejection marker.

## Loud-signal gating rule (FR-009 part b)

Emit the H4-phase-header warning iff **all four** conditions hold:

```
phases.length > 0                            // (a) — there are phases; not flat-list mode
&& phases.every(p => p.refs.length === 0)    // (b) — all phases are empty
&& adhocRefs.length > 0                      // (c) — refs did fall through to ad-hoc
&& sawPhaseShapedH4                          // (d) — at least one #### heading looks like a phase header
```

**Why (a) is load-bearing**: `[].every(...)` is vacuously `true`. Without (a), the predicate fires on legitimate flat-list bodies (`phases.length === 0`, `adhocRefs.length > 0`), which `resolve.ts:57-63` documents as a valid, supported mode. SC-002 fails without this guard.

**Why (d) is load-bearing**: many epics have `####` sub-headers unrelated to phase structure — e.g. `#### Notes` or `#### Follow-ups` under an otherwise-populated phase. Without (d), any epic that happens to hit (b) + (c) for unrelated reasons would fire the warning. SC-002 also fails without this guard.

**Test coverage**:
- (a) flip: flat-list body with `phases.length === 0` and non-empty `adhocRefs` → NO warning.
- (b) flip: any phase has refs → NO warning.
- (c) flip: all phases empty AND `adhocRefs.length === 0` → NO warning (nothing fell through).
- (d) flip: `#### Notes` / `#### Follow-ups` / `#### Rephrase X` present, no phase-shaped `####` → NO warning.
- All-four-true (the snappoll#1 fixture) → warning fires with the FR-003 marker.

## Detector regex — `PHASE_SHAPED_H4_RE`

```ts
const PHASE_SHAPED_H4_RE = /^\s*(?:P\d+\b|.*\bphase\b)/i;
```

Applied to the `####+` heading's trimmed text (after stripping the `####+\s+` prefix). Two arms, case-insensitive:

- `^\s*P\d+\b` — matches `P1`, `P2 — Foundation`, `p1`. `\b` after `\d+` ensures `Ph1se` does not match.
- `.*\bphase\b` — matches `Phase 1`, `Delivery phase`, `phase 3 — polish`. `\b` before and after `phase` ensures `Rephrase`, `phaseless`, `paraphrased` do not match.

**Excluded by construction**: `Notes`, `Follow-ups`, `Rephrase X`, `Paraphrase Y`.

## Warning message shape

Illustrative — exact wording is free to evolve. Marker substring `phase headers must be '###'` is the stable contract:

```
cockpit: 12 task refs fell to ad-hoc; phase headers must be '###', found '####'
```

The count (`12 task refs`) and the trailing `found '####'` are informative, not asserted by tests. Consumers key on the marker substring only.

## Fixture layout

```
packages/cockpit/src/resolver/__tests__/fixtures/
├── epic-826-sniplink.md            (existing; unchanged)
├── epic-826-tetrad-88.md           (existing; unchanged)
└── epic-1006-snappoll.md           (NEW — verbatim body of christrudelpw/snappoll#1)
```

`epic-1006-snappoll.md` is frozen at PR time. It is historical evidence, not a live mirror — the source issue may be edited or closed post-merge. The fixture ensures the regression cannot silently re-emerge.

Fixture content is the exact body of `christrudelpw/snappoll#1` at time of authoring (per `spec.md § Live evidence`), including:
- `### Delivery phases` (H3)
- `#### P1 — Scaffold` (H4)
- `- [ ] christrudelpw/snappoll#2 — Scaffold Next.js + Tailwind app`
- `#### P2 — Foundation` (H4) with two refs
- `#### P3 — Core functionality` (H4) with four refs (#5–#8)
- `#### P4 — Polish & delivery` (H4) with five refs (#9–#13)

Expected parse result:
- `phases.length === 1` (only `### Delivery phases` — but see note below)
- `phases[0].refs.length === 0` (H4 headers close the phase before any refs)
- `adhocRefs.length === 12` (all 12 children fell through)
- `warnings` contains one entry matching `toContain("phase headers must be '###'")`.

Note: the fixture may contain additional `### <section>` headings before `### Delivery phases` (e.g. `### Scope`, `### Tech stack`) that produce more empty phases in `phases[]`. The assertion `phases.every(p => p.refs.length === 0)` holds regardless — those pre-existing phases are also empty per the bug shape.

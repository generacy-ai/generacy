# Implementation Plan: Two remaining grammar-brittleness issues in the epic body resolver

**Feature**: Promote phase-shaped `####` headings to open phases, and accept bare `#N` refs in checkbox task-list items when a `defaultRepo` is available.
**Branch**: `1014-summary-two-remaining-grammar`
**Status**: Complete

## Summary

Fix two independent grammar-brittleness issues in `packages/cockpit/src/resolver/` that cause silently-degraded scope resolution.

1. **H4 promotion**: `parse-epic-body.ts` currently closes the current phase on *every* `####+` heading and only sets a warning flag when the heading is "phase-shaped" (`#### P2`, `#### Phase 2`). After this change, a phase-shaped `####` heading (matching the existing `PHASE_SHAPED_H4_RE` from #1006) opens a phase exactly as `###` does. Non-phase-shaped `####+` headings become *transparent* — they no longer close the current phase. When both `###` and phase-shaped `####` appear in the same body, they are flat siblings and the parser emits a warning about the mixed style.
2. **Bare `#N` in checkboxes**: `parseEpicBody` gains an optional `defaultRepo: string` (canonical `"owner/repo"`, validated on entry). When set, a bare `#N` token inside a `TASK_LIST_RE` checkbox item resolves to `<defaultRepo>#N`. `resolveEpic` passes the scope issue's own `owner/repo` at its single call site. Direct library callers who don't pass `defaultRepo` see identical behavior to today (bare `#N` still warns per #826).

Companion writer change: `detectShape` in `packages/generacy/src/cli/commands/cockpit/scope/writer.ts` mirrors the parser — a body with *any* phase-shaped heading (H3 or phase-shaped H4) classifies as `phased`. No auto-normalization of `####` → `###` on write.

Follow-up to #1006 (which shipped H4 *detection* only). No public-facing API shape changes beyond the additive options bag; no changes to downstream consumers (`matchPhaseHeading`, `cockpit_status`, phase-complete detection, scope writer round-trip).

## Technical Context

- **Language**: TypeScript (ES2022 / ESM, Node >=22)
- **Package**: `@generacy-ai/cockpit` (`packages/cockpit/`) — pure-function resolver, zero runtime deps beyond `@generacy-ai/config`, `@generacy-ai/workflow-engine`, `yaml`, `zod`
- **Companion package**: `@generacy-ai/generacy` (`packages/generacy/src/cli/commands/cockpit/scope/writer.ts`)
- **Test framework**: `vitest` (see `packages/cockpit/vitest.config.ts`)
- **Existing regexes reused (no widening)**:
  - `PHASE_SHAPED_H4_RE` = `/^\s*(?:P\d+\b|.*\bphase\b)/i` (`parse-epic-body.ts:12`, published contract from #1006)
  - `TASK_LIST_RE` = `/^\s*-\s*\[[ xX]\]\s+(.+?)\s*$/` (`parse-epic-body.ts:16`)
  - `HEADING_L4_PLUS_RE`, `HEADING_L3_RE`, `HEADING_L2_RE`, `AD_HOC_HEADING_RE` — unchanged.
- **New primitives**:
  - `BARE_HASH_N_RE` (already exists at `parse-epic-body.ts:28` for classifier) — reused as acceptance shape for the checkbox-only path.
  - `DEFAULT_REPO_RE` = `/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/` — validates `defaultRepo` (mirrors the `OWNER_REPO` character class in `ref-shapes.ts:3`).
- **Options-bag pattern**: additive overload — `parseEpicBody(body)` and `parseEpicBody(body, options)` both compile against existing callers.

## Project Structure

```
packages/cockpit/src/resolver/
├── parse-epic-body.ts         # MODIFIED — H4 promotion, defaultRepo, mixed-heading warning
├── ref-shapes.ts              # MODIFIED — export BARE_HASH_N_RE or a `parseBareRef` (impl choice, see research.md)
├── resolve.ts                 # MODIFIED — pass scope issue's `owner/repo` as defaultRepo to parseEpicBody
├── types.ts                   # MODIFIED — export ParseEpicBodyOptions interface
├── heading-match.ts           # UNCHANGED
├── errors.ts                  # UNCHANGED
└── __tests__/
    ├── parse-epic-body.test.ts    # MODIFIED — new cases for FR-001, FR-002, FR-004, FR-005, FR-012, FR-013
    ├── resolve.test.ts            # MODIFIED — assert defaultRepo pass-through in resolveEpic
    ├── ref-shapes.test.ts         # MODIFIED IF new export is a function (parseBareRef path)
    └── fixtures/
        ├── epic-1006-snappoll.md              # MODIFIED — snapshot re-pinned (H4 phases now populated)
        └── epic-1014-bare-refs.md             # NEW — bare `#N` under scope-repo defaultRepo

packages/cockpit/src/index.ts   # MODIFIED — export ParseEpicBodyOptions type

packages/generacy/src/cli/commands/cockpit/scope/
├── writer.ts                  # MODIFIED — detectShape mirrors parser (H3 OR phase-shaped H4)
└── __tests__/
    └── writer.test.ts         # MODIFIED — detectShape cases for H4-phased bodies

.changeset/
└── 1014-h4-phase-and-bare-refs.md   # NEW — minor for @generacy-ai/cockpit, patch for @generacy-ai/generacy
```

No new files in `contracts/` beyond the four documents this plan generates. No new orchestrator/relay/control-plane wiring. No new dependencies.

## Constitution Check

`.specify/memory/constitution.md` does not exist. Falling back to project-wide invariants from `CLAUDE.md`:

- **Changeset gate** — `.changeset/1014-h4-phase-and-bare-refs.md` (FR-010, SC-006). `parseEpicBody`'s new `options` argument is *additive* + *backwards-compatible* → `minor` for `@generacy-ai/cockpit`. `detectShape` change is internal-surface (not exported from `@generacy-ai/generacy`'s package entry) → `patch` for `@generacy-ai/generacy` (still required because `packages/generacy/src/` changes trigger the gate).
- **Pure functions preserved** — `parseEpicBody`, `parseRef`, `detectShape` remain no-throw / no-I/O.
- **No widening of ref-scanning grammar** — bare `#N` acceptance is gated behind (a) `defaultRepo` supplied AND (b) inside a `TASK_LIST_RE` checkbox line (FR-013). Plain bullets, ordered items, prose remain unchanged.
- **Fixture-pinned regression net** — snapshot suite is the primary safety guarantee (SC-004: zero diffs for non-re-pinned fixtures).
- **Fail-safe defaults** — malformed `defaultRepo` is rejected/warned per FR-003 (validation, not silent bogus refs).
- **No auto-normalization of author formatting** — `scope/writer.ts` preserves `####` phase headings on write (per clarifications Q2=A rejection of option C).

## Downstream impact (per Compatibility notes in spec)

| Consumer | Change | Rationale |
|----------|--------|-----------|
| `matchPhaseHeading` | none | operates on `phases[]` structure |
| `cockpit_status` grouping | none | operates on `phases[]` structure |
| `phase-complete` detection | none | operates on `phases[]` structure |
| `scope/writer.ts` writer | `detectShape` extended | mirrors parser (FR-011) |
| `scope/writer.ts` round-trip | none | writer emits qualified refs already |
| Direct `parseEpicBody(body)` callers | none | additive overload; default behavior unchanged (FR-005) |
| `epic-1006-snappoll.md` fixture | re-pinned | H4 phases now populated (SC-001) |
| Other fixtures (`epic-826-*`) | none | H3-authored, no bare refs |

## Related work

- **#1006** (predecessor): shipped `PHASE_SHAPED_H4_RE` detector + warning path. This PR fixes the *behavior*, not just the detection.
- **#826** (predecessor): established the "reject bare `#N` with a warning" contract that `defaultRepo` selectively bypasses.
- **#935** / `scope/writer.ts`: the writer that must stay in sync with parser classification.

## Next step

Run `/speckit:tasks` to generate the task list.

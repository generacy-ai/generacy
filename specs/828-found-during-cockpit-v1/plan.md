# Implementation Plan: cockpit status renders phase grouping for epic children

**Feature**: `generacy cockpit status <epic-ref>` groups children by epic phase in both the table and `--json` output.
**Branch**: `828-found-during-cockpit-v1`
**Status**: Complete
**Issue**: [#828](https://github.com/generacy-ai/generacy/issues/828)

## Summary

`packages/generacy/src/cli/commands/cockpit/status.ts` calls `resolveEpic()`, which returns `parsed.phases` (`ParsedPhase[]`) *and* `parsed.allRefs` (deduped flat set). Today the command reads only `allRefs` and passes the resulting flat `StatusRow[]` to `groupRows`, which emits a single `epic <owner/repo>#N` header. This plan wires `parsed.phases` through the pipeline so:

- The rendered table shows one group per `ParsedPhase`, using `ParsedPhase.heading` as the header (falling back to `ParsedPhase.token` uppercased when `heading` equals `token`).
- The `--json` envelope adds a `phase` field on every row (`ParsedPhase.token` or `null`).
- A ref appearing under multiple phase headings emits one table row per phase group AND one JSON row per (ref × phase) membership (mirrors `queue <phase>` semantics from #806 Q2).
- Refs in `allRefs` under no phase render under a single trailing `— (no phase) —` group; the same header is reused for phase-less epics (FR-004, FR-008).
- Row order within a phase group is `ParsedPhase.refs` body order — no `(repo, number)` sort (FR-009).

Fetching, PR resolution, and check rollup are untouched — the fix is scoped to grouping and JSON schema (FR-007).

## Technical Context

- **Language**: TypeScript, ESM.
- **Runtime**: Node >=22 (per `packages/generacy` bin gate).
- **Package**: `@generacy-ai/generacy` (`packages/generacy/`).
- **Data source**: `resolveEpic()` from `@generacy-ai/cockpit`. `ParsedEpicBody.phases: ParsedPhase[]` and `ParsedEpicBody.allRefs: IssueRef[]` are already returned; no cockpit package changes required.
- **Test runner**: Vitest. Existing coverage lives in `packages/generacy/src/cli/commands/cockpit/__tests__/status.render.test.ts` and `status.test.ts`.
- **Dependencies added**: none. All types (`ParsedPhase`, `IssueRef`) already re-exported from `@generacy-ai/cockpit`.

## Constitution Check

No `.specify/memory/constitution.md` in this repo (checked). Standard CLAUDE.md norms apply:

- Don't add error handling for scenarios that can't happen — trust `resolveEpic()`'s return shape; the resolver already guarantees `phases[]` and `allRefs[]`.
- No comments explaining WHAT the code does; only the WHY for the "no phase" trailing group and cross-phase duplication (both are non-obvious invariants).
- Delete legacy branches — the "sort by number" behavior in `groupRows` is removed, not preserved via a flag.
- Fix the root cause (`status.ts` ignores `parsed.phases`) rather than adding a workaround.

## Project Structure

Files changed (all under `packages/generacy/src/cli/commands/cockpit/`):

```
cockpit/
├── status.ts                        # Pass parsed.phases through; wire buildStatusRow + groupRows.
├── status/
│   ├── row.ts                       # StatusRow gains `phase: string | null`.
│   ├── group.ts                     # groupRows() rewritten: takes phases + rows, emits one RowGroup per phase.
│   ├── render-table.ts              # Header formatter uses phase heading; JSON envelope carries phase.
│   └── color.ts                     # unchanged
└── __tests__/
    ├── status.render.test.ts        # Updated fixtures + new grouping/JSON tests.
    └── status.test.ts               # Updated integration expectations for grouped output.
```

No new files. No package-boundary changes.

## Implementation Sequence

1. **`row.ts`**: Add optional `phase: string | null` on `StatusRow`. Extend `buildStatusRow` signature with a required `phase` argument (single string, `null` for none). Body-only change.

2. **`group.ts`**: Rewrite `groupRows`. New signature:
   ```
   groupRows(rows: StatusRow[], phases: ParsedPhase[], epicOwnerRepo: string): RowGroup[]
   ```
   Behavior:
   - Build a `Map<phaseToken, StatusRow[]>` seeded from `rows`; each row's `phase` field selects the bucket.
   - For each `ParsedPhase` in body order, emit a `RowGroup { header, rows }` where `rows` are the bucket's rows in `ParsedPhase.refs` body order (join by `${repo}#${number}` key).
   - Header format: if `heading === token` (label-less), emit `— <TOKEN-UPPER> —`; else `— <heading> —` (Q1 = B).
   - Emit a trailing `— (no phase) —` group when any rows have `phase == null` OR (FR-008) when `phases.length === 0` (single fallback group).
   - Remove today's `(a, b) => a.number - b.number` sort.

3. **`status.ts`**: Change the row-building loop to emit one `StatusRow` per (ref × phase) membership:
   - Build `membershipByKey: Map<string, string[]>` where key = `${repo}#${number}` and value = `phaseToken[]` (empty array for refs in `allRefs` but no phase → renders once with `phase: null`).
   - For each fetched issue, look up its memberships. If empty, emit one row with `phase: null`. Otherwise emit one row per phase token.
   - Call `groupRows(rows, resolved.parsed.phases, resolved.epic.repo)` (drop the flat sort).
   - Pass `phase` into `buildStatusRow`.

4. **`render-table.ts`**:
   - Table path: unchanged — iterates `RowGroup[]`, prints header + rows. Group headers are now phase headings; already handled by existing loop.
   - JSON envelope: `StatusEnvelope.rows: StatusRow[]` already flows through. Since `StatusRow.phase` is added at step 1, the JSON output is automatically extended. Confirm row order matches body order across phases, trailing `phase: null` last (FR-005 AC).

5. **Tests** (all in `packages/generacy/src/cli/commands/cockpit/__tests__/`):
   - `status.render.test.ts`:
     - Replace the "epic mode flattens rows under a single header sorted by number" case with "phase groups appear in body order, rows within each group in ParsedPhase.refs order".
     - Add: header text uses full `heading` when set; token-only uppercase when label-less.
     - Add: trailing `— (no phase) —` group appears when rows have `phase: null`.
     - Add: phase-less epic → single `— (no phase) —` group.
     - Add: cross-phase duplicate ref renders once per phase group in the table; JSON has one row per membership.
     - Add: JSON envelope `rows[].phase` field present on 100% of rows for a multi-phase fixture.
   - `status.test.ts`: Update the integration fixtures to include a mock `parsed.phases` and assert grouped stdout.

6. **Manual verification (SC-001, SC-002)**: Run against `christrudelpw/sniplink#1` per US3.

## Data Contracts

See `contracts/status-envelope.json` for the JSON envelope schema.

Key contract points:

- `phase` is a nullable string token (lowercased, matching `ParsedPhase.token`).
- Row identity is `(repo, number, phase)`. Under a phase-less epic, all rows have `phase: null` and the tuple degenerates to `(repo, number)`.
- Row order: outer key = phase body order; inner key = `ParsedPhase.refs` body order; `phase: null` group last.

## Assumptions Confirmed via Code Read

- `resolveEpic()` returns `ParsedEpicBody` with `phases` and `allRefs` populated (`packages/cockpit/src/resolver/types.ts:20-27`).
- `ParsedPhase.token` is lowercased (`packages/cockpit/src/resolver/parse-epic-body.ts:62`, `firstToken`) — safe to render uppercased in fallback headers without collision.
- `ParsedPhase.refs` is body-ordered and per-phase-deduped (`parse-epic-body.ts:85-89`).
- `allRefs` is `(repo, number)`-sorted, which is why FR-009 explicitly overrides today's sort — we now iterate `phases` for order, not `allRefs`.
- `queue.ts` already treats phase membership as per-heading (verified by looking for related sort/order logic — no shared helper to extract).

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Downstream JSON consumers rely on `rows.length === allRefs.length`. | Documented in FR-006 that row count MAY exceed `allRefs.length`. Only known consumer is the cockpit plugin, which renders stdout verbatim. |
| Cross-phase duplicate is real in `sniplink#1`. | Spec Q3 = A commits to per-membership rows; test covers this explicitly. |
| Phase-less epic regression. | FR-008 pinned; unit test asserts single `— (no phase) —` group and exit 0. |
| Existing test `status.render.test.ts:53-64` asserts number-sorted flat output. | This assertion is removed as part of step 5; the replacement covers the new invariant. |

## Out of Scope (deferred)

- Adding a PHASE column instead of grouping.
- Interactive/`watch` mode phase grouping (own issue).
- Sort flags (`--sort`).
- Changes to `resolveEpic`, `parseEpicBody`, `listAllIssues`, or `classifyIssue`.

## Next Step

Run `/speckit:tasks` to generate the task list from this plan.

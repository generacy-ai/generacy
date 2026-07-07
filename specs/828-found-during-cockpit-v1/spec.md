# Feature Specification: cockpit status renders phase grouping for epic children

**Branch**: `828-found-during-cockpit-v1` | **Date**: 2026-07-07 | **Status**: Draft | **Issue**: [#828](https://github.com/generacy-ai/generacy/issues/828)

## Summary

`generacy cockpit status <epic-ref>` currently renders every child of an epic as a flat table with repo/number/state/labels/PR/checks/title — but no phase information. The rev 3 catalog (`docs/epic-cockpit-plan.md` in tetrad-development, Command catalog) specifies status as:

> "One-shot table (or `--json`): every child, **phase**, state, PR + checks rollup."

Phase membership is the primary mental model when driving an epic (the playbook queues and merges phase-by-phase), and it's the one column that tells the developer "which queue round is this issue in / what should I queue next."

**Root cause**: `packages/generacy/src/cli/commands/cockpit/status.ts:74` iterates `resolved.parsed.allRefs` (the flat deduped set) and never consumes `resolved.parsed.phases`, which `resolveEpic` already returns in the same object. `groupRows` (in `status/group.ts:12`) then wraps every row under a single `epic <owner/repo>#<n>` header, ignoring phase structure entirely. The data is in hand, unrendered.

**Fix direction**: group rows under their phase headings — one `RowGroup` per `ParsedPhase`, echoing the epic body's `### <phase>` structure. Include phase membership in the `--json` envelope rows. A ref appearing in the flat set but under no phase renders in an implicit trailing group.

**Repro**: `christrudelpw/sniplink#1` (three `### P1/P2/P3` phases, 12 children) → `generacy cockpit status 1` shows 13 flat rows, zero phase indication.

## User Stories

### US1: Developer drives an epic phase-by-phase

**As a** developer driving an epic across several repos,
**I want** `generacy cockpit status <epic-ref>` to show me which children belong to which phase,
**So that** I can see at a glance which "queue round" each issue is in and decide what to queue or merge next without cross-referencing the epic body.

**Acceptance Criteria**:
- [ ] Running `generacy cockpit status <epic-ref>` on an epic with `### P1`, `### P2`, `### P3` phases renders one visually distinct group per phase, in body order.
- [ ] Each group's header renders the full parsed phase heading (e.g. `— P1 — Foundation —`), falling back to the token alone (e.g. `— P1 —`) when the epic body has no label after the token.
- [ ] Row order within a group matches the child order defined in the epic body — `ParsedPhase.refs` as parsed, no re-sorting.
- [ ] Rows for refs that appear in `allRefs` but under no phase render in a single trailing implicit group with header `— (no phase) —`.

### US2: Automation consumer reads phase membership from JSON

**As an** automation consumer (script, dashboard, or a downstream `cockpit` subcommand),
**I want** `generacy cockpit status --json <epic-ref>` to include phase membership on every row,
**So that** I can filter, group, or roll up children by phase without re-parsing the epic body.

**Acceptance Criteria**:
- [ ] Each row in the JSON envelope's `rows` array includes a `phase` field (e.g. `"phase": "p1"`) populated from `ParsedPhase.token`.
- [ ] Rows for refs under no phase have `phase: null`.
- [ ] A ref that appears under multiple phase headings emits one row per (ref × phase) membership, each with the corresponding phase token; total row count may exceed `allRefs.length`.
- [ ] Row order in the JSON envelope matches phase body order across phases, then `ParsedPhase.refs` body order within each phase; the trailing `phase: null` group (if any) is last.
- [ ] The envelope shape stays backward-compatible: existing fields on each row are unchanged; consumers that don't read `phase` continue to work.

### US3: Repro case validates the fix

**As a** reviewer verifying this fix,
**I want** the `christrudelpw/sniplink#1` repro (three phases, 12 children) to produce a table with three phase-labelled groups plus (optionally) a trailing "no phase" group,
**So that** I can confirm the fix works end-to-end against a real epic before merging.

**Acceptance Criteria**:
- [ ] `generacy cockpit status christrudelpw/sniplink#1` prints three phase-headed groups (P1, P2, P3), each containing that phase's children.
- [ ] Total row count matches the count of unique refs (12 children + the epic issue itself, if it appears in `allRefs`).
- [ ] `--json` output for the same repro carries `phase` on every row.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `status.ts` MUST consume `resolved.parsed.phases` (not just `resolved.parsed.allRefs`) when building the output. | P1 | Data is already in the object returned by `resolveEpic`; no new call needed. |
| FR-002 | The rendered (non-JSON) table MUST group rows under phase headings, one group per `ParsedPhase`, in body order. | P1 | Grouped output preferred over a PHASE column since it mirrors the epic body's `### <phase>` structure. |
| FR-003 | Each phase group header MUST render the full `ParsedPhase.heading` text (e.g. `— P1 — Foundation —`), falling back to just the token (e.g. `— P1 —`) only when the parsed heading equals the token (label-less phase). | P1 | Format decided in clarify Q1 = B. Must render legibly with and without color/TTY. |
| FR-004 | Refs present in `allRefs` but not in any phase MUST render in a single trailing implicit group with header `— (no phase) —`. | P2 | Header text decided in clarify Q4 = B (consistent label everywhere). |
| FR-005 | The `--json` envelope MUST include a `phase` field on every row, populated from `ParsedPhase.token`. Refs under no phase MUST use `null`. A ref appearing under multiple phases MUST emit one row per membership (see FR-006); row count MAY exceed `allRefs.length`. | P1 | Additive, backward-compatible schema change. |
| FR-006 | A ref appearing under multiple `### <phase>` headings MUST render once per phase group in the table AND emit one row per (ref × phase) membership in `--json` (each with a single-string `phase` token). This mirrors `queue <phase>` semantics from #806 Q2 (per-heading membership). | P2 | Decided in clarify Q3 = A. Distinct-issue count is the deduped `allRefs.length`; row count MAY exceed it. |
| FR-007 | Fetching, PR/checks rollup, and per-row content of the table MUST remain unchanged; only the row-grouping and JSON row schema change. | P1 | Keep this fix tightly scoped to the grouping bug. |
| FR-008 | If the epic body has zero phases (all refs implicit), status MUST render a single group with header `— (no phase) —` (matching FR-004's trailing group header). | P2 | Decided in clarify Q4 = B. The epic-identity line above the table keeps the epic ref visible; header text is consistent everywhere. |
| FR-009 | Row order within any phase group MUST match `ParsedPhase.refs` body order (as parsed) — no re-sort by `(repo, number)` or otherwise. Applies to both the table and `--json`. | P1 | Decided in clarify Q2 = A. JSON consumers who want a different sort can re-sort. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Phase grouping visible in status output | `generacy cockpit status christrudelpw/sniplink#1` prints ≥3 distinct phase-headed groups matching the epic body's phase headings | Manual run against the repro epic; visual inspection of stdout |
| SC-002 | JSON schema carries phase | 100% of rows in `--json` output for the repro epic have a `phase` field (string or `null`) | Pipe `--json` output through `jq '.rows[] \| has("phase")' \| sort -u` — must equal `[true]` |
| SC-003 | No regression to existing fields | All existing row fields (repo, number, state, labels, PR, checks, title, url, kind) preserved and unchanged for the repro epic | Diff `--json` output pre-/post-fix, ignoring the new `phase` field; row bodies must match |
| SC-004 | Phase-less epic doesn't crash | Running status against an epic with zero `### <phase>` headings prints something legible and exits 0 | Manual run against a phase-less epic (or unit test in the render layer) |

## Assumptions

- `resolveEpic` already returns `parsed.phases` reliably today; this fix consumes existing data rather than adding new parsing.
- The epic body's phase headings use the `### <token> [— <label>]` convention the parser already handles (`packages/cockpit/src/resolver/parse-epic-body.ts`); no changes to the parser are in scope.
- Non-TTY / `--json` consumers won't be broken by adding an optional `phase` field to each row.
- No existing tests assert the "single flat group" behavior in a way that would be difficult to migrate; if they do, they get updated as part of this change.

## Out of Scope

- Adding a PHASE **column** to the table (alternative rendering considered in the issue but not selected).
- Changes to how epics are parsed or how `ParsedPhase` is derived.
- Interactive/`watch` mode changes; this issue is scoped to `status` (one-shot).
- Any change to `resolveIssueContext`, `listAllIssues`, `classifyIssue`, `check-rollup`, or PR resolution.
- Sort options / user-facing sort flags — row order is fixed to epic-body order (FR-009); consumers of `--json` re-sort client-side if needed.

## References

- Issue: [#828](https://github.com/generacy-ai/generacy/issues/828)
- Related: cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #5
- Catalog spec: `docs/epic-cockpit-plan.md` (tetrad-development), Command catalog entry for `status`
- Code touched (expected):
  - `packages/generacy/src/cli/commands/cockpit/status.ts` (line ~74: iterate phases, not just allRefs)
  - `packages/generacy/src/cli/commands/cockpit/status/group.ts` (build one RowGroup per phase)
  - `packages/generacy/src/cli/commands/cockpit/status/row.ts` (add `phase` field to `StatusRow`)
  - `packages/generacy/src/cli/commands/cockpit/status/render-table.ts` (JSON envelope carries `phase`)
- Repro: `christrudelpw/sniplink#1` (three `### P1/P2/P3` phases, 12 children)

---

*Generated by speckit*

# Clarifications: cockpit status renders phase grouping for epic children

**Issue**: [#828](https://github.com/generacy-ai/generacy/issues/828)
**Branch**: `828-found-during-cockpit-v1`

---

## Batch 1 — 2026-07-07

### Q1: Phase header format
**Context**: FR-003 says each phase group header must show "at minimum the token (e.g. `P1`), preferably the full heading text (e.g. `— P1 — Foundation —`)". `ParsedPhase` gives us both `token` (lowercased, e.g. `p1`) and `heading` (full trimmed text after `### `, e.g. `P1 — Foundation`). The render layer needs a concrete choice before the plan phase; token-only is terser but the full heading mirrors the epic body more literally.
**Question**: Which format should the phase group header use in the (non-JSON) table?
**Options**:
- A: Token only, uppercased (e.g. `— P1 —`).
- B: Full heading from `ParsedPhase.heading` (e.g. `— P1 — Foundation —`) — falls back to token if heading equals the token.
- C: Full heading unconditionally (e.g. `— P1 — Foundation —` or `— P1 —` if body has no label).

**Answer**: *Pending*

---

### Q2: Row order within a phase group
**Context**: US1 AC says "Row order within a group matches the child order defined in the epic body (or a stable sort — TBD in plan)." `ParsedPhase.refs` is already stored "in first-appearance order; deduped within the phase" — so body order is free. A stable sort (e.g. `(repo, number)`) would be more predictable but loses the developer's intended queue order in the body. This affects both the table and the `--json` output.
**Question**: What sort order should rows use within each phase group?
**Options**:
- A: Body order — preserve `ParsedPhase.refs` order as-parsed. Best for "queue rounds" mental model.
- B: Stable sort by `(repo, number)`. More predictable; loses body ordering.
- C: Body order in the table, `(repo, number)` in `--json` (grouped-view vs machine-readable).

**Answer**: *Pending*

---

### Q3: Cross-phase duplicate policy
**Context**: FR-006 flags that a ref could theoretically appear under multiple `### <phase>` headings. `ParsedEpicBody.allRefs` is a "deduped union across phases", so a duplicated ref appears once in the flat set but N times across `phases[].refs`. This decides both table rendering (render row N times vs once) and the `--json` row schema (single `phase: string` vs array `phases: string[]`). This is called "unlikely" in the spec but must be pinned so the JSON contract in FR-005 is unambiguous.
**Question**: How should a ref appearing under multiple phase headings be handled?
**Options**:
- A: Render the row in every phase group it belongs to; keep `phase` as a single string in JSON, one row per phase membership (row count > `allRefs.length`).
- B: Render once under the first phase it appears in (body order); `phase` in JSON is the first phase's token. Warn to stderr on collision.
- C: Render once with `phases: string[]` in JSON (schema change beyond a nullable string) and pick the first phase group in the table.

**Answer**: *Pending*

---

### Q4: Phase-less epic fallback header
**Context**: FR-008 says a phase-less epic must not crash and must fall back to today's single-group behavior, but the header text is TBD: either the existing `epic <owner/repo>#<n>` label or the new `— (no phase) —` label used for the trailing implicit group. Consistency vs backward-compatibility trade-off. Same decision applies to the "single trailing implicit group" header (FR-004).
**Question**: For a phase-less epic (zero `### <phase>` headings), what header should the single group show?
**Options**:
- A: `epic <owner/repo>#<n>` — preserves today's exact output for phase-less epics (no visible regression).
- B: `— (no phase) —` — matches FR-004's trailing implicit group; one consistent "no phase" label everywhere.
- C: `epic <owner/repo>#<n> — (no phase)` — hybrid, keeps the epic identity + signals the phase-less state.

**Answer**: *Pending*

# Clarifications: Delete Cockpit Dark Subsystems (#805)

## Batch 1 — 2026-07-02T21:40:00Z

### Q1: Fate of STALE column and stuck fields in status/watch output
**Context**: Journal liveness feeds more output surface than the spec lists. `cockpit status` renders a STALE column (`packages/generacy/src/cli/commands/cockpit/status/render-table.ts:26`), and its `--json` rows carry `stuck`/`stuckReason` fields (`status/row.ts:14-15`); `watch`'s `IssueSnapshot` carries the same fields (`watch/snapshot.ts:17-18`). Once `readJournalLiveness` is deleted (FR-002/FR-005), `stuck` is permanently `false` — the column can never show STALE. The spec (US2, FR-005, FR-008) removes the liveness call sites but is silent on this rendering/JSON surface. The related public exports `StuckReason`, `JournalLivenessResult`, and `ReadJournalLivenessOptions` in `packages/cockpit/src/types.ts` are also unmentioned. The answer decides deletion scope in `render-table.ts`, `row.ts`, `color.ts`, `snapshot.ts`, `diff.ts`, the `--json` output contract, and which tests get trimmed (`status.render.test.ts` stuck-column tests, `watch.diff.test.ts` stuck/recovered tests — neither is in US1's test-file list).
**Question**: After deleting journal liveness, should the now-dead `stuck` output surface be removed entirely, or kept as an always-false placeholder for output-shape stability?
**Options**:
- A: Remove entirely — drop the STALE column from the status table; remove `stuck`/`stuckReason` from `StatusRow`, status `--json` rows, and `IssueSnapshot`; delete the `StuckReason`/`JournalLivenessResult`/`ReadJournalLivenessOptions` exports from `@generacy-ai/cockpit` (consistent with US2's "only show data the tool can actually produce").
- B: Keep the output shape — retain the column/fields hardcoded to `false`/`null` so `--json` consumers see an unchanged row shape; keep `StuckReason` exported.

**Answer**: *Pending*

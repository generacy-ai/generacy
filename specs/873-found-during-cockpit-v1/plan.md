# Implementation Plan: Closed-issue dominance in cockpit `watch` + `status` classifier

**Feature**: Fix the label-only cockpit classifier that keeps flagging closed-and-merged children as actionable merge candidates on every fresh watch (spec `#873`).
**Branch**: `873-found-during-cockpit-v1`
**Status**: Complete
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md) (Q1 → A ✓ green in-place · Q2 → A raw `issueState` · Q3 → C shared `isDoneSnapshot` helper · Q4 → B distinguish `NOT_PLANNED` text)

## Summary

Live cockpit v1 smoke test (`generacy-ai/tetrad-development#88`, finding #32): `/cockpit:watch 1` on the sniplink epic reported children #2 and #3 as `terminal, completed:validate … suggested: /cockpit:merge` after their PRs had already been squash-merged and their issues closed. Root cause is a single-line classifier omission — `isActionableSnapshot()` in `packages/generacy/src/cli/commands/cockpit/watch/actionable.ts` scans `snap.labels[]` for `completed:validate` (and other actionable tokens) with no gate on `snap.state`. Closed issues keep their label residue forever, so every startup sweep replays them as actionable.

Four coordinated changes (per Q1-Q4) close it:

1. **FR-007 / Q3-C**: Extract `isDoneSnapshot(snap)` into `packages/generacy/src/cli/commands/cockpit/shared/is-done-snapshot.ts`. The invariant *"issue `state: closed` dominates any label-derived actionability tier"* lives in that helper's JSDoc — the single grep target for future refactors. Q3-A ("comment at guard sites") comes free because the helper *is* the guard.
2. **FR-005 / Q1-A + Q4-B**: `IssueSnapshot` (and `PrSnapshot`, for symmetry) gain optional `stateReason?: 'COMPLETED' | 'NOT_PLANNED' | null`. `Issue` (`packages/cockpit/src/gh/wrapper.ts`) gains the same field; `listIssues` and `getIssue` extend `--json` to include `stateReason`; `IssueRawSchema` accepts it. `NOT_PLANNED` is preserved through the snapshot layer so status can render `✗ closed (not planned)` distinctly from `✓ merged/closed`.
3. **FR-002 / FR-003**: `isActionableSnapshot()` short-circuits to `false` when `isDoneSnapshot(snap)` returns `true`. `computeInitialSweep()` (`watch/diff.ts`) filters through this same predicate — closed rows produce no startup-sweep line, no suggestion. The existing live open→closed transition in `diffIssue()` (line 82) already emits exactly one `issue-closed` event with `to: 'terminal'`; no change needed — it is the "one terminal done line" spec expects and it carries no per-emit suggestion payload (downstream skills key off the event kind, not label residue).
4. **FR-004 / Q1-A + Q2-A + Q4-B**: `StatusRow` gains raw `issueState: 'OPEN' | 'CLOSED'` and `stateReason: 'COMPLETED' | 'NOT_PLANNED' | null`. `buildStatusRow()` populates them from the `Issue` fed in by `runStatus()`. `render-table.ts::fmtRow()` inspects `issueState === 'CLOSED'` and swaps state+sourceLabel columns for one of `✓ merged/closed` (green) or `✗ closed (not planned)` (dim red), keeping the row inside its phase group (Q1-A rejects the "Done sub-section" of Q1-C). `renderJsonEnvelope` surfaces both fields verbatim on each row — SC-002's machine-readable signal for downstream consumers.

The shared helper is the single gate: both watch and status funnel through `isDoneSnapshot(snap)` for the actionability decision, and both surface `stateReason` for the render/JSON decision. Grep audit for the invariant is one call site name, not a scattered pattern.

## Technical Context

**Language/Version**: TypeScript 5.x, Node ≥22 (ESM, matches existing packages).
**Primary Dependencies**:
- `@generacy-ai/cockpit` — `Issue`, `IssueRawSchema`, `GhCliWrapper.listIssues/getIssue` (extending `--json` list + type).
- `@generacy-ai/generacy` (in-tree) — `packages/generacy/src/cli/commands/cockpit/{watch,status,shared}/*`.
- `zod` — extend `IssueRawSchema` with optional `stateReason`.
- No new runtime deps. `chalk` is already present in `status/color.ts` for the green/red rendering.
**Storage**: None. Pure classifier + renderer changes over the ephemeral `SnapshotMap` / `StatusRow[]` arrays. `gh` query gains one field per row.
**Testing**: `vitest` (workspace-standard). Extend the existing `packages/generacy/src/cli/commands/cockpit/__tests__/watch.actionable.test.ts`, `watch.diff.test.ts`, `status.render.test.ts`, `status.color.test.ts`. New co-located `is-done-snapshot.test.ts` for the shared helper.
**Target Platform**: Linux (CLI runs on operator laptop + inside the orchestrator container; no platform-specific paths).
**Project Type**: Monorepo. Two packages touched: `packages/cockpit` (type + gh wrapper) and `packages/generacy` (classifier, snapshot, status renderer). No cross-repo work.
**Performance Goals**: Zero extra `gh` round trips. `stateReason` is a JSON field on the existing `gh search issues` / `gh issue view` call. Predicate work is O(1) per snapshot.
**Constraints**:
- `isDoneSnapshot` MUST be the single decision surface. No inline `snap.state === 'CLOSED'` checks in `watch/diff.ts`, `watch/actionable.ts`, `status/row.ts`, or `status/render-table.ts` (SC-005 grep audit).
- Q1-A forbids moving closed rows into a `— Done —` sub-section (spec text) — closed rows stay under their phase header.
- Q2-A forbids a `done: boolean` derived flag on `StatusRow` alongside `issueState` (drift surface).
- Q4-B forbids identical text for `NOT_PLANNED` and `COMPLETED` closures — text differs, actionability is identical.
- No expansion of the `CockpitState` enum (Q2-C rejected — conflates GitHub issue state with cockpit label tiers).
**Scale/Scope**: Single-repo epic (sniplink #1 with 3 children) is the reproducer. Fleet scale bounded by epic child count; no new O(children) work introduced.

## Constitution Check

`.specify/memory/constitution.md` does not exist in this repo. No constitutional gates to check.

**Pre-Phase 0 gates (from repo conventions)**:
- **Single decision surface for the invariant**: PASS — `isDoneSnapshot()` is the one call site (SC-005). Q3-C explicitly demands this.
- **No new state stores**: PASS — pure predicate + type extension. `SnapshotMap` and `StatusRow[]` shapes gain fields, not new stores.
- **No new packages / new directories**: PASS — one new file under `packages/generacy/src/cli/commands/cockpit/shared/` (existing dir).
- **Forward-compatible with existing consumers**: PASS — additive schema change on `Issue.stateReason` (optional field), additive on `StatusRow.issueState` + `StatusRow.stateReason`. Existing NDJSON `CockpitEvent` shape unchanged (Q4-B's text distinction lives in the render layer, not the event stream).

**Post-Phase 1 re-check**: no violations introduced by the design in `data-model.md`. The predicate stays pure (label residue + `issueState`), the render layer stays a pure function of `StatusRow`, and the `gh` schema change is a single optional field.

## Project Structure

### Documentation (this feature)

```text
specs/873-found-during-cockpit-v1/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── is-done-snapshot.md          # Shared predicate contract + invariant JSDoc source
│   └── status-envelope.md           # StatusRow + renderJsonEnvelope field additions
├── spec.md              # (read-only)
├── clarifications.md    # (read-only)
└── tasks.md             # /speckit:tasks output — NOT created here
```

### Source Code (repository root)

```text
packages/cockpit/src/
├── gh/
│   ├── wrapper.ts                      # MODIFIED: Issue.stateReason?; listIssues + getIssue --json extension; IssueRawSchema accepts stateReason
│   └── __tests__/gh-wrapper.test.ts    # MODIFIED: assert stateReason flows through parse
└── types.ts                            # UNCHANGED — CockpitState enum stays intact (Q2-C explicitly rejected)

packages/generacy/src/cli/commands/cockpit/
├── shared/
│   ├── is-done-snapshot.ts             # NEW: isDoneSnapshot(snap) — the single invariant carrier
│   └── __tests__/
│       └── is-done-snapshot.test.ts    # NEW: unit tests for open, closed-completed, closed-not-planned, both kinds
├── watch/
│   ├── snapshot.ts                     # MODIFIED: IssueSnapshot.stateReason?; PrSnapshot.stateReason?; buildIssueSnapshot/buildPrSnapshot pass through
│   ├── actionable.ts                   # MODIFIED: isActionableSnapshot short-circuits via isDoneSnapshot
│   └── diff.ts                         # MODIFIED: computeInitialSweep filters via isActionableSnapshot (already indirect) — no direct change needed once actionable.ts flips; diffIssue open→closed path unchanged
├── status/
│   ├── row.ts                          # MODIFIED: StatusRow.issueState + StatusRow.stateReason; buildStatusRow signature accepts Issue.state + Issue.stateReason
│   ├── render-table.ts                 # MODIFIED: fmtRow branches on issueState; closed rows render ✓ merged/closed or ✗ closed (not planned)
│   ├── color.ts                        # MODIFIED: add `done` colorizer field (green) + reuse existing dim/red palette
│   └── group.ts                        # UNCHANGED — closed rows stay under their phase header per Q1-A (rejects Q1-C sub-section)
├── status.ts                           # MODIFIED: threads issue.stateReason into buildStatusRow
├── __tests__/
│   ├── watch.actionable.test.ts        # MODIFIED: closed + completed:validate → not actionable; open + completed:validate → actionable (unchanged case)
│   ├── watch.diff.test.ts              # MODIFIED: closed startup sweep silent; live open→closed emits one issue-closed
│   ├── status.render.test.ts           # MODIFIED: closed-completed row renders "✓ merged/closed"; closed-not-planned row renders "✗ closed (not planned)"
│   ├── status.color.test.ts            # MODIFIED: closed-completed → green; closed-not-planned → dim red
│   └── status.json.test.ts             # NEW (or extend existing status.render): envelope carries issueState + stateReason
```

**Structure Decision**: Existing monorepo layout, one new file (the shared helper) and per-file surgery elsewhere. No new directories, no new packages.

**Cross-repo scope note**: entirely in-tree in the `generacy` repo. Two packages touched (`@generacy-ai/cockpit` and `@generacy-ai/generacy`), both already worked in the same commit surface. No cockpit-web, cluster-base, generacy-cloud, or workflow-engine work required. The cockpit-watch operator skill (which composes the "suggested: /cockpit:merge" line externally from the NDJSON event stream) is unaffected — once `computeInitialSweep` stops emitting for closed snapshots, that skill has nothing to hang a suggestion off.

## Complexity Tracking

No constitutional violations. No table to fill.

**Non-obvious design decisions (documented for future readers)**:

| Decision | Alternative rejected | Reason |
|----------|---------------------|--------|
| Shared `isDoneSnapshot(snap)` helper is the single invariant carrier | Inline `snap.state === 'CLOSED'` gate at each call site (Q3-A) | Q3-C explicitly picks the shared helper: the invariant lives in one JSDoc, one grep target, one refactor-resistant surface. Inline gates rot the moment someone adds a fourth actionability tier. |
| `StatusRow.issueState: 'OPEN' \| 'CLOSED'` raw, no derived `done` bool | Add `done: boolean` alongside (Q2-D) or replace with derived (Q2-B) | Q2-A: raw mirrors the snapshot type, bakes in no interpretation, `done = issueState === 'CLOSED'` is a one-expression consumer derivation. Two fields with an invariant between them is a drift surface for zero gain. |
| `NOT_PLANNED` text distinguished from `COMPLETED` in the render layer only | Distinguish machine-readable signal only (Q4-C); collapse to identical text (Q4-A) | Q4-B: a `✓` on abandoned scope misreports epic progress. Operator reading `status` output must not see cut work as delivered work. Actionability stays identical (both are done, no suggestions); only pixels differ. |
| Closed rows stay under their phase header | Move all closed rows to a dedicated `— Done —` sub-section (Q1-C) | Q1-A: keeping done rows under their phase header is what makes `status` read as epic progress (`P1: 3/3 ✓`). A sub-section fragments the phase view. |
| No `CockpitState` enum expansion (`closed-done`) | Add `'closed-done'` value to the shared enum (Q2-C) | Q2-C conflates GitHub issue state (a data-plane fact) with the cockpit's label-derived actionability tiers (a classification). The classifier's job is exactly to *not* have GitHub state leak into label tiers — the enum stays a label-tier vocabulary. |
| `isDoneSnapshot` reads `snap.state`, not `snap.classified.state` | Read `classified.state === 'terminal'` | The `terminal` label-tier is exactly the residue this fix stops trusting: `completed:validate` classifies to `terminal` regardless of open/closed. `snap.state` is the ground-truth data-plane signal. |
| `computeInitialSweep` gate stays on `isActionableSnapshot` (indirect) | Add explicit `isDoneSnapshot` gate before `isActionableSnapshot` in `computeInitialSweep` | The predicate short-circuit already covers it. Two gates is two places to keep in sync. The single-line `if (!isActionableSnapshot(snap)) continue;` at `diff.ts:132` is the only sweep guard — flipping the inner predicate propagates. |

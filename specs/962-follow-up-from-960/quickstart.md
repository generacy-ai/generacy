# Quickstart: verifying the #962 content guard

Local verification of the `findClarificationComment` content guard. All commands assume the repo root at `/workspaces/generacy`.

## Prerequisites

- Node ≥22.
- `pnpm install` already run in the repo root.
- Branch `962-follow-up-from-960` checked out.

## Run the finder's regression tests

```bash
pnpm --filter @generacy-ai/generacy test clarification-comment-finder
```

Expected after the finder change:

- All 4 pre-existing tests pass (existing happy-path selection, at-or-after null, no-timeline-event null, most-recent-label-wins).
- All 6 new tests pass:
  - FR-006: single stage-status planning table → `null` (SC-001 pin).
  - FR-007: single `clarification-batch-1` marker → returned.
  - FR-008: `[stage-status, clarification-batch-1]` in `createdAt` order → returns the second.
  - FR-003: mixed body (planning + clarification-batch-2) → returned (override wins).
  - FR-002 legacy: single `speckit-stage:implementation` table → `null`.
  - D7: quoted `> <!-- generacy-stage:planning -->` → returned (column-0 rule).

## Prove the FR-006 regression pin (SC-001)

The FR-006 case MUST fail on the pre-guard finder and pass on the guarded finder. To demonstrate:

```bash
# 1. Check out the pre-guard version of the finder.
git stash --keep-index                # stash unstaged edits
git checkout HEAD~1 -- packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts

# 2. Run only the FR-006 test.
pnpm --filter @generacy-ai/generacy test clarification-comment-finder -- -t 'FR-006'

# Expected: RED — the pre-guard finder returns the planning table instead of null.

# 3. Restore the guarded finder.
git checkout HEAD -- packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts
git stash pop

# 4. Re-run.
pnpm --filter @generacy-ai/generacy test clarification-comment-finder -- -t 'FR-006'

# Expected: GREEN.
```

## Type-check + lint

```bash
pnpm --filter @generacy-ai/generacy typecheck
pnpm --filter @generacy-ai/generacy lint
```

Expected: no new errors. The guard adds two module-scope `readonly string[]` constants and one private function — all fully-typed with the finder's existing conventions.

## Verify SC-003 (no files changed outside the finder + its test)

```bash
git diff --stat origin/develop...HEAD -- packages/ .changeset/
```

Expected diff, exactly:

```
 .changeset/962-clarification-finder-content-guard.md                                          | X +
 packages/generacy/src/cli/commands/cockpit/__tests__/clarification-comment-finder.test.ts    | +NN -N
 packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts                   | +NN -N
```

Any other file under `packages/` in the diff violates SC-003.

## Verify the changeset

```bash
cat .changeset/962-clarification-finder-content-guard.md
```

Expected header:

```markdown
---
'@generacy-ai/generacy': patch
---
```

Then a one-line summary. `patch` bump is correct: defect fix, no new public capability, no new export.

## Confirm nothing else moved

Grep for any accidental cross-package import in the finder:

```bash
grep -n "clarification-markers" packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts
```

Expected: no output. Q1/B requires the guard to hardcode the marker lists locally; if this grep matches, the change breaks SC-003.

## Troubleshooting

**"FR-006 is green even before I changed the finder."**
Confirm you stashed correctly and the finder file matches `HEAD~1`. `git diff HEAD~1 -- packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts` should show no changes.

**"FR-003 mixed-body test fails — override does not win."**
The `isStageStatusComment` helper's override loop MUST run before the reject loop. If the two loops are collapsed into a single pass that returns `true` on the first reject-hit, the mixed-body test fails when the reject marker is on an earlier line than the override.

**"D7 quoted-marker test fails — a `> `-prefixed marker triggers the guard."**
The guard uses `body.split('\n')` and `line.startsWith(prefix)`. If the implementation uses `body.includes(prefix)` or a regex without `^` anchoring, the column-0 rule breaks. Mirror `commentCarriesQuestionMarker`'s implementation exactly.

**"SC-003 grep shows a change to `packages/orchestrator/...`."**
The finder MUST NOT import from `packages/orchestrator/src/worker/clarification-markers.ts`. Verify the two constant arrays are declared locally in `clarification-comment-finder.ts`.

**"Legacy `speckit-stage:*` test fails."**
Verify all six FR-002 prefixes are present in `STAGE_STATUS_REJECT_PREFIXES` (three `generacy-stage:*` + three `speckit-stage:*`). Missing legacy entries silently fail the parity coverage.

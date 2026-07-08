# Contract: Merge-Conflict Evidence Block

**Companion to**: `specs/847-found-during-cockpit-v1/contracts/failure-evidence-block.md`
**Modifies**: `packages/orchestrator/src/worker/types.ts` (`StageCommentData.errorEvidence`), `packages/orchestrator/src/worker/stage-comment-manager.ts` (`renderStageComment` + `appendEvidenceBlock`).

## Motivation (FR-010)

Operators must tell "merge conflict during pre-phase base-sync" apart from "validate command exited non-zero" at a glance in the rendered stage comment. Reusing #847's `command`/`exitDescriptor`/`stderrTail` block for the conflict case would bury the conflicted-paths list inside `stderrTail`, defeating the requirement.

## Discriminated union

`errorEvidence` becomes a discriminated union. Exactly one variant per stage-comment update.

```
errorEvidence:
  Variant A (existing, #847):  { command, exitDescriptor, stderrTail }
  Variant B (new, this):       { mergeConflict: { baseRef, conflictedPaths } }
```

The renderer branches on the presence of `.mergeConflict`. Absent → render variant A (existing behavior, byte-for-byte unchanged from #847).

## Byte layout (variant B)

Placed after the summary metadata below a horizontal-rule separator, matching #847's placement pattern. Invariant: bytes above the `---` are the same as any other error-status stage comment.

```
---
**Merge conflict during base-sync**
**Base**: `origin/<base>`

<details><summary>Conflicted paths (N)</summary>

- `path/one`
- `path/two`
- `path/three`

</details>
```

Rendering rules:
- Path list is bulleted, one per line, in the order returned by `git diff --name-only --diff-filter=U` (git's natural order).
- Backtick-safe: any backticks inside a path are escaped with a ZWSP the same way #847 handles `stderrTail`.
- Empty `conflictedPaths` renders `- (no paths reported — merge failed for a non-conflict reason)` and the header count is `0`. (Should not happen in practice — the runner guarantees at least a placeholder entry.)

## Renderer test expectations

- SC-004 assertion: the string `**Merge conflict during base-sync**` appears in the rendered comment for every merge-conflict pause. This is the single canonical marker `cockpit status` can grep for.
- Byte layout above the `---` is unchanged from the #847 renderer output for identical `StageCommentData` sans `errorEvidence` — no regression to existing stage-comment consumers.

## Non-goals

- Machine-readable structure (JSON block, hidden HTML comment, etc.) — deferred to a follow-up. `cockpit status` reads the pause via labels (`waiting-for:merge-conflicts`), not the comment body.

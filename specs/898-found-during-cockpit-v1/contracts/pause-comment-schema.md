# Contract: Ship 1 pause-comment content

**Files touched**:
- `packages/orchestrator/src/worker/phase-loop.ts:929-941` (call site)
- `packages/orchestrator/src/worker/merge-conflict-remedy.ts` (new — the template constant)
- `packages/orchestrator/src/worker/stage-comment-manager.ts` (rendering)
- `packages/workflow-engine/src/actions/github/label-definitions.ts:43` (label description)

## Rendered comment content

When `#864`'s pre-phase base-merge detects a conflict and the pause path fires, the stage comment on the issue MUST include a `## Merge conflict` section with the following structure (Markdown source):

```markdown
## ⚠️ Merge conflict on base-merge

Conflicted paths:
- `<path-1>`
- `<path-2>`
- ...

### To resolve manually:

1. Check out `<branch>`, merge `origin/<base>`, resolve conflicts, commit, push.
2. Run `generacy cockpit advance <owner>/<repo>#<issue> --gate merge-conflicts`.
3. Phase re-runs; pre-merge now succeeds; phase proceeds.

> **Advancing without resolving first will re-pause with the same conflict.**
```

Substitutions:

| Placeholder | Source | Notes |
|-------------|--------|-------|
| `<path-N>` | `mergeResult.conflictedPaths` (`base-merge.ts:27`) | One bullet per path. Escape backticks in path names (unlikely in practice). |
| `<branch>` | `context.branch` in `phase-loop.ts` | Feature branch name. |
| `<base>` | `mergeResult.baseRef.replace(/^origin\//, '')` | Bare base branch name for the checkout instruction. |
| `<owner>/<repo>#<issue>` | `context.item.owner/repo/issueNumber` | Verbatim issue-ref for the cockpit command. |

## Payload shape

`errorEvidence.mergeConflict` (extended from `#864`'s existing shape):

```ts
{
  baseRef: string;                    // e.g., "origin/develop"
  conflictedPaths: string[];          // from mergeResult
  manualRemedy: {
    steps: string[];                  // 3 strings, template-substituted at build time
    warning: string;                  // callout copy
  };
}
```

**Where the substitution happens**: in `phase-loop.ts` at the pre-existing call site (`:929`). The `MERGE_CONFLICT_REMEDY` constant from `merge-conflict-remedy.ts` is the template; `phase-loop.ts` substitutes `<branch>`, `<base>`, `<owner>/<repo>#<issue>` before passing the payload to `stageCommentManager.updateStageComment`. This keeps the renderer content-agnostic.

## Renderer change

`StageCommentManager` (existing) gets a small render extension: when `errorEvidence.mergeConflict.manualRemedy` is present, render the section shown above under the existing `mergeConflict` block. When absent (pre-Ship-1 payloads, or non-merge-conflict `errorEvidence` variants), render as today.

Backwards compatibility: `manualRemedy` is a new optional sub-field. Any code path emitting `errorEvidence.mergeConflict` without `manualRemedy` continues to work; the renderer simply omits the remedy section.

**Note**: post-Ship-1 the phase-loop pause site always sets `manualRemedy`. The optionality is for stage-comment reads from historical evidence blobs (queue admin views, cockpit `status`).

## Label description update (FR-013)

`label-definitions.ts:43` current:

```ts
{ name: 'waiting-for:merge-conflicts', color: 'FBCA04', description: 'Waiting for base-merge conflict resolution' },
```

Ship 1 replacement:

```ts
{
  name: 'waiting-for:merge-conflicts',
  color: 'FBCA04',
  description: 'Base-merge conflict on this issue. See stage comment for the three-step manual remedy (resolve on branch, push, then cockpit advance).',
},
```

100-char GitHub API limit: the string above is 132 chars — GitHub truncates at 100. Fallback (shorter, within limit):

```ts
description: 'Base-merge conflict. See stage comment for the manual remedy.',   // 62 chars
```

**Decision**: use the shorter form. The stage comment is the load-bearing remedy carrier — the label description is a pointer.

## Test assertions

`packages/orchestrator/src/worker/__tests__/phase-loop.merge.test.ts` (existing test at line 177 — extend):

- Assert `errorEvidence.mergeConflict.manualRemedy` present in the `updateStageComment` call.
- Assert `manualRemedy.steps` has length 3.
- Assert `manualRemedy.steps[1]` contains the exact substring `generacy cockpit advance` and `--gate merge-conflicts`.
- Assert `manualRemedy.warning` contains the substring `re-pause`.
- Assert `conflictedPaths` present and matches `mergeResult.conflictedPaths`.

A companion test at `merge-conflict-remedy.test.ts` (new, tiny) asserts the module-level template constant matches the literal-string types in `data-model.md`.

## Success criteria mapping

- **SC-004 (100% self-describing pause)**: the assertions above verify the payload; the renderer test verifies the emitted Markdown contains all three numbered steps + the warning callout.
- **SC-005 (advance-without-resolve re-pause names paths)**: no additional Ship-1 code needed — the next pause is a fresh pause via the same code path, which recomputes `conflictedPaths` from the fresh merge attempt. Test extends the fixture to run the pause path twice and asserts the second stage comment contains the same/similar path list.
